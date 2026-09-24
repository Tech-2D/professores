"""Centraliza documentos de dois projetos Firebase em um terceiro projeto.

Este script migra o banco Cloud Firestore (default), preservando caminhos,
IDs, tipos de campos e subcoleções. Ele não migra Firebase Authentication,
Storage, Realtime Database, regras ou índices.

Por segurança, o padrão é apenas simular. Use --execute para gravar.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import firebase_admin
from firebase_admin import credentials, firestore
from google.api_core import exceptions as google_exceptions
from google.api_core.retry import Retry, if_exception_type
from google.cloud.firestore_v1 import DocumentReference


SOURCE_PROJECTS = (
    "procurar-professores-5c04a",
    "agenda-2e1df",
)
DESTINATION_PROJECT = "d-tech-56a76"
DEFAULT_READ_BATCH_SIZE = 100
DEFAULT_WRITE_BATCH_SIZE = 100
DEFAULT_REQUEST_DELAY_MS = 250
DEFAULT_MAX_RETRY_SECONDS = 300

RETRYABLE_FIREBASE_ERRORS = (
    google_exceptions.ResourceExhausted,
    google_exceptions.TooManyRequests,
    google_exceptions.DeadlineExceeded,
    google_exceptions.ServiceUnavailable,
    google_exceptions.InternalServerError,
)


@dataclass(frozen=True)
class DocumentCopy:
    source_project: str
    path: str
    data: dict[str, Any]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Copia todos os documentos do Firestore de dois projetos para d-tech-56a76.",
    )
    parser.add_argument(
        "--source-professores-key",
        type=Path,
        required=True,
        help="JSON da conta de serviço de procurar-professores-5c04a.",
    )
    parser.add_argument(
        "--source-agenda-key",
        type=Path,
        required=True,
        help="JSON da conta de serviço de agenda-2e1df.",
    )
    parser.add_argument(
        "--destination-key",
        type=Path,
        required=True,
        help="JSON da conta de serviço de d-tech-56a76.",
    )
    parser.add_argument(
        "--on-conflict",
        choices=("error", "skip", "overwrite"),
        default="error",
        help="Ação quando o destino já contém o mesmo caminho (padrão: error).",
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Grava no destino. Sem esta opção, apenas exibe o plano.",
    )
    parser.add_argument(
        "--read-batch-size",
        type=positive_int,
        default=DEFAULT_READ_BATCH_SIZE,
        help=f"Documentos por leitura em lote (padrão: {DEFAULT_READ_BATCH_SIZE}).",
    )
    parser.add_argument(
        "--write-batch-size",
        type=positive_int,
        default=DEFAULT_WRITE_BATCH_SIZE,
        help=f"Documentos por lote de escrita (padrão: {DEFAULT_WRITE_BATCH_SIZE}).",
    )
    parser.add_argument(
        "--request-delay-ms",
        type=non_negative_int,
        default=DEFAULT_REQUEST_DELAY_MS,
        help=(
            "Pausa entre lotes para evitar picos de cota "
            f"(padrão: {DEFAULT_REQUEST_DELAY_MS} ms)."
        ),
    )
    parser.add_argument(
        "--max-retry-seconds",
        type=positive_int,
        default=DEFAULT_MAX_RETRY_SECONDS,
        help=(
            "Tempo máximo de novas tentativas com espera progressiva para 429 e falhas "
            f"temporárias (padrão: {DEFAULT_MAX_RETRY_SECONDS} s)."
        ),
    )
    return parser.parse_args()


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("o valor deve ser maior que zero")
    return parsed


def non_negative_int(value: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("o valor não pode ser negativo")
    return parsed


def build_retry(max_retry_seconds: int) -> Retry:
    return Retry(
        predicate=if_exception_type(*RETRYABLE_FIREBASE_ERRORS),
        initial=1.0,
        maximum=30.0,
        multiplier=2.0,
        deadline=float(max_retry_seconds),
    )


def chunks(items: list[Any], size: int) -> Iterable[list[Any]]:
    for offset in range(0, len(items), size):
        yield items[offset : offset + size]


def pause(delay_seconds: float) -> None:
    if delay_seconds > 0:
        time.sleep(delay_seconds)


def read_and_validate_key(path: Path, expected_project: str) -> dict[str, Any]:
    if not path.is_file():
        raise ValueError(f"Arquivo de credenciais não encontrado: {path}")
    try:
        content = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Credencial inválida em {path}: {error}") from error

    actual_project = content.get("project_id")
    if actual_project != expected_project:
        raise ValueError(
            f"A credencial {path} pertence a {actual_project!r}; "
            f"era esperado {expected_project!r}.",
        )
    return content


def create_client(project_id: str, key_path: Path):
    read_and_validate_key(key_path, project_id)
    app = firebase_admin.initialize_app(
        credentials.Certificate(str(key_path)),
        {"projectId": project_id},
        name=f"migration-{project_id}",
    )
    return firestore.client(app=app)


def retarget_references(value: Any, destination_client) -> Any:
    """Faz referências de documentos apontarem para o projeto de destino."""
    if isinstance(value, DocumentReference):
        return destination_client.document(value.path)
    if isinstance(value, Mapping):
        return {key: retarget_references(item, destination_client) for key, item in value.items()}
    if isinstance(value, list):
        return [retarget_references(item, destination_client) for item in value]
    if isinstance(value, tuple):
        return tuple(retarget_references(item, destination_client) for item in value)
    return value


def walk_collection(
    source_client,
    collection,
    source_project: str,
    destination_client,
    read_batch_size: int,
    retry_policy: Retry,
    delay_seconds: float,
) -> Iterable[DocumentCopy]:
    document_refs = list(
        collection.list_documents(page_size=1000, retry=retry_policy, timeout=120),
    )

    for reference_batch in chunks(document_refs, read_batch_size):
        snapshots = source_client.get_all(
            reference_batch,
            retry=retry_policy,
            timeout=120,
        )
        for snapshot in snapshots:
            if snapshot.exists:
                yield DocumentCopy(
                    source_project=source_project,
                    path=snapshot.reference.path,
                    data=retarget_references(snapshot.to_dict() or {}, destination_client),
                )
        pause(delay_seconds)

    # Também percorre documentos-pai sem campos, pois eles podem conter subcoleções.
    for document_ref in document_refs:
        subcollections = document_ref.collections(
            page_size=1000,
            retry=retry_policy,
            timeout=120,
        )
        for subcollection in subcollections:
            yield from walk_collection(
                source_client,
                subcollection,
                source_project,
                destination_client,
                read_batch_size,
                retry_policy,
                delay_seconds,
            )


def collect_documents(
    source_client,
    source_project: str,
    destination_client,
    read_batch_size: int,
    retry_policy: Retry,
    delay_seconds: float,
) -> list[DocumentCopy]:
    documents: list[DocumentCopy] = []
    collections = sorted(
        source_client.collections(retry=retry_policy, timeout=120),
        key=lambda item: item.id,
    )
    print(f"\n[{source_project}] coleções encontradas: {', '.join(item.id for item in collections) or '(nenhuma)'}")
    for collection in collections:
        before = len(documents)
        documents.extend(
            walk_collection(
                source_client,
                collection,
                source_project,
                destination_client,
                read_batch_size,
                retry_policy,
                delay_seconds,
            ),
        )
        print(f"  - {collection.id}: {len(documents) - before} documento(s), incluindo subcoleções")
    return documents


def classify_documents(
    documents: list[DocumentCopy],
    destination_client,
    conflict_policy: str,
    read_batch_size: int,
    retry_policy: Retry,
    delay_seconds: float,
) -> tuple[list[DocumentCopy], int]:
    by_path: dict[str, DocumentCopy] = {}
    source_conflicts: list[str] = []
    source_documents_replaced = 0
    for document in documents:
        previous = by_path.get(document.path)
        if previous is not None:
            source_documents_replaced += 1
            source_conflicts.append(
                f"{document.path} ({previous.source_project} e {document.source_project})",
            )
            if conflict_policy == "skip":
                continue
        by_path[document.path] = document

    if source_conflicts and conflict_policy == "error":
        sample = "\n  - ".join(source_conflicts[:20])
        raise RuntimeError(f"Conflitos entre as origens:\n  - {sample}")

    unique_documents = list(by_path.values())
    destination_paths: set[str] = set()
    for document_batch in chunks(unique_documents, read_batch_size):
        references = [destination_client.document(document.path) for document in document_batch]
        snapshots = destination_client.get_all(
            references,
            field_paths=[],
            retry=retry_policy,
            timeout=120,
        )
        destination_paths.update(
            snapshot.reference.path for snapshot in snapshots if snapshot.exists
        )
        pause(delay_seconds)

    pending: list[DocumentCopy] = []
    destination_conflicts: list[str] = []
    skipped = 0
    for document in unique_documents:
        if document.path in destination_paths:
            destination_conflicts.append(document.path)
            if conflict_policy == "skip":
                skipped += 1
                continue
        pending.append(document)

    if destination_conflicts and conflict_policy == "error":
        sample = "\n  - ".join(destination_conflicts[:20])
        extra = len(destination_conflicts) - min(len(destination_conflicts), 20)
        suffix = f"\n  ... e mais {extra}" if extra else ""
        raise RuntimeError(
            "O destino já contém documentos com os mesmos caminhos:\n"
            f"  - {sample}{suffix}\n"
            "Use --on-conflict skip ou --on-conflict overwrite conscientemente.",
        )
    return pending, skipped + source_documents_replaced


def write_documents(
    documents: list[DocumentCopy],
    destination_client,
    write_batch_size: int,
    retry_policy: Retry,
    delay_seconds: float,
) -> None:
    total = len(documents)
    for offset in range(0, total, write_batch_size):
        batch = destination_client.batch()
        chunk = documents[offset : offset + write_batch_size]
        for document in chunk:
            batch.set(destination_client.document(document.path), document.data)
        batch.commit(retry=retry_policy, timeout=120)
        print(f"Gravados {offset + len(chunk)} de {total} documento(s).")
        pause(delay_seconds)


def main() -> int:
    args = parse_args()
    key_paths = {
        "procurar-professores-5c04a": args.source_professores_key,
        "agenda-2e1df": args.source_agenda_key,
        DESTINATION_PROJECT: args.destination_key,
    }

    try:
        retry_policy = build_retry(args.max_retry_seconds)
        delay_seconds = args.request_delay_ms / 1000
        destination_client = create_client(DESTINATION_PROJECT, key_paths[DESTINATION_PROJECT])
        source_clients = {
            project: create_client(project, key_paths[project])
            for project in SOURCE_PROJECTS
        }

        documents: list[DocumentCopy] = []
        for project in SOURCE_PROJECTS:
            documents.extend(
                collect_documents(
                    source_clients[project],
                    project,
                    destination_client,
                    args.read_batch_size,
                    retry_policy,
                    delay_seconds,
                ),
            )

        pending, skipped = classify_documents(
            documents,
            destination_client,
            args.on_conflict,
            args.read_batch_size,
            retry_policy,
            delay_seconds,
        )
        print("\nResumo")
        print(f"  Encontrados nas origens: {len(documents)}")
        print(f"  Serão gravados no destino: {len(pending)}")
        print(f"  Ignorados por conflito: {skipped}")
        print(f"  Política de conflito: {args.on_conflict}")

        if not args.execute:
            print("\nSIMULAÇÃO: nenhuma gravação foi feita. Use --execute para confirmar a migração.")
            return 0

        if not pending:
            print("\nNada para gravar.")
            return 0
        write_documents(
            pending,
            destination_client,
            args.write_batch_size,
            retry_policy,
            delay_seconds,
        )
        print(f"\nMigração concluída no projeto {DESTINATION_PROJECT}.")
        return 0
    except (RuntimeError, ValueError) as error:
        print(f"ERRO: {error}", file=sys.stderr)
        return 1
    except Exception as error:  # Firebase fornece detalhes úteis no texto da exceção.
        print(f"ERRO DO FIREBASE: {error}", file=sys.stderr)
        if isinstance(error, RETRYABLE_FIREBASE_ERRORS) or "429" in str(error):
            print(
                "A cota continuou indisponível após as novas tentativas. "
                "Se o limite diário foi esgotado, aguarde a renovação da cota ou "
                "verifique faturamento e cotas no Google Cloud. Depois execute novamente "
                "com --on-conflict skip para continuar do ponto em que parou.",
                file=sys.stderr,
            )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
