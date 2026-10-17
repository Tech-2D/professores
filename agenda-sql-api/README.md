# Agenda SQL — migração gradual

Base inicial de uma API Cloudflare Workers + PostgreSQL Aiven. **Não substitui ainda o backend em produção.**

## Decisões desta etapa

- Firebase Authentication permanece responsável pelo login e recuperação de senha. A API verifica assinatura, projeto, validade, revogação e conta desativada, sem consultar o Firestore para autorização.
- Papéis e turma vêm de `tech2d.admin_profiles` no PostgreSQL. Ninguém escolhe um papel no corpo da requisição.
- `tech2d.activities` tem colunas SQL e índices por turma/data. Conteúdo original de todas as coleções/subcoleções fica em arquivo local e em arquivo de preservação JSONB privado, `tech2d.firestore_documents`.
- IDs antigos são preservados, inclusive referências aos anexos. Objetos do R2 e fotos do Cloudinary não são movidos.
- Demais coleções recebem cópia bruta, **não implementação automática de suas regras**. Não existe rota para consultar coleções ou executar SQL arbitrários.
- Escritas estão desativadas, assim como o estado de migração concluída. Não há fallback de escrita para Firebase: isso causaria divergência entre bancos.
- Redis não participa desta primeira API. PATCH usa transação, bloqueio de linha, versão otimista e auditoria. Configurar Hyperdrive **com query caching desativado** antes de ativar as escritas.

## Preparar a conexão

Os arquivos reais ficam na pasta ignorada pelo Git `professores/firebase-credentials/`:

```dotenv
# aiven-postgres.env — não cole em chats, commits ou logs
DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/defaultdb
PG_CA_FILE=../firebase-credentials/aiven-ca.pem
```

Use a Service URI completa e o certificado CA do mesmo serviço. O cliente remove opções SSL da URI e exige verificação do certificado e hostname com a CA; nunca usa `rejectUnauthorized: false`.

No terminal, dentro de `professores/agenda-sql-api`:

```powershell
npm ci
npm test
npm run check
npm run db:check
npm run db:migrate
npm run db:status
npm run db:runtime
```

`db:migrate` cria somente o esquema `tech2d` e tabelas novas, em transação. Não apaga tabelas nem dados existentes. Se já existir um esquema com esse nome de outra aplicação, não executar antes de conferi-lo.

## Exportar, importar e conferir

```powershell
# Lê Firestore; não grava nada nele. Parada por cota é retomável.
npm run export -- --execute

# Valida arquivo completo sem conectar ao PostgreSQL.
npm run import

# Grava PostgreSQL com conflito protegido e verifica hashes.
npm run import -- --execute
npm run verify
```

Snapshots ficam em `snapshots/`, ignorados pelo Git. Contêm dados pessoais e possivelmente sessões internas: não enviar ao GitHub, artifacts de CI, ferramentas de análise ou mensagens. No Windows as permissões dependem da ACL da pasta; o modo POSIX 0600 sozinho não garante proteção. Armazenar em pasta de acesso restrito e definir retenção depois de validar a migração.

- A exportação percorre coleções, documentos e subcoleções, inclusive filhos com pais ausentes. Preserva os campos Firestore tipados, timestamps exatos, referências, bytes e inteiros grandes na cópia bruta.
- Descoberta de subcoleções com até quatro solicitações simultâneas (`--concurrency 1` a `4`); gravação do diário serializada, sem checkpoints antes de todas as gravações da página terminarem.
- Há checkpoint por página e registro por documento. Não reiniciar continuamente quando ocorrer HTTP 429: aguardar a cota ou resolver o limite na origem.
- O importador exige marcador de conclusão e contagem consistente. Snapshot incompleto não é importado.
- Reexecução não sobrescreve importação anterior. Se um documento da origem mudou, interrompe para reconciliação; não substitui automaticamente edições realizadas no SQL.
- A importação usa lotes de até 100 documentos, com uma transação por lote. Um conflito com conteúdo diferente aborta o lote inteiro, preservando o progresso anterior.
- A verificação por SHA-256 compara campos tipados preservados com o **snapshot**, não o Firebase ao vivo. Também confere separadamente as colunas de atividades (inclusive anexos), papéis/turmas e catálogos SQL. Não verifica a existência física dos objetos R2/Cloudinary.
- A exportação online não é um snapshot transacional do banco inteiro. Para o corte final: suspender gravações de todos os clientes/serviços, exportar em um **novo arquivo**, reconciliar diferenças/exclusões, conferir novamente e só então mudar o destino de escrita. Não usar a exportação inicial como backup atual.

### Cópia com nome datado e conferência da API

```powershell
npm run export -- --execute --out snapshots/d-tech-8555e-2026-10-17.jsonl
npm run import -- --snapshot snapshots/d-tech-8555e-2026-10-17.jsonl --execute
npm run verify -- --snapshot snapshots/d-tech-8555e-2026-10-17.jsonl
npm run verify:runtime -- --snapshot snapshots/d-tech-8555e-2026-10-17.jsonl
npm run verify:runtime -- --snapshot snapshots/d-tech-8555e-2026-10-17.jsonl --remote
npm run migration:report -- --snapshot snapshots/d-tech-8555e-2026-10-17.jsonl
```

