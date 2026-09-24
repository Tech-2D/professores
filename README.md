# Cadê o professor?

Aplicação web para consultar em qual sala cada professor está, com busca por nome, matéria, turma, andar e descrição da sala. A área administrativa permite criar, editar, ocultar e excluir horários.

## Tecnologias

- React + TypeScript + Vite
- Firebase Authentication
- Cloud Firestore
- GitHub Actions + GitHub Pages

## Configurar o Firebase

Os sites **Cadê o professor?** e **Agenda** usam o mesmo projeto Firebase central, `d-tech-56a76`, mantendo coleções separadas no mesmo Firestore.

1. No Console do Firebase, abra **Authentication > Sign-in method** e habilite **E-mail/senha**.
2. Em **Authentication > Users**, crie cada usuário administrador com seu próprio e-mail e senha. A senha é definida apenas no Firebase e nunca vai para o código ou para o Firestore.
3. Copie o UID de cada usuário.
4. No Firestore, crie a coleção `admins`. Para cada usuário, crie um documento cujo **ID seja o UID copiado**, com o campo `{ "role": "admin" }`.
5. Publique as regras deste repositório com `firebase deploy --only firestore:rules` ou cole o conteúdo de `firestore.rules` no Console do Firebase.

> Variáveis `VITE_*` são incorporadas ao JavaScript público. Por isso, nunca coloque senhas em `.env`, no Firestore ou nos secrets do GitHub. O site pede e-mail e senha, valida pelo Firebase Authentication e só libera o painel se o UID autenticado tiver `role: "admin"` em `admins`.

## Rodar localmente

```bash
npm install
Copy-Item .env.example .env.local
npm run dev
```

O arquivo `.env.local` é opcional e serve somente para sobrescrever a configuração pública do Firebase.

## Estrutura dos dados

Cada documento da coleção `schedules` usa este formato:

```json
{
  "professor": "Ana Cláudia",
  "subject": "Matemática",
  "className": "2º Fin A",
  "floor": "1º andar",
  "startTime": "08:00",
  "endTime": "09:30",
  "roomDescription": "Sala 12, ao lado da biblioteca",
  "dayOfWeek": 1,
  "active": true
}
```

`dayOfWeek` segue o padrão do JavaScript: `1` é segunda-feira e `6` é sábado.

## Importar a planilha de turmas

O arquivo [data/horarios-turmas.json](data/horarios-turmas.json) foi extraído da planilha **Class schedule - August 24th - All Classes.xlsx**. Contém 1.369 aulas de 44 turmas. Na área administrativa, escolha esse JSON e clique em **Cadastrar horários**. A importação valida os registros, envia em lotes e, ao reenviar o arquivo, atualiza o status ativo/inativo dos horários já cadastrados sem apagar a localização preenchida manualmente.

O arquivo de origem não identifica o andar nem a posição das salas. Por isso, os campos `floor` e `roomDescription` estão vazios, mas todas as aulas começam com `active: true` e ficam visíveis no site. Até que a localização seja cadastrada, o cartão mostra “Localização não informada”.

Mapeamentos usados: “Bens de Consumo” → `Neg`, “Fintech” → `Fin`, “Tech” → `Tec`. A planilha usa `Tech DE` para E/F/G do 3º ano; essas turmas foram mapeadas para `Tec DS` conforme a lista informada. A turma `2ª Série B Bens de Consumo` aparece como `2º Neg B`. Células sem docente e textos que não são nomes de professores foram ignorados.

Para gerar novamente o JSON a partir de outra versão da planilha:

```bash
python scripts/generate-schedules.py "caminho/da/planilha.xlsx" data/horarios-turmas.json
```

## Publicar no GitHub Pages

1. Em **Settings > Pages**, selecione **GitHub Actions** como fonte de publicação.
2. Envie as alterações para a branch `main`. O workflow `.github/workflows/deploy.yml` fará a publicação.
3. Publique também a versão atualizada das regras do Firestore, que verifica o campo `role: "admin"`.

## Centralizar os bancos Firestore

O script [scripts/migrate-firestore.py](scripts/migrate-firestore.py) copia todas as coleções, documentos e subcoleções dos projetos `procurar-professores-5c04a` e `agenda-2e1df` para `d-tech-56a76`, preservando os IDs e os tipos dos campos.

As configurações web (`apiKey`, `authDomain`, `projectId` etc.) identificam os aplicativos, mas não concedem acesso administrativo. Gere uma chave privada em **Configurações do projeto > Contas de serviço > Gerar nova chave privada** em cada um dos três projetos. Guarde os arquivos fora do Git; a pasta `firebase-credentials/` está ignorada pelo repositório.

Instale a dependência e faça primeiro uma simulação:

```powershell
python -m pip install -r scripts/requirements-firestore-migration.txt
python scripts/migrate-firestore.py `
  --source-professores-key firebase-credentials/professores.json `
  --source-agenda-key firebase-credentials/agenda.json `
  --destination-key firebase-credentials/d-tech.json
```

Se o resumo estiver correto, repita com `--execute`. Por padrão, o script interrompe antes de gravar se encontrar o mesmo caminho nas duas origens ou no destino. Para manter o documento existente, use `--on-conflict skip`; para substituí-lo, use `--on-conflict overwrite`. Em um conflito entre as duas origens, `skip` mantém a versão de `procurar-professores-5c04a` e `overwrite` usa a versão de `agenda-2e1df`.

```powershell
python scripts/migrate-firestore.py `
  --source-professores-key firebase-credentials/professores.json `
  --source-agenda-key firebase-credentials/agenda.json `
  --destination-key firebase-credentials/d-tech.json `
  --on-conflict skip `
  --execute
```

O script consulta e grava documentos em lotes, espera 250 ms entre os lotes e tenta novamente com espera progressiva quando o Firebase responde com `429`. Se o projeto tiver uma cota mais restrita, aumente a pausa, por exemplo com `--request-delay-ms 1000`. Uma execução interrompida pode ser retomada com o mesmo comando e `--on-conflict skip`; os documentos que já chegaram ao destino serão ignorados.

Se o erro `429` continuar mesmo após as novas tentativas, o limite diário do projeto provavelmente foi esgotado. Nesse caso, aguarde a renovação da cota ou verifique as cotas e o faturamento no Google Cloud antes de retomar.

> O script migra somente o Cloud Firestore `(default)`. Usuários do Firebase Authentication, senhas, arquivos do Storage, regras e índices não fazem parte da migração. Documentos da coleção `admins` usam UIDs do Authentication; para que continuem funcionando, as contas correspondentes precisam existir no projeto de destino com os mesmos UIDs.

## Comandos

```bash
npm run dev      # desenvolvimento
npm run test     # testes
npm run lint     # análise estática
npm run build    # build de produção
```
