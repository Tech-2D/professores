# Adaptação da aplicação para PostgreSQL — 17/10/2026

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

## Estado da virada

Esta preparação **não confirma produção SQL**. Antes de anunciar a troca, conferir TODOS os itens abaixo e registrar o resultado. Não ativar apenas a leitura pública enquanto formulários ou serviços ainda gravam no Firestore.

1. Publicar código adaptado dos três sites, API e dois crons, inicialmente sem ligar seus flags SQL. Conferir Actions/implantações. Preservar alterações locais de outras tarefas.
2. Pausar os dois jobs (`DATA_BACKEND=maintenance`) e esperar execuções anteriores terminarem. Pausar os escritores Vercel/Render; verificar o `/api/health` de ambas as implantações, não apenas o código local. `DATA_BACKEND=maintenance` recusa acesso ao banco.
3. Somente após autorização explícita da janela, preparar e publicar regras temporárias que mantenham as leituras existentes e recusem novas gravações, salvando a versão anterior. Não publicar regras `deny-all`. A operação ampla de congelamento foi removida de `firestore-maintenance.js`; esse utilitário permite apenas conferir regras e restaurar um backup existente. Admin SDK ignora regras: o passo anterior é obrigatório.
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

## Bloqueio encontrado na tentativa de virada

A revisão de segurança recusou a publicação de regras `deny-all`: o pedido de migração não autorizava claramente o bloqueio amplo do acesso de produção. O comando foi recusado antes de executar: nenhuma regra mudou, nenhum export final foi iniciado e nenhum dado de origem foi apagado. A operação foi removida do utilitário, sem tentar executá-la por outro caminho.

A pausa temporária dos backends/crons foi revertida para `firestore`; a virada passa a depender de autorização explícita para uma janela de somente leitura que preserve login e consultas. `production_enabled=false`, `APPLICATION_WRITES_ENABLED=false`, `MIGRATION_READY=false` e builds sem `VITE_DATA_BACKEND=sql` continuam impedindo a troca parcial. A aprovação solicitada ao proprietário não é presumida.
