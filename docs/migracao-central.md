# Migração do Firebase central

Origem: `d-tech-56a76`. Destino: `d-tech-8555e`.

O script `scripts/migrate-central-firebase.py` copia o Firestore recursivamente e importa as contas do Authentication preservando UID, perfil, permissões e metadados. Referências de documentos passam a apontar para o destino. A origem não é apagada e conflitos no destino interrompem o processo, sem sobrescrever dados.

As credenciais privadas são `firebase-credentials/d-tech.json` e `firebase-credentials/2d-tech-novo.json`. Nunca envie essas chaves ou os snapshots ao Git. O snapshot completo fica em `firestore-snapshots/central-8555e/source.json`.

Antes da exportação, interrompa gravações dos clientes e dos crons. Não reutilize um snapshot antigo como se fosse uma cópia atual. O comando sem argumentos exporta; `--execute` importa usando a variável de ambiente `MIGRATION_INITIAL_PASSWORD`; `--verify` compara documentos e perfis com o snapshot. Verifique também se a origem não mudou durante a cópia. A senha inicial nunca deve ser versionada. Uma senha compartilhada é insegura: cada pessoa deve redefinir a sua, principalmente administradores.

O corte exige publicar as regras no destino, habilitar e-mail/senha, autorizar `tech-2d.github.io`, atualizar `src/firebase.ts` e os seis secrets `VITE_FIREBASE_*` nos três sites. Os crons privados usam `FIREBASE_SERVICE_ACCOUNT`, com a chave do destino, e validam seu `project_id` antes de executar. Reative os crons apenas após verificar a cópia e publicar os clientes.

O banco antigo permanece somente leitura após o corte para impedir gravações de abas desatualizadas. O backup das regras anteriores fica no snapshot privado. Não reative gravações na origem sem planejar a reconciliação dos dados novos.