`verify:runtime` exercita o handler da API contra o Aiven real, usando somente o usuário limitado `tech2d_api`, sem gravar nem retornar conteúdo dos documentos no terminal. Compara as respostas públicas de atividades, horários, turmas e atualizações ao snapshot e confere privilégios proibidos. Com `--remote`, consulta somente a URL fixa do Worker por HTTP e compara as projeções públicas, sem ler ou transmitir credenciais SQL locais. Não valida todas as demais funções ainda não implementadas.

`migration:report` confere hashes, projeções e totais do SQL e gera um recibo sem IDs pessoais em `.wrangler/migration-verification-2026-10-17.json`. O recibo registra expressamente que a origem não foi congelada e o corte de produção não aconteceu. Não ativa flags nem altera o frontend.

## API implementada nesta etapa

| Rota | Acesso | Estado |
| --- | --- | --- |
| `GET /api/health` | Público | Estado básico, sem credenciais |
| `GET /api/catalog/agenda` | Público | Atividades, turmas, aviso, atualizações com campos permitidos |
| `GET /api/catalog/updates` | Público | Histórico sem e-mails de autoria |
| `GET /api/catalog/schedules?class=...&day=...&q=...` | Público | Horários ativos, filtros parametrizados |
| `GET /api/me` | Conta autenticada | Papel/turma da própria conta |
| `GET /api/activities/:id` | Representante da turma ou superadmin | Conteúdo público + ETag de versão |
| `POST /api/activities` | Representante da turma ou superadmin | Desativado até validação/corte |
| `PATCH /api/activities/:id` | Representante da turma ou superadmin | Exige `If-Match: "1"`; HTTP 409 se houver edição concorrente |

Representantes não gerenciam outras turmas ou eventos gerais nesta API; superadmin gerencia ambos. Autoria não é devolvida publicamente. Atualização não permite trocar autor ou anexos pelo corpo. Criação gera ID no servidor e autoria pela sessão. Não há exclusão até integrar limpeza segura do R2.

## Antes de publicar no Cloudflare

1. Conectar a CLI à conta Tech-2D correta (`67606a241ef48fd5694950bd65a3d33e`), nunca outra conta encontrada na máquina.
2. Criar usuário SQL dedicado para runtime. Não usar `avnadmin`/proprietário na API.
3. Dar `CONNECT`, `USAGE ON SCHEMA tech2d`, `SELECT` em `admin_profiles`, `activities`, `catalog_documents`; `INSERT, UPDATE` em `activities`; `INSERT` em `activity_audit`; `USAGE` na sequência de auditoria. Sem acesso ao arquivo bruto `firestore_documents`, sem DDL e sem grants públicos.
4. Criar Hyperdrive na conta correta com TLS verificado até Aiven, pool limitado conforme o plano do banco e cache de consultas desativado. A conexão e CA precisam de configuração própria no Hyperdrive; a validação local não comprova o TLS do caminho Cloudflare → Aiven.
5. Pedir autorização antes de guardar a nova credencial SQL/CA no Cloudflare. Não colocar URI/senha nos argumentos de terminal, repositório, `wrangler.jsonc` ou logs.
6. Adicionar binding `HYPERDRIVE` e variável pública `FIREBASE_WEB_API_KEY`; nenhum Firebase Admin service account é necessário no Worker.
7. Inicialmente publicar com `MIGRATION_READY=false`, `WRITES_ENABLED=false`. Não alterar DNS/URL do frontend até os testes remotos e a conferência dos dados.
8. Avaliar limites e custos do Aiven, Hyperdrive e Workers; não ativar plano pago ou prometer capacidade ilimitada.

### Publicação autorizada e protegida

O usuário autorizou a criação do login SQL limitado `tech2d_api` e seu envio exclusivamente ao Hyperdrive da conta Tech-2D, vinculado ao Worker `tech-2d-agenda-sql`.

- `npm run db:runtime` cria/confere o papel limitado e valida a conexão, sem imprimir senha. A conexão fica em `firebase-credentials/aiven-runtime.env`, ignorada pelo Git. Não regenera nem substitui senha de um papel preexistente desconhecido.
- O perfil Wrangler `tech-2d` fica vinculado somente a este diretório. Outras contas/perfis da máquina são preservados.
- `npm run cloudflare:setup` é prévia; `npm run cloudflare:setup -- --execute` confirma acesso à conta `67606a241ef48fd5694950bd65a3d33e` antes de ler a conexão SQL.
- O comando captura o token OAuth em memória pelo Wrangler, com logs em disco desativados nessa chamada; não usa tokens de outra conta herdados do ambiente.
- A conexão Hyperdrive usa somente `tech2d_api`, certificado CA verificado (`verify-full`), cache SQL desativado e limite de cinco conexões. Não muda configurações divergentes já existentes sem revisão.
- Após sucesso, o ID público do Hyperdrive pode ser adicionado ao binding `HYPERDRIVE` em `wrangler.jsonc`. O arquivo `.wrangler/sql-connection.json` registra IDs e opções não secretas, sem URI ou senha.
- É seguro publicar inicialmente com os flags `MIGRATION_READY=false` e `WRITES_ENABLED=false`: catálogos/escritas retornam 503 de preparação. Não ligar esses flags antes da verificação e corte.

