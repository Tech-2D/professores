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
- Há checkpoint por página e registro por documento. Não reiniciar continuamente quando ocorrer HTTP 429: aguardar a cota ou resolver o limite na origem.
- O importador exige marcador de conclusão e contagem consistente. Snapshot incompleto não é importado.
- Reexecução não sobrescreve importação anterior. Se um documento da origem mudou, interrompe para reconciliação; não substitui automaticamente edições realizadas no SQL.
- A verificação por SHA-256 compara campos tipados preservados com o **snapshot**, não o Firebase ao vivo. Não confirma sozinha os dados projetados, referências de arquivos ou permissões.
- A exportação online não é um snapshot transacional do banco inteiro. Para o corte final: suspender gravações de todos os clientes/serviços, exportar em um **novo arquivo**, reconciliar diferenças/exclusões, conferir novamente e só então mudar o destino de escrita. Não usar a exportação inicial como backup atual.

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
- Cloudflare: CLI conectada a uma conta diferente da Tech-2D. Nenhuma publicação feita nessa conta.
- Frontends e serviços atuais: não redirecionados. Nenhum dado de produção foi importado nesta etapa.
