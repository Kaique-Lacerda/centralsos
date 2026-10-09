# Backend Control/Agent: preparação, operação administrativa e homologação

## Estado e arquitetura

Base desta etapa: `60c64e9210157fbccd76c300be84f0c3cbcc58a2`, merge do PR #18.
Os três produtos e a versão pública 0.2.0 permanecem intactos.

```text
Web público → portal, downloads Cliente/Suporte, Tools
Suporte Tauri → HTTPS /api/control/* → PostgreSQL + OIDC
Agent Windows → HTTPS outbound /api/agent/* → mesmo Backend
Agent → Named Pipe autenticado → Session Helper → contexto do usuário
```

Não há conexão direta Suporte→IP do cliente, porta local do Agent, novo comando
remoto ou mudança de policy. Agent/Helper/vault/ACL/trusted_image/lifecycle não
foram alterados. O Helper real só pode ser homologado em sessão interativa Windows;
a integração automática não declara que executou operações Windows.

### Inventário

| Item | Estado nesta etapa | Validação necessária |
|---|---|---|
| API Control/Agent | Entrypoints Node TypeScript ESM existentes | Testes de API, resolução ESM e deployment real |
| Persistência | PostgreSQL `pg`, documento transacional e locks compartilhados | Banco isolado real e capacidade/conexões do provedor |
| Browser OIDC | PKCE S256, state, nonce, assinatura RS256/ES256, usuário habilitado | Configuração e login no provedor real |
| Auth nativa | PR #17, host Rust PR #18, token em memória Rust | Navegador externo→confirmação→handoff real |
| Migrações | 001/002 preservadas; executor + ledger; 003 administrativa | Dry-run e aplicação autorizada no banco escolhido |
| Provisionamento | CLI administrativo, idempotente, auditado, dry-run | IDs/subject reais fornecidos pelo proprietário |
| Infra local | Node/Cargo presentes; sem PostgreSQL/Docker no PATH/instalação padrão | Banco isolado externo ou local configurado explicitamente |
| Vercel | Projeto `centralsos` listado | Inspeção detalhada/deployments recusada com HTTP 403 no escopo da equipe; CLI indisponível |
| Produção PG/OIDC/origem | Não confirmados | Não inferir operação a partir de build/deploy `READY` |

Nenhuma migração/provisão foi aplicada em produção. Nenhuma variável de produção
foi criada/alterada. Nenhum domínio, banco, conta ou credencial foi inventado.

## Infraestrutura e configuração externa

O proprietário deve definir PostgreSQL persistente, provedor OIDC, app OIDC
confidencial e uma **origem HTTPS canônica real**, por exemplo conceitual
`https://<host-real-do-control>`. Não use esse placeholder literalmente.
Mesma origem no Backend, Agent e Suporte; sem caminho, query, fragment ou
credenciais. Backend pode permanecer no projeto Vercel do portal: a UI pública
continua separada conceitualmente das APIs.

| Variável | Uso / exigência |
|---|---|
| `CONTROL_DATABASE_URL` | Backend somente; URL PostgreSQL do usuário de runtime |
| `CONTROL_DATABASE_TLS` | Padrão `verify-full`; certificado/hostname verificados. `disable` aceito somente para host loopback explícito de desenvolvimento/teste |
| `CONTROL_DATABASE_CA` | CA PEM pública opcional do banco; não contém chave privada |
| `CONTROL_ORIGIN` | Origem HTTPS canônica publicada |
| `CONTROL_OIDC_ISSUER` | Issuer HTTPS exato, incluindo caminho se o provedor usar tenant |
| `CONTROL_OIDC_CLIENT_ID` | Client ID do aplicativo confidencial Backend |
| `CONTROL_OIDC_CLIENT_SECRET` | Secret **somente** no Backend/secret manager |
| `CONTROL_SESSION_SECRET` | Segredo aleatório de pelo menos 32 caracteres; compartilhado entre instâncias, protegido no Backend |
| `CONTROL_OFFLINE_SECONDS` | Inteiro 30–3600, padrão 90 |
| `CONTROL_ADMIN_ENABLED` | `1` apenas no processo administrativo autorizado; não configurar na Function pública |
| `CONTROL_ADMIN_ACTOR` | Identificador do responsável administrativo; auditado por hash |
| `CONTROL_ADMIN_DATABASE_URL` | Conexão administrativa explícita, separada da URL de runtime |
| `CONTROL_TEST_DATABASE_URL` | Banco **dedicado e descartável**, nome `central_sos_test` ou `central_sos_test_<sufixo>` |
| `CONTROL_TEST_ALLOW_DATABASE` | Nome exato desse banco para consentir os testes SQL |

