# Cópia Firestore → PostgreSQL — 17/10/2026

## Resultado confirmado

A cópia dos dados foi concluída e conferida; **o corte de produção ainda não aconteceu**.

| Conferência | Resultado |
| --- | ---: |
| Documentos originais preservados no PostgreSQL | 3.684 |
| Documentos conferidos por SHA-256 dos campos originais | 3.684 |
| Documentos em coleções raiz | 3.683 |
| Documentos em subcoleções | 1 |
| Atividades projetadas e conferidas | 127 |
| Horários projetados e conferidos | 1.369 |
| Cadastros administrativos projetados e conferidos | 7 |
| Atualizações projetadas e conferidas | 15 |
| Aviso geral projetado e conferido | 1 |

Os demais dados, incluindo sugestões, mensagens, solicitações, recorrências, aprovações e registros internos, foram preservados com seus caminhos e campos originais no arquivo privado `tech2d.firestore_documents`. Isso preserva os dados; não implementa automaticamente as funções da aplicação no SQL.

## Verificações executadas

- Exportação atual concluída, percorrendo coleções e subcoleções, com checkpoints e sem gravações no Firestore.
- Importação em lotes transacionais, sem substituir registros existentes divergentes.
- Conferência dos campos originais por hash; conferência independente de atividades/anexos, papéis/turmas e catálogos SQL.
- Totais do PostgreSQL comparados ao snapshot; recibo privado em `.wrangler/migration-verification-2026-10-17.json` dentro de `agenda-sql-api`.
- Handler da API exercitado contra Aiven com TLS e usuário limitado `tech2d_api`; projeções públicas comparadas ao snapshot.
- Teste HTTP do Worker Cloudflare: 127 atividades, 1.369 horários ativos e 15 atualizações correspondentes ao snapshot. Nenhuma escrita de teste no banco real.
- 30 testes locais cobrindo permissões, privacidade, conflitos de edição, importação idempotente, rollback de lote, deriva de projeção e proteção dos flags de preparação.

## Prévia SQL

[API de prévia de leitura](https://tech-2d-agenda-sql.tech-2d-auth-email.workers.dev/api/catalog/agenda)

Worker: `tech-2d-agenda-sql`, conta Cloudflare Tech-2D. Versão publicada: `6c0ce427-b060-4c1d-b966-968b6e49766f`.

O Hyperdrive usa TLS `verify-full`, cache SQL desligado, até cinco conexões e usuário SQL dedicado. O usuário da API não lê o arquivo privado da migração e não altera papéis de acesso.

- `PREVIEW_READS_ENABLED=true`: somente catálogos públicos podem consultar a cópia.
- `MIGRATION_READY=false` e `WRITES_ENABLED=false`: consultas privadas e gravações continuam bloqueadas.
- A API informa `preview=true`, `liveSync=false` e `stale=true`, com data da exportação, para não apresentar a cópia como sincronizada ao Firestore.

## O que ainda impede o uso exclusivo de SQL

Os clientes atuais continuam gravando diretamente no Firestore. Trocar somente a URL do calendário deixaria o SQL desatualizado e separaria leituras e gravações em bancos diferentes.

É necessário concluir e testar:

1. Formulários e autorização de Agenda/Professores: atividades, horários, cadastros de representantes/turmas, avisos e atualizações.
2. Sugestões e conversas privadas, chat de representantes, enquetes e aprovação de eleitores.
3. Preferências de turma/resumo, perfis e anotações do Caderno Infinito.
4. APIs de anexos R2/fotos e limpeza: preservar autorização e exclusão segura dos objetos.
5. Crons de recorrência, expurgo e resumo semanal: eles ainda consultam/gravam Firestore.
6. Corte coordenado: bloquear gravações antigas, obter uma exportação final em novo arquivo, reconciliar inclusões/alterações/exclusões, conferir permissões e redirecionar todos os consumidores juntos.

Firebase Authentication foi mantido separado do armazenamento: contas e senhas não foram alteradas. Não foi ativado plano pago, apagado dado da origem ou trocada URL dos sites.

## Limites desta conferência

A exportação online terminou às **13h13 de 17/10/2026, horário de Brasília**. A origem não foi congelada durante a leitura. Os hashes comprovam igualdade ao arquivo exportado, não a um ponto transacional de todo o banco nem ao estado atual da origem.

Não é seguro usar esta cópia como prova de sincronização futura. O importador interrompe divergências, não faz ressincronização destrutiva. Após começar a gravar em SQL, eventual retorno ao Firestore também precisará reconciliar o delta.

Snapshots, credenciais e recibos privados permanecem ignorados pelo Git. Não foram enviados como artifacts de CI nem incluídos em commits. IDs, e-mails e conteúdos privados não constam deste relatório.
