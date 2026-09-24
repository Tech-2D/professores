"""Centraliza dois bancos Firestore usando snapshots JSON retomáveis.

O fluxo tem duas etapas independentes:
1. exporta cada origem para um arquivo JSON Lines local;
2. importa os snapshots no projeto central e registra o progresso.

Se uma cota for esgotada, a próxima execução continua sem reler documentos já
exportados ou regravar documentos já concluídos. O script não migra Firebase
Authentication, Storage, Realtime Database, regras ou índices.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import threading
import time
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, TextIO

import firebase_admin
from firebase_admin import credentials, firestore
from google.api_core import exceptions as google_exceptions
from google.api_core.datetime_helpers import DatetimeWithNanoseconds
from google.api_core.retry import Retry, if_exception_type
from google.cloud.firestore_v1 import DocumentReference, GeoPoint
from google.cloud.firestore_v1.bulk_writer import BulkWriterOptions, SendMode


SOURCE_PROJECTS = (
    "procurar-professores-5c04a",
    "agenda-2e1df",
)
DESTINATION_PROJECT = "d-tech-56a76"
DEFAULT_READ_BATCH_SIZE = 100
DEFAULT_WRITE_BATCH_SIZE = 100
DEFAULT_REQUEST_DELAY_MS = 250
DEFAULT_MAX_RETRY_SECONDS = 300
DEFAULT_WRITES_PER_SECOND = 50
DEFAULT_SNAPSHOT_DIR = Path("firestore-snapshots")
TYPE_MARKER = "__firestore_migration_type__"

RETRYABLE_FIREBASE_ERRORS = (
    google_exceptions.ResourceExhausted,
    google_exceptions.TooManyRequests,
    google_exceptions.DeadlineExceeded,
    google_exceptions.ServiceUnavailable,
    google_exceptions.InternalServerError,
)
RETRYABLE_GRPC_CODES = {4, 8, 13, 14}
ALREADY_EXISTS_GRPC_CODE = 6


@dataclass(frozen=True)
class DocumentCopy:
    source_project: str
    path: str
    data: dict[str, Any]


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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Exporta dois projetos Firestore para JSON e importa os snapshots "
            "de forma retomável em d-tech-56a76."
        ),
    )
    parser.add_argument(
        "--source-professores-key",
        type=Path,
        help="JSON da conta de serviço de procurar-professores-5c04a.",
    )
    parser.add_argument(
        "--source-agenda-key",
        type=Path,
        help="JSON da conta de serviço de agenda-2e1df.",
    )
    parser.add_argument(
        "--destination-key",
        type=Path,
        help="JSON da conta de serviço de d-tech-56a76.",
    )
    parser.add_argument(
        "--phase",
        choices=("all", "export", "import"),
        default="all",
        help="Executa todo o fluxo, somente a exportação ou somente a importação.",
    )
    parser.add_argument(
        "--snapshot-dir",
        type=Path,
        default=DEFAULT_SNAPSHOT_DIR,
        help=f"Pasta dos snapshots e checkpoints (padrão: {DEFAULT_SNAPSHOT_DIR}).",
    )
    parser.add_argument(
        "--on-conflict",
        choices=("error", "skip", "overwrite"),
        default="error",
        help=(
            "Ação quando duas origens ou o destino contêm o mesmo caminho. "
            "skip não lê previamente o destino; usa create e ignora AlreadyExists."
        ),
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Grava no destino. A exportação para JSON pode ocorrer sem esta opção.",
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
        help=f"Documentos por lote retomável de escrita (padrão: {DEFAULT_WRITE_BATCH_SIZE}).",
    )
    parser.add_argument(
        "--writes-per-second",
        type=positive_int,
        default=DEFAULT_WRITES_PER_SECOND,
        help=f"Limite de gravações por segundo no destino (padrão: {DEFAULT_WRITES_PER_SECOND}).",
    )
    parser.add_argument(
        "--request-delay-ms",
        type=non_negative_int,
        default=DEFAULT_REQUEST_DELAY_MS,
        help=f"Pausa entre lotes de leitura e escrita (padrão: {DEFAULT_REQUEST_DELAY_MS} ms).",
    )
    parser.add_argument(
        "--max-retry-seconds",
        type=positive_int,
        default=DEFAULT_MAX_RETRY_SECONDS,
        help=f"Prazo de retentativas de leitura (padrão: {DEFAULT_MAX_RETRY_SECONDS} s).",
    )
    return parser.parse_args()


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


def require_key(path: Path | None, option_name: str) -> Path:
    if path is None:
        raise ValueError(f"Informe {option_name} para esta etapa.")
    return path


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
    app_name = f"migration-{project_id}"
    try:
        app = firebase_admin.get_app(app_name)
    except ValueError:
        app = firebase_admin.initialize_app(
            credentials.Certificate(str(key_path)),
            {"projectId": project_id},
            name=app_name,
        )
    return firestore.client(app=app)


def encode_value(value: Any) -> Any:
    if isinstance(value, DocumentReference):
        return {TYPE_MARKER: "reference", "path": value.path}
    if isinstance(value, DatetimeWithNanoseconds):
        return {TYPE_MARKER: "timestamp", "value": value.rfc3339()}
    if isinstance(value, datetime):
        return {TYPE_MARKER: "timestamp", "value": value.isoformat()}
    if isinstance(value, GeoPoint):
        return {
            TYPE_MARKER: "geopoint",
            "latitude": value.latitude,
            "longitude": value.longitude,
        }
    if isinstance(value, bytes):
        return {TYPE_MARKER: "bytes", "value": base64.b64encode(value).decode("ascii")}
    if isinstance(value, Mapping):
        return {
            TYPE_MARKER: "map",
            "value": {str(key): encode_value(item) for key, item in value.items()},
        }
    if isinstance(value, (list, tuple)):
        return {TYPE_MARKER: "array", "value": [encode_value(item) for item in value]}
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    raise TypeError(f"Tipo Firestore ainda não suportado no snapshot: {type(value).__name__}")


def decode_value(value: Any, destination_client) -> Any:
    if not isinstance(value, Mapping) or TYPE_MARKER not in value:
        return value

    kind = value[TYPE_MARKER]
    if kind == "reference":
        return destination_client.document(str(value["path"]))
    if kind == "timestamp":
        stamp = str(value["value"])
        try:
            return DatetimeWithNanoseconds.from_rfc3339(stamp)
        except ValueError:
            return datetime.fromisoformat(stamp)
    if kind == "geopoint":
        return GeoPoint(float(value["latitude"]), float(value["longitude"]))
    if kind == "bytes":
        return base64.b64decode(str(value["value"]))
    if kind == "map":
        return {
            str(key): decode_value(item, destination_client)
            for key, item in value["value"].items()
        }
    if kind == "array":
        return [decode_value(item, destination_client) for item in value["value"]]
    raise ValueError(f"Marcador de tipo desconhecido no snapshot: {kind!r}")


def snapshot_path(snapshot_dir: Path, project_id: str) -> Path:
    return snapshot_dir / f"{project_id}.jsonl"


def manifest_path(snapshot_dir: Path, project_id: str) -> Path:
    return snapshot_dir / f"{project_id}.manifest.json"


def read_json_lines(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as file:
        for line_number, line in enumerate(file, start=1):
            if not line.strip():
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as error:
                raise ValueError(
                    f"Snapshot corrompido em {path}, linha {line_number}: {error}",
                ) from error
    return records


def snapshot_is_complete(snapshot_dir: Path, project_id: str) -> bool:
    path = manifest_path(snapshot_dir, project_id)
    if not path.exists():
        return False
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return bool(manifest.get("complete"))


def append_snapshot(file: TextIO, document: DocumentCopy) -> None:
    record = {
        "sourceProject": document.source_project,
        "path": document.path,
        "data": encode_value(document.data),
    }
    file.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")


def walk_collection_to_snapshot(
    source_client,
    collection,
    source_project: str,
    exported_paths: set[str],
    snapshot_file: TextIO,
    read_batch_size: int,
    retry_policy: Retry,
    delay_seconds: float,
) -> int:
    document_refs = list(
        collection.list_documents(page_size=1000, retry=retry_policy, timeout=120),
    )
    pending_refs = [reference for reference in document_refs if reference.path not in exported_paths]
    exported_now = 0

    for reference_batch in chunks(pending_refs, read_batch_size):
        snapshots = source_client.get_all(
            reference_batch,
            retry=retry_policy,
            timeout=120,
        )
        for snapshot in snapshots:
            if not snapshot.exists:
                continue
            document = DocumentCopy(
                source_project=source_project,
                path=snapshot.reference.path,
                data=snapshot.to_dict() or {},
            )
            append_snapshot(snapshot_file, document)
            exported_paths.add(document.path)
            exported_now += 1
        snapshot_file.flush()
        pause(delay_seconds)

    # Pais sem campos também podem conter subcoleções.
    for document_ref in document_refs:
        subcollections = document_ref.collections(
            page_size=1000,
            retry=retry_policy,
            timeout=120,
        )
        for subcollection in subcollections:
            exported_now += walk_collection_to_snapshot(
                source_client,
                subcollection,
                source_project,
                exported_paths,
                snapshot_file,
                read_batch_size,
                retry_policy,
                delay_seconds,
            )
    return exported_now


def export_project(
    source_client,
    source_project: str,
    snapshot_dir: Path,
    read_batch_size: int,
    retry_policy: Retry,
    delay_seconds: float,
) -> int:
    snapshot_dir.mkdir(parents=True, exist_ok=True)
    output_path = snapshot_path(snapshot_dir, source_project)
    existing_records = read_json_lines(output_path)
    exported_paths = {str(record["path"]) for record in existing_records}

    if snapshot_is_complete(snapshot_dir, source_project):
        print(
            f"[{source_project}] snapshot completo reutilizado: "
            f"{len(exported_paths)} documento(s).",
        )
        return len(exported_paths)

    print(
        f"\n[{source_project}] retomando exportação com "
        f"{len(exported_paths)} documento(s) já salvos em {output_path}.",
    )
    collections = sorted(
        source_client.collections(retry=retry_policy, timeout=120),
        key=lambda item: item.id,
    )
    with output_path.open("a", encoding="utf-8", newline="\n") as snapshot_file:
        for collection in collections:
            exported_now = walk_collection_to_snapshot(
                source_client,
                collection,
                source_project,
                exported_paths,
                snapshot_file,
                read_batch_size,
                retry_policy,
                delay_seconds,
            )
            print(
                f"  - {collection.id}: {exported_now} novo(s); "
                f"{len(exported_paths)} salvo(s) no total",
            )

    manifest = {
        "projectId": source_project,
        "complete": True,
        "documentCount": len(exported_paths),
        "format": "firestore-jsonl-v1",
    }
    manifest_path(snapshot_dir, source_project).write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"[{source_project}] exportação concluída.")
    return len(exported_paths)


def load_documents_from_snapshots(snapshot_dir: Path) -> list[DocumentCopy]:
    documents: list[DocumentCopy] = []
    for project in SOURCE_PROJECTS:
        path = snapshot_path(snapshot_dir, project)
        if not path.is_file() or not snapshot_is_complete(snapshot_dir, project):
            raise ValueError(
                f"Snapshot de {project} não está completo. Execute primeiro --phase export.",
            )
        for record in read_json_lines(path):
            documents.append(
                DocumentCopy(
                    source_project=str(record["sourceProject"]),
                    path=str(record["path"]),
                    data=record["data"],
                ),
            )
    return documents


def resolve_source_conflicts(
    documents: list[DocumentCopy],
    conflict_policy: str,
) -> tuple[list[DocumentCopy], int]:
    by_path: dict[str, DocumentCopy] = {}
    conflicts: list[str] = []
    ignored = 0
    for document in documents:
        previous = by_path.get(document.path)
        if previous is not None:
            conflicts.append(
                f"{document.path} ({previous.source_project} e {document.source_project})",
            )
            ignored += 1
            if conflict_policy == "skip":
                continue
        by_path[document.path] = document

    if conflicts and conflict_policy == "error":
        sample = "\n  - ".join(conflicts[:20])
        raise RuntimeError(f"Conflitos entre as origens:\n  - {sample}")
    return list(by_path.values()), ignored


class ImportProgress:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.completed = {
            str(record["path"])
            for record in read_json_lines(path)
            if "path" in record
        }
        self._lock = threading.Lock()
        self._file = path.open("a", encoding="utf-8", newline="\n")

    def mark(self, document_path: str, result: str) -> None:
        with self._lock:
            if document_path in self.completed:
                return
            self._file.write(
                json.dumps(
                    {"path": document_path, "result": result},
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
                + "\n",
            )
            self._file.flush()
            self.completed.add(document_path)

    def close(self) -> None:
        self._file.close()


def import_documents(
    documents: list[DocumentCopy],
    destination_client,
    snapshot_dir: Path,
    conflict_policy: str,
    write_batch_size: int,
    writes_per_second: int,
    delay_seconds: float,
) -> tuple[int, int]:
    progress = ImportProgress(snapshot_dir / f"import-{DESTINATION_PROJECT}.jsonl")
    pending = [document for document in documents if document.path not in progress.completed]
    already_completed = len(documents) - len(pending)
    print(
        f"\nImportação: {already_completed} já concluído(s); "
        f"{len(pending)} pendente(s).",
    )
    written = 0
    skipped = 0

    try:
        for document_batch in chunks(pending, write_batch_size):
            options = BulkWriterOptions(
                initial_ops_per_second=writes_per_second,
                max_ops_per_second=writes_per_second,
                mode=SendMode.parallel,
            )
            writer = destination_client.bulk_writer(options=options)
            batch_errors: list[str] = []
            batch_counts = {"written": 0, "skipped": 0}
            callback_lock = threading.Lock()

            def on_success(reference, _result, _writer) -> None:
                progress.mark(reference.path, "written")
                with callback_lock:
                    batch_counts["written"] += 1

            def on_error(failure, _writer) -> bool:
                path = failure.operation.reference.path
                if failure.code == ALREADY_EXISTS_GRPC_CODE and conflict_policy == "skip":
                    progress.mark(path, "skipped-existing")
                    with callback_lock:
                        batch_counts["skipped"] += 1
                    return False
                if failure.code in RETRYABLE_GRPC_CODES and failure.attempts < 15:
                    return True
                with callback_lock:
                    batch_errors.append(f"{path}: [{failure.code}] {failure.message}")
                return False

            writer.on_write_result(on_success)
            writer.on_write_error(on_error)
            for document in document_batch:
                reference = destination_client.document(document.path)
                decoded_data = decode_value(document.data, destination_client)
                if conflict_policy == "overwrite":
                    writer.set(reference, decoded_data)
                else:
                    writer.create(reference, decoded_data)
            writer.flush()

            written += batch_counts["written"]
            skipped += batch_counts["skipped"]
            completed_count = already_completed + written + skipped
            print(f"Importados/ignorados {completed_count} de {len(documents)} documento(s).")
            if batch_errors:
                sample = "\n  - ".join(batch_errors[:20])
                raise RuntimeError(f"Falhas ao gravar no destino:\n  - {sample}")
            pause(delay_seconds)
    finally:
        progress.close()
    return written, skipped


def run_export(args: argparse.Namespace, retry_policy: Retry, delay_seconds: float) -> int:
    source_keys = {
        "procurar-professores-5c04a": require_key(
            args.source_professores_key,
            "--source-professores-key",
        ),
        "agenda-2e1df": require_key(args.source_agenda_key, "--source-agenda-key"),
    }
    total = 0
    for project in SOURCE_PROJECTS:
        client = create_client(project, source_keys[project])
        total += export_project(
            client,
            project,
            args.snapshot_dir,
            args.read_batch_size,
            retry_policy,
            delay_seconds,
        )
    return total


def run_import(args: argparse.Namespace, delay_seconds: float) -> None:
    documents = load_documents_from_snapshots(args.snapshot_dir)
    unique_documents, source_ignored = resolve_source_conflicts(documents, args.on_conflict)
    print("\nResumo dos snapshots")
    print(f"  Documentos exportados: {len(documents)}")
    print(f"  Documentos únicos: {len(unique_documents)}")
    print(f"  Conflitos entre origens: {source_ignored}")
    print(f"  Política de conflito: {args.on_conflict}")

    if not args.execute:
        print("\nSIMULAÇÃO: nenhuma gravação foi feita. Use --execute para importar.")
        return

    destination_key = require_key(args.destination_key, "--destination-key")
    destination_client = create_client(DESTINATION_PROJECT, destination_key)
    written, skipped = import_documents(
        unique_documents,
        destination_client,
        args.snapshot_dir,
        args.on_conflict,
        args.write_batch_size,
        args.writes_per_second,
        delay_seconds,
    )
    print(f"\nMigração concluída no projeto {DESTINATION_PROJECT}.")
    print(f"  Gravados nesta execução: {written}")
    print(f"  Já existentes ignorados: {skipped}")


def main() -> int:
    args = parse_args()
    try:
        retry_policy = build_retry(args.max_retry_seconds)
        delay_seconds = args.request_delay_ms / 1000

        if args.phase in ("all", "export"):
            run_export(args, retry_policy, delay_seconds)
        if args.phase in ("all", "import"):
            run_import(args, delay_seconds)
        return 0
    except (RuntimeError, TypeError, ValueError) as error:
        print(f"ERRO: {error}", file=sys.stderr)
        return 1
    except Exception as error:  # O SDK inclui detalhes úteis na mensagem.
        print(f"ERRO DO FIREBASE: {error}", file=sys.stderr)
        if isinstance(error, RETRYABLE_FIREBASE_ERRORS) or "429" in str(error):
            print(
                "A cota continua indisponível, mas o progresso já salvo em "
                f"{args.snapshot_dir} foi preservado. Aguarde a renovação da cota e "
                "execute o mesmo comando novamente para retomar.",
                file=sys.stderr,
            )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