Não prefixar secrets com `VITE_`. Não commitar `.env`, arquivos de provisionamento
contendo dados reais, configuração local, tokens, senhas ou chaves. O CLI lê o
ambiente do processo; não carrega `.env` automaticamente e não aceita senha por
argumento. Exporte configurações usando o secret manager autorizado, sem comandos
que imprimam valores ou os gravem no histórico do terminal.

URLs PostgreSQL não podem conter opções `ssl*`: no `pg` essas opções podem
substituir o objeto TLS/CA. Configure TLS com as variáveis acima. Nenhuma opção
`rejectUnauthorized:false` existe no runtime. Referência:
[SSL no node-postgres](https://node-postgres.com/features/ssl).

Use role de migração com DDL apenas no processo administrativo. Runtime necessita
acesso às tabelas de Control/NativeAuth (SELECT/INSERT/UPDATE conforme queries),
sem CREATE/DROP e sem escrita nas tabelas administrativas/ledger. Conceda
permissões explicitamente após migração conforme o provedor; teste com a role real.
Admin mode não substitui proteção das credenciais, máquina administrativa e grants.

## Migrações

Com `CONTROL_ADMIN_ENABLED=1`, ator e conexão administrativa definidos:

```powershell
npm.cmd run control:admin -- migrate --dry-run
# Somente depois de backup/revisão e autorização do proprietário:
npm.cmd run control:admin -- migrate --apply
npm.cmd run control:admin -- diagnose
```

Dry-run é o padrão sem `--apply`. Ele verifica histórico/tabelas, **não executa
nem valida a sintaxe do SQL pendente**. Catálogo fixo: 001, 002, 003, 004.
O executor remove os envelopes BEGIN/COMMIT e mantém
**DDL + ledger na mesma transação**. SHA-256 usa UTF-8 com
CRLF normalizado para LF, garantindo o mesmo checksum em Windows/Linux.

`control_schema_migrations` registra versão, arquivo, checksum e data; recusa
ordem divergente, versão desconhecida, checksum alterado e tabela aplicada ausente.
Locks de transação coordenam duas execuções administrativas simultâneas.
[Locks PostgreSQL](https://www.postgresql.org/docs/current/explicit-locking.html).
003 cria apenas `control_companies` e `control_administrative_audit`, sem apagar
ou reestruturar os stores existentes.

**Banco legado sem ledger:** se 001/002 foram aplicadas manualmente antes desta
etapa, o executor recusa com `MIGRATION_LEGACY_SCHEMA_UNTRACKED`. Não adota nem
recria tabelas cegamente. Faça backup e verificação independente de DDL, índices,
constraints e dados contra os SQL exatos. Um DBA autorizado deve registrar apenas
as versões comprovadamente aplicadas e seus checksums normalizados no ledger;
essa reconciliação é manual, não há flag de bypass. Se não for possível comprovar
o estado, restaure backup conhecido ou use banco novo isolado, preservando o legado.
Migração divergente exige investigação/restauração do arquivo correto ou nova
migração incremental; nunca reescrever checksum para esconder mudança de SQL.

### Correção da coluna reservada `window` / reaplicação segura

PostgreSQL reserva `WINDOW`. A 001 original usava esse identificador sem aspas;
`--apply` falhava com SQLSTATE `42601`, mesmo após dry-run aprovado.
A 001 corrigida cria `window_start`; 004 renomeia `"window"` em instalações
rastreadas existentes, preservando os contadores, ou não altera a tabela nova.
Se as duas colunas coexistirem ou nenhuma existir, 004 recusa e reverte o lote.

Compatibilidade é restrita ao par de SHA-256 normalizados de **001_control.sql**:

- predecessor: `7ee5b61d78dd7865d7d1874aa226fae056559b25d65093f835409290f936e255`;
- corrigida: `ef18cc36bc427b2556889440244642d052b2ebbe348164fd1e6bf47101358168`.

O executor reconhece o checksum predecessor somente quando o arquivo esperado
é exatamente a correção revisada. **Nenhuma linha/checksum/data já aplicada é
reescrita**, e 002/003 continuam intactas. Outros checksums são recusados.
Reconhecer esse predecessor não afirma que seu SQL original inválido foi
executado: instalações manuais com coluna entre aspas exigem a reconciliação
independente descrita acima, nunca inserir o checksum cegamente no ledger.

Procedimento para o proprietário/DBA autorizado (não executado automaticamente):

1. Faça backup e confira o ledger e a estrutura, sem divulgar credenciais.
2. Use o código administrativo corrigido. Mantenha o runtime de enrollment
   suspenso durante a migração; ative sua versão corrigida somente após o sucesso.
3. Execute `npm.cmd run control:admin -- migrate --dry-run` com a configuração
   administrativa protegida. Banco cujo lote falhou integralmente deve mostrar
   001–004 pendentes; banco rastreado atualizado até 003 deve mostrar apenas 004.
4. Após revisão/autorização, execute `npm.cmd run control:admin -- migrate --apply`.
5. Execute dry-run/`diagnose` novamente: nenhuma migração deve estar pendente.
   Repetir `--apply` não reaplica SQL nem altera checksums.

Se houver schema sem ledger, checksum divergente ou duas colunas, pare para
reconciliação pelo DBA; não apague tabelas nem use bypass. A migração antiga
falha dentro da transação; não precisa remover tabelas após rollback confirmado.

Erros SQL agora têm códigos seguros: `DATABASE_SQL_SYNTAX_ERROR` (42601),
`DATABASE_PERMISSION_DENIED` (42501), `DATABASE_SCHEMA_MISMATCH` (42703),
`DATABASE_SCHEMA_CONFLICT` (42P07/42701), `DATABASE_CONSTRAINT_VIOLATION` (classe
23) e `DATABASE_TRANSACTION_FAILURE` (classe 40). O CLI imprime somente o código,
sem mensagem PostgreSQL, SQL, detalhes de linha, URL ou credenciais.

Teste PostgreSQL real, exclusivamente local/descartável:

```powershell
$env:CONTROL_TEST_POSTGRES_BIN = '<diretorio-local-dos-binarios-PostgreSQL>'
node --test tests/integration/Migrations.test.mjs
```

O teste inicia um cluster novo autenticado em `127.0.0.1`, em porta livre,
confirma a identidade do diretório de dados, cria banco/schema de teste e encerra
o processo ao terminar. Não registra serviço Windows nem lê URLs de bancos
existentes. Arquivos temporários ficam em `.control-build/`, ignorado pelo Git.
Sem os binários explicitamente configurados, a suíte informa skip; os testes
unitários continuam disponíveis em `npm.cmd run test:control`.

Se houver falha, o lote inteiro reverte. Corrija a causa e rode dry-run novamente.
Não inclua migrações no startup da API/build/CI nem rode automaticamente em produção.

## Provisionamento inicial

Crie um JSON administrativo protegido **fora do Git** com dados reais:

```json
{
  "company": { "id": "<UUID-real-da-empresa>", "name": "<nome-real>" },
  "environment": { "id": "<UUID-real-do-ambiente>", "name": "<nome-real>" },
  "operator": { "subject": "<sub-exato-do-OIDC>", "name": "<nome-real>" },
  "role": "admin"
}
```

O exemplo é um formato, não dados executáveis nem usuário padrão. Escolha
viewer/operator/admin explicitamente. `subject` é o `sub` exato do issuer
configurado, não email presumido. O sistema atual tem **um issuer global**:
trocar issuer em banco populado exige revisão/reprovisionamento das identidades,
nunca associar novos subjects automaticamente por email/nome.

```powershell
npm.cmd run control:admin -- provision --file <arquivo-protegido> --dry-run
npm.cmd run control:admin -- provision --file <arquivo-protegido> --apply
# Para alteração deliberada de papel existente, após revisar dry-run:
npm.cmd run control:admin -- provision --file <arquivo-protegido> --apply --confirm-role-change
```

IDs e subjects inválidos/controles/campos extras são recusados. Mesmo input não
duplica empresa, ambiente, usuário, membership ou auditoria. Um environmentId não
pode mudar de empresa. Outros vínculos não são removidos. Usuário desabilitado
não é reativado implicitamente. Não existe operação de exclusão ou promoção pública.
Auditoria administrativa transacional registra hashes de ator/subject, IDs e
mudanças/papéis anterior e atual; não inclui secrets, nomes ou subject em claro.
Dry-run não persiste provisão nem auditoria. Alterações em produção exigem
autorização independente; disponibilizar o CLI não é autorização para usá-lo lá.

## OIDC e HTTPS

Registre no provedor Authorization Code, S256 PKCE e scopes `openid profile`.
Backend é o cliente confidencial; Suporte não recebe client secret/OIDC token.
Callbacks exatos, sem wildcard:

- Browser legado: `<CONTROL_ORIGIN>/api/control/auth/callback`;
- Native via navegador externo: `<CONTROL_ORIGIN>/api/control/auth/native/callback`.

O callback Native continua sendo HTTPS no Backend; não é custom URI/Tauri/localhost.
Não configurar redirects fornecidos por usuário. Issuer/discovery precisam oferecer
authorization_endpoint, token_endpoint e jwks_uri HTTPS, com issuer exato e
ID tokens RS256 ou ES256. Tokens exigem exp/iat/sub/nonce, issuer/audience e
assinatura válidos; state, prova PKCE, cookie do navegador e confirmação explícita
continuam obrigatórios. Apenas sujeitos previamente provisionados/habilitados e
memberships autorizados recebem a sessão nativa. Role viewer não envia comandos;
pairing exige admin da empresa do ambiente.

Vercel: mantenha `npm run build:web`, saída `dist/web`, entradas Node em `/api` e
rewrite que **exclui `/api`**. Configurações PG/OIDC são runtime server-side,
nunca do bundle Vite. Arquivos ESM usam imports `.js` resolvidos para fontes `.ts`.
Módulos administrativos não são entrypoints HTTP. Não há endpoint público de health
com schema/users/config. Referência: [Vercel Node runtime](https://vercel.com/docs/functions/runtimes/node-js).

Ingress deve ser TLS real; no host Vercel somente `VERCEL=1` permite confiar no
header `x-forwarded-proto` sobrescrito pela plataforma. Em outro host, encaminhar
HTTP de proxy diretamente ao handler não satisfaz o gate nativo existente: use
TLS no ingresso Node ou um adapter de proxy confiável previamente revisado.
Não habilite `VERCEL=1` artificialmente nem aceite headers arbitrários para burlar TLS.
`control:dev` é loopback HTTP para desenvolvimento existente, não prova HTTPS nativo.

Use conexões/pooling compatíveis com o provedor; runtime usa max 4, connect timeout
5 s, statement timeout 10 s, lock timeout 5 s. O modelo MVP serializa transições
por documento/lock: testar carga, retenção de audit/commands e limites antes de uso
amplo. Migrações e provisionamento não resolvem crescimento ilimitado do store.
Não mudar região ou publicar configuração operacional sem autorização.

## Diagnósticos administrativos e recuperação

`control:admin diagnose` é comando local restrito, não rota pública. Relata apenas
codes de configuração/conexão/ledger. OIDC configurado é marcado
`CONFIGURED_NOT_HOMOLOGATED`: não confirma login real.
Logs de requests usam event/area/code; não imprimem mensagem original, SQL, URLs,
query, IP, identidade, cookies, Authorization ou corpo. O host/provedor também
deve redigir query dos callbacks, bodies de login e headers sensíveis em seus logs.

| Código | Ação administrativa |
|---|---|
| DATABASE_NOT_CONFIGURED / CONTROL_NOT_CONFIGURED / OIDC_NOT_CONFIGURED | Definir configuração externa no ambiente correto |
| DATABASE_UNAVAILABLE / DATABASE_TIMEOUT | Verificar rede/grants/pool/TLS/CA/provedor; não desabilitar certificados |
| DATABASE_TLS_URL_OPTIONS_FORBIDDEN | Retirar ssl* da URL e configurar TLS separado |
| MIGRATION_REQUIRED / MIGRATION_SCHEMA_MISSING | Backup, revisar/aplicar migrações autorizadas; ausência de tabela aplicada exige investigação |
| MIGRATION_DIVERGENT / MIGRATION_LEGACY_SCHEMA_UNTRACKED | Interromper; revisão DBA; não apagar/recriar nem editar ledger cegamente |
| ADMINISTRATION_NOT_AUTHORIZED | Configurar processo administrativo explícito; não expor como API |
| ENVIRONMENT_COMPANY_CONFLICT | Corrigir input; não reassociar dispositivos entre tenants |
| ROLE_CHANGE_CONFIRMATION_REQUIRED / OPERATOR_DISABLED | Revisar vínculo/usuário; sem promoção/reativação implícita |
| AUTHORIZATION_DENIED / MEMBERSHIP_REQUIRED | Revisar membership/role/empresa |
| PROTOCOL_MISMATCH / ENROLLMENT_REJECTED | Conferir protocolo/perfil/pareamento/expiração sem novos comandos |
| PROOF_INVALID / TRANSACTION_CONSUMED / SESSION_EXPIRED / SESSION_REVOKED | Reiniciar login legítimo; nunca copiar cookie/token para React |

Revogação/expiração/disable/membership continuam checadas em PostgreSQL a cada
request nativo. Mudança de segredo de sessão invalida provas OIDC pendentes, mas
não substitui revogação explícita de sessões existentes; planeje janela de manutenção
e recuperação sem imprimir/manipular credenciais em ferramentas não autorizadas.

## Validações automáticas

```powershell
npm.cmd run typecheck
npm.cmd run build:client
npm.cmd run build:support
npm.cmd run build:web
npm.cmd run test:validation
npm.cmd run test:tools
npm.cmd run test:control
npm.cmd run test:release
npm.cmd run test:diagnosis
npm.cmd run test:control:integration
cargo check --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri-support/Cargo.toml
# Checks/tests sequenciais também para crates/core, link, agent, session-helper.
git diff --check
```

`Administration.test.mjs` cobre SQL-contract fixtures; não é prova de PostgreSQL.
Integração usa um banco PostgreSQL **real** fornecido externamente, opt-in pelo nome,
schemas aleatórios privados e dois pools/Backends HTTPS independentes. Não usa
CONTROL_DATABASE_URL como fallback. Nunca apaga banco; cleanup elimina somente o
schema criado por esse teste no banco confirmado. Role de teste precisa CREATE
SCHEMA/grants no banco dedicado. Não usar credenciais de produção nem banco com
dados reais, mesmo se renomeado para passar o guard.

OIDC controlado e HTTPS usam certificado TLS e assinatura OIDC efêmeros **somente
de testes**, sem chave updater; arquivo privado temporário é removido imediatamente
após leitura em `.control-build` ignorado. OpenSSL necessário: no Windows padrão
do Git, ou caminho via `CONTROL_TEST_OPENSSL`; em outros sistemas `openssl` no PATH.
Certificados são verificados com CA explícita do fixture, sem desabilitar TLS global.

A suíte integrada cobre as 20 exigências: migrações/provisão; OIDC/membership;
handoff entre réplicas; environments/devices/pairing; enrollment concorrente;
heartbeat; polling/ACK; resultado **REJECTED com simulated=true** sem executar Windows;
auditoria/idempotência; revoke/logout/expiry/disable; isolamento de empresa/viewer;
transações/duas instâncias; conexão SQL indisponível; logs sem secrets. Sem conexão
de teste configurada, esse cenário é explicitamente **skipped** e não é declarado
aprovado. Os testes de isolamento de configuração e OIDC HTTPS continuam executando.

Cliente Rust completo tem limitação conhecida: binário de testes com manifesto
requireAdministrator pode falhar com Windows 740 em terminal não elevado; biblioteca
pode ser testada separadamente. Testes Windows ignorados do Pipe/Helper/ACL exigem
homologação controlada; não forçar nem enfraquecer manifesto/segurança para passarem.

## Checklist de homologação real (proprietário/técnico)

- [ ] Acesso autorizado ao projeto Vercel; SHA/deployment corretos, Functions presentes; portal sem Control operacional público.
- [ ] Banco persistente/isolado de homologação definido; TLS certificado/grants/runtime limitados e backup verificados.
- [ ] Migrações dry-run/aplicação autorizada; ledger/checksums atuais; repetir sem duplicação.
- [ ] Empresa/ambiente/operador/sub/role reais; dry-run revisado; provisão autorizada; zero credenciais padrão.
- [ ] OIDC real: issuer/client/scopes/callbacks exatos, secrets somente Backend; não provisionado recusado.
- [ ] Origem HTTPS real canônica no Backend e configuração local Suporte/Agent.
- [ ] Suporte sem configuração mostra estado adequado; login externo legítimo, conferir código/identidade, consentir e concluir uma vez.
- [ ] Sessão/ambientes/dispositivos/pairing/resultados; logout, expiração, disable/revogue; React sem credenciais e sem cookies copiados.
- [ ] Agent de homologação: enroll uma vez, vault existente, heartbeat/poll/ACK/result/revoke; protocolo incompatível recusado.
- [ ] Comando session read-only em Windows real: Agent Session 0→Pipe→Helper do usuário; sem usuário/helper ausente nunca fallback SYSTEM.
- [ ] Usuário bloqueado/desconectado/RDP/múltiplas sessões/Helper incompatível e ACL/trusted_image existentes validados manualmente.
- [ ] Teste real com duas instâncias, concorrência, tenant isolation e banco indisponível.
- [ ] Logs da aplicação **e do host** redigidos; backup/recovery e carga/retensão avaliados.
- [ ] `/api/tools-manifest` e `/api/app-update` preservados; releases/updater/identidades/versões sem alteração.

Até concluir esse checklist, a entrega é **preparação de Backend**, não certificação
de produção operacional. Instalação/lifecycle Agent/Helper pertence ao próximo PR.

### Resultado local desta entrega

- Typecheck e builds Cliente/Suporte/Web aprovados; seis Cargo checks aprovados.
- JS: Validação 208, Tools 25, Control 132, Release 29, Diagnóstico 33 aprovados.
- Integração: guard de isolamento e OIDC por HTTPS aprovados; cenário PostgreSQL
  real ignorado explicitamente por ausência de configuração de banco de teste.
- Rust: biblioteca Cliente 2, Suporte 16, Core 49, Link 24, Agent 9, Helper 1
  aprovados; 5 testes Windows continuam ignorados. Binário de testes Cliente não
  iniciou por erro Windows 740 (elevação requerida preexistente).
- Diagnóstico CLI executado sem conexão operacional: OIDC_NOT_CONFIGURED,
  CONTROL_NOT_CONFIGURED, DATABASE_NOT_CONFIGURED. Nenhum segredo foi impresso.
- Inspeção detalhada Vercel impedida por HTTP 403; nenhuma publicação operacional
  ou modificação de variáveis/migração/provisionamento em produção realizada.