## Ainda falta para a migração completa

- Confirmar conexão e preparar/importar/verificar o banco real.
- Implementar rotas autenticadas de sugestões e conversas, enquetes/aprovação/votos, avisos, solicitações de representante/turma, perfis e atualizações.
- Adaptar os dois frontends, Caderno Infinito e integrações de anexos/fotos à API; hoje ainda usam o Firebase.
- Migrar crons de recorrência, expurgo e resumo semanal e conferir TTL/arquivamento.
- Definir idempotência de criação, limitação de tráfego, métricas sem dados pessoais e limites do pool.
- Conferir projeções/totais e dados após a cópia, testar como visitante, aluno, representante de duas turmas e superadmin.
- Planejar reconciliação e corte sem duplas gravações; após começar a gravar em SQL, rollback para Firebase exige copiar o delta. Apenas trocar URL de volta perderia alterações.

## Referências

- [Cloudflare: PostgreSQL e node-postgres/Hyperdrive](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/)
- [Cloudflare: cache de consultas](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)
- [Aiven: conexão Node.js e certificado CA](https://aiven.io/docs/products/postgresql/howto/connect-node)

O projeto é um ponto de partida testado, não uma declaração de que a migração em produção já aconteceu.

### Conferência em 16/10/2026

- Conexão Aiven com CA e hostname validados: confirmada.
- Esquema `tech2d`: criado, sem alteração de dados da origem.
- Testes locais SQL/PGlite: 15 passando; bundle Worker validado.
- Exportação atual: bloqueada pelo Firestore com HTTP 429 `RESOURCE_EXHAUSTED`, inclusive na listagem inicial de coleções. Não há snapshot completo desta execução.
- A primeira conferência da CLI encontrou outra conta; a publicação foi bloqueada nela. Depois, o perfil separado `tech-2d` foi autenticado e a conta Tech-2D foi confirmada.
- Frontends e serviços atuais: não redirecionados. Nenhum dado de produção foi importado nesta etapa.
- Usuário `tech2d_api` criado/conferido no Aiven com teste de login TLS. Privilégios proibidos conferidos: sem leitura de `firestore_documents`, sem alteração de papéis/catálogos, sem DELETE em atividades e sem CREATE no esquema.
- Hyperdrive criado e conferido na conta autorizada: `aeba609cd9e94b4eb2ac5f0266b01ac4`. CA validada, `verify-full`, cache desativado, cinco conexões, usuário SQL dedicado. Reexecução confirmou a configuração sem duplicar recursos.
- Worker publicado: [tech-2d-agenda-sql](https://tech-2d-agenda-sql.tech-2d-auth-email.workers.dev/api/health). Versão `7d32e004-389d-4dc8-8dd5-1492fca4cb17`.
- Teste externo: `/api/health` retorna 200, `databaseConfigured=true`, `ready=false`, `writesEnabled=false`; `/api/catalog/agenda` retorna o 503 esperado de migração não validada. O health confirma a presença do binding, não executa uma consulta ao banco a cada visita.
- 19 testes locais passando e bundle Worker validado. O site continua usando o backend antigo e não foi ativado plano pago.

### Cópia conferida em 17/10/2026

- Exportação atual concluída com 3.684 documentos: 3.683 de coleções raiz e 1 de subcoleção. Sem alteração/exclusão na origem.
- PostgreSQL recebeu 3.684 documentos originais em arquivo privado JSONB e os mesmos 3.684 hashes foram conferidos com o snapshot.
- Projeções SQL conferidas campo a campo: 127 atividades, 7 perfis administrativos, 1.385 documentos de catálogo (1.369 horários, 15 atualizações e 1 aviso geral).
- Handler local com o usuário `tech2d_api`: consultas públicas comparadas ao snapshot e privilégios proibidos conferidos. Sem gravações de teste no banco real.
- Worker remoto: consultas HTTP comparadas ao snapshot com sucesso. Versão `6c0ce427-b060-4c1d-b966-968b6e49766f`.
- Prévia pública de leitura ativada com `PREVIEW_READS_ENABLED=true`. As respostas se identificam como `preview=true`, `source=postgresql-snapshot`, `liveSync=false` e `stale=true`, com a data da exportação. Não são dados sincronizados em tempo real com o Firestore.
- `MIGRATION_READY=false` e `WRITES_ENABLED=false` permanecem. Prévia não permite consultas privadas ou gravações, mesmo que o flag de escrita seja ligado por engano sem o flag de migração.
- 30 testes locais passando. Nenhum frontend, cron ou backend de anexos foi redirecionado nesta etapa. O uso exclusivo de SQL ainda depende dessa adaptação e reconciliação final.
- Objetos de arquivos continuam no R2 e fotos no Cloudinary; metadados existentes foram preservados. Firebase Authentication não foi alterado.

Consulte também [o relatório da cópia](../docs/sql-migration-2026-10-17.md).
