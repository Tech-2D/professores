# Adaptação da aplicação para PostgreSQL — 17/10/2026

## Resultado atual: SQL ativado

- Janela de somente leitura explicitamente autorizada pelo proprietário. Publicadas regras que preservam as 31 declarações de leitura e bloqueiam as 51 declarações que autorizavam gravações. Authentication/login mantidos. Backup privado das regras originais salvo.
- Exportação final entre 14h25 e 14h30 de Brasília: 3.684 documentos (3.683 raiz e 1 aninhado). Reconciliação: nenhuma inserção, alteração ou exclusão pendente em relação à primeira cópia; hashes, projeções e totais conferidos. 1.578 documentos de aplicação preparados.
- `production_enabled=true`, `APPLICATION_WRITES_ENABLED=true`, `MIGRATION_READY=true`, prévia desativada. Antigo REST `WRITES_ENABLED=false` intencionalmente: somente `/api/data` recebe gravações de formulários.
- Os três sites foram publicados com `VITE_DATA_BACKEND=sql`, com Actions concluídos. Vercel usa `DATA_BACKEND=sql`; Render mantém a origem Firestore em somente leitura e encaminha os endpoints antigos de anexos/consultas à implementação SQL, sem receber a senha Aiven nem chave interna SQL. O endereço antigo Cloudflare usa um service binding para o Worker SQL.
- Teste real com conta administrativa: criação, edição, recusa de versão antiga, leitura pública imediata, bloqueio de leitura privada anônima, upload/download PDF e painel R2 aprovados. Atividade temporária e arquivo removidos pelo fluxo normal ao terminar. Nenhuma atividade existente foi alterada.
- Consultas dos três endereços (SQL, Cloudflare antigo e Render) comparadas por conteúdo, com dados atuais (`stale=false`), sem retornar ao snapshot Redis.
- Conferência final: 57 testes da API SQL passando; os três sites e os health checks SQL/Vercel respondendo HTTP 200. CI da API de compatibilidade também concluído com sucesso.
- GitHub Actions no SQL confirmados: recorrências `39054512305` (execução sem ocorrências novas) e expurgo `39054515293` (simulação sem elegíveis). Vars `DATA_BACKEND=sql` nos dois repositórios; horários originais preservados.
- Núcleo do resumo semanal testado localmente com a mesma biblioteca de produção, dados SQL e contas Authentication reais: 8 elegíveis, 4 sem turma/desabilitados, sem falhas, sem envio de e-mails. Não foi acionada a rota cron Vercel de produção porque seu secret não está disponível no arquivo local; configuração e biblioteca do cron permanecem as existentes.
- Nenhum documento foi apagado do Firebase; contas, senhas e papéis foram mantidos. A origem continua protegida contra novas gravações para evitar divergência. Reverter para ela após gravações SQL exige reconciliar o delta.

## Implementado e validado antes da virada

- API `/api/data` com sessão Firebase validada, autorização SQL por conta/turma, consultas parametrizadas, lotes atômicos, versões e recibos idempotentes. Coleções desconhecidas e arquivo bruto da migração nunca são expostos.
- Formulários da Agenda, Cadê o professor e Caderno Infinito adaptados por `src/dataClient.ts`. O build só usa SQL quando `VITE_DATA_BACKEND=sql`. Falha SQL não retorna ao Firestore nem ao Redis antigo.
- Solicitações, aprovação de representantes/turmas, atividades, recorrências, retenção, sugestões, conversas privadas, enquetes, votos, avisos e atualizações passam pelas políticas da API. Créditos públicos continuam exigindo consentimento.
- API Vercel adaptada por `DATA_BACKEND=sql`: anexos, fotos/perfis, preferências, reservas de resumo semanal e limites usam SQL. Firebase Auth e Gmail continuam nas funções atuais. Objetos permanecem no R2 e Cloudinary.
- Automação SQL de recorrências e expurgo, com chaves diferentes, simulação, limite por execução, arquivamento transacional antes da exclusão e limpeza R2 retomável. ZIP e IDs de ocorrências são reconhecidos.
- Chaves `WEB_DATA_KEY`, `RECURRENCES_JOB_KEY`, `PURGE_JOB_KEY` no Worker; respectivamente `SQL_WEB_DATA_KEY` na Vercel e `SQL_JOB_KEY` nos dois repositórios privados. Nenhuma senha PostgreSQL nesses destinos.
- Tabelas preparadas no Aiven; cópia de aplicação com 1.578 documentos. As sessões antigas do WhatsApp continuam apenas no arquivo privado da migração. Não são uma funcionalidade reativada.
- API publicada em modo de leitura/simulação. Comparação HTTP das 127 atividades com o snapshot, compatibilidade dos 127 formulários existentes e simulações dos dois jobs conferidas sem gravação.
- Sessão real da conta administrativa indicada pelo proprietário validada na API SQL; leitura anônima do perfil bloqueada. Senhas e papéis não foram modificados.

