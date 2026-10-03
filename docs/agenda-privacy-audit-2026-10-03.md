# Auditoria de privacidade da Agenda — 03/10/2026

## Correções publicadas

- APIs Vercel/Render usam listas explícitas de campos públicos; autoria, e-mails, códigos internos e caminhos de armazenamento não são retornados no catálogo.
- Avisos públicos usam projeção sem e-mail/UID do autor.
- Enquetes públicas retornam somente as contagens; cada eleitor autenticado pode consultar apenas seu próprio voto.
- Acompanhamento de pedido de representante retorna status e turma, sem e-mail.
- Regras do Firestore restringem leitura dos documentos completos de atividades, avisos, atualizações, pedidos de representante e enquetes.
- Consultas anônimas das coleções activities, boardNotices, agendaUpdates, polls, feedback, admins e userProfiles retornaram HTTP 403 após a publicação.
- Os endpoints privados administrativos testados já exigiam autenticação (HTTP 401 sem token).

## Pendências e limites

- O código do Worker Cloudflare está corrigido, mas sua publicação aguarda renovação OAuth. A rota antiga do Worker ainda retorna campos de autoria; não considerar a auditoria concluída enquanto isso persistir.
- O Caderno Infinito compartilha o Firestore: notebookNotes permanece publicamente legível e contém authorEmail. É necessário adaptar sua leitura/projeção em uma revisão própria; simplesmente bloquear a coleção interromperia o caderno público.
- Perfis publicados voluntariamente (nome, foto, empresa, turma, sala, andar) permanecem públicos conforme a configuração do produto, sem e-mail.
- Textos e anexos publicados podem conter dados pessoais escritos por usuários; projeção de campos não remove essas informações do conteúdo.
- suggestions usa código aleatório como capacidade de acompanhamento, não autenticação pessoal. Esse comportamento não foi alterado nesta revisão.

## Publicação segura das regras

`scripts/deploy-agenda-privacy.py` compara as regras remotas com a versão da Agenda e recusa sobrescrever alterações concorrentes. Não publica o arquivo antigo de regras do repositório Professores e não altera documentos.

Não registrar credenciais, respostas com dados pessoais, QR codes ou sessões nos logs.