## Procedimento utilizado (referência histórica; virada concluída acima)

O checklist abaixo foi usado na virada. Não o repetir sobre produção SQL já ativa: a reconciliação recusa sobrescrever dados após a primeira gravação da aplicação.

1. Publicar código adaptado dos três sites, API e dois crons, inicialmente sem ligar seus flags SQL. Conferir Actions/implantações. Preservar alterações locais de outras tarefas.
2. Pausar os dois jobs e esperar execuções anteriores terminarem. Colocar Vercel/Render em `DATA_BACKEND=readonly` e verificar seus health checks. O adaptador mantém leituras e bloqueia mutações, inclusive referências de snapshots; endpoints impedem efeitos externos R2/Cloudinary/SMTP durante a janela.
3. Somente após autorização explícita da janela, publicar regras temporárias que mantenham as leituras existentes e recusem novas gravações, salvando a versão anterior. `firestore-maintenance.js --freeze-writes --approved-readonly-window` confere essas invariantes antes de publicar. Não publica `deny-all`. Admin SDK ignora regras: o passo anterior é obrigatório.
4. Exportar novamente para OUTRO snapshot: `npm run export -- --execute --out snapshots/d-tech-8555e-final.jsonl`. Não reutilizar um export já concluído enquanto a origem ainda recebia alterações.
5. Rodar `db:migrate`, depois `node --env-file-if-exists=../firebase-credentials/aiven-postgres.env scripts/reconcile-snapshot.js --snapshot snapshots/d-tech-8555e-final.jsonl --source-frozen`. Confirmação de congelamento é responsabilidade do operador. O script recusa sobrescrever SQL após produção/auditoria de aplicação, preserva versões anteriores e verifica dados/projeções/totais antes do commit.
6. Conferir autenticação, projeções, leitura privada, anexos e jobs em simulação. Nenhum registro de teste no banco real antes da reconciliação final. `verify-application.js` não imprime dados pessoais.
7. Liberar `migration_state.production_enabled` somente após essa conferência; ativar `APPLICATION_WRITES_ENABLED`, `MIGRATION_READY`, desativar prévia e manter o antigo REST `WRITES_ENABLED=false`. A API exige liberação tanto no banco quanto no Worker.
8. Publicar Vercel com `DATA_BACKEND=sql` e conferir `sqlConfigured=true`; builds dos três sites com `VITE_DATA_BACKEND=sql`. Na Agenda, anexos/admin-R2 passam para a Vercel, que possui a chave interna. Não enviar essa chave ao Render sem nova autorização.
9. Ligar os dois crons com `DATA_BACKEND=sql`, executar simulação e conferir as execuções. O resumo semanal permanece no cron Vercel e recebe o banco SQL pelo mesmo adaptador, mantendo reservas anti-duplicação.
10. Fazer uma gravação de teste controlada, conferir leitura pública/privada e anexo, remover o teste pelo caminho normal e verificar auditoria. Confirmar versões publicadas e ausência de novos escritores Firestore antes de anunciar a conclusão.

## Rollback e preservação

Antes da primeira gravação SQL, é possível restaurar as regras salvas e reabilitar os escritores antigos. Depois que houver gravações SQL, **não basta trocar URLs/flags para trás**: primeiro é necessário reconciliar o delta SQL para não perder alterações.

`firestore_documents` preserva a fonte tipada atual; `source_revisions` guarda versões anteriores à reconciliação, inclusive exclusões na origem. Ambas são inacessíveis ao usuário SQL da API. `app_audit` é somente inserção para esse usuário. Backups/snapshots/chaves são ignorados pelo Git e não podem virar artifacts de CI.

Nunca restaurar senha global, apagar usuários, remover coleções da origem ou reativar WhatsApp como parte desta migração.

## Histórico do bloqueio inicial e resolução autorizada

A revisão de segurança recusou a publicação de regras `deny-all`: o pedido de migração não autorizava claramente o bloqueio amplo do acesso de produção. O comando foi recusado antes de executar: nenhuma regra mudou, nenhum export final foi iniciado e nenhum dado de origem foi apagado. A operação foi removida do utilitário, sem tentar executá-la por outro caminho.

A primeira pausa foi revertida. Em seguida o proprietário autorizou explicitamente a janela de somente leitura; foi implementada/testada uma transformação que mantém os predicados de leitura e recusa apenas operações de escrita. A virada então prosseguiu com essa autorização e as invariantes conferidas, conforme o resultado atual acima.
