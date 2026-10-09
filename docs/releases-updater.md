# Releases e atualização do Desktop

O instalador oficial do Cliente agora entrega também Agent e Session Helper, via hooks
NSIS por máquina. Consulte [Instalador integrado](client-agent-installer.md) para staging,
inspeção do pacote, upgrade/rollback e retenção de dados. A workflow verifica os três PEs
no `.exe` final antes de publicar; MSI não é distribuído nesta etapa.

## Causa e configuração

O bundler lê `plugins.updater` antes de iniciar a aplicação. A configuração anterior
era acrescentada somente em tempo de execução no Rust; portanto não existia para
o bundle que tentava gerar os artefatos. Agora o script prepara um overlay público
antes da CLI, e o Rust usa a configuração efetivamente compilada.

O arquivo base mantém `bundle.createUpdaterArtifacts: true`. Os overlays ficam em
`.release-build/`, ignorado pelo Git. Nenhum overlay contém chave privada ou senha.
`build.windows.staticVCRuntime: true` substitui a variável depreciada; os scripts
preservam o valor equivalente se o shell ainda definir `STATIC_VCRUNTIME`.

| Comando | Comportamento |
| --- | --- |
| `npm run tauri:dev` | Desenvolvimento; sem exigir chave privada. Updater não configurado é não fatal. |
| `npm run tauri:build` | Build local comum, NSIS/MSI conforme configuração base, sem artefatos assinados de updater. Remove os secrets do ambiente do processo filho. |
| `npm run release:prepare -- --tag vMAJOR.MINOR.PATCH` | Valida versões e configuração pública; prepara overlay de Release. Não publica. |
| `npm run release:build -- --tag vMAJOR.MINOR.PATCH` | Exige configuração pública real e chave privada no ambiente; gera NSIS x64 e `.exe.sig`. Não publica. |
| `npm run test:release` | Contratos, rota, resolução ESM, configuração e publicação com mocks; não gera chaves nem acessa GitHub. |

Os modos dev/local podem conter a configuração pública real para testar a consulta
manual, mas não assinam seus instaladores. **Não distribua um build local como
Release oficial.** O modo Release exige assinatura e usa `requireSignedVersion:
true`, HTTPS e `allowDowngrades: false`. Não aceita opções para desativar assinatura.
A assinatura do updater é Minisign; ela não equivale à assinatura Authenticode
de reputação do Windows/SmartScreen.

## Configuração real pendente

Ainda não foram fornecidos chave pública nem domínio de produção. Não há valores
operacionais fictícios no projeto. Não coloque a chave privada nem a senha em
`.env`, no repositório, em logs ou mensagens.

### 1. Gerar o par uma única vez, manualmente

Em PowerShell, na raiz do projeto, após instalar as dependências:

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.tauri" | Out-Null
npm.cmd exec -- tauri signer generate -w "$env:USERPROFILE\.tauri\central-sos.key"
```

O comando oficial solicita senha e cria `central-sos.key` e `central-sos.key.pub`.
Não use `--force`, não substitua um par que já assina versões distribuídas.
Escolha uma senha, proteja os arquivos no seu perfil e mantenha backup criptografado
fora do repositório, com acesso restrito. Guarde a senha em um gerenciador de senhas.
A perda da chave impede assinar updates aceitos pelos clientes existentes.

### 2. Configurar GitHub Actions

No repositório `Kaique-Lacerda/centralsos`, em Settings → Secrets and variables →
Actions, configure:

| Tipo | Nome | Conteúdo |
| --- | --- | --- |
| Variable | `CENTRAL_SOS_UPDATER_PUBLIC_KEY` | Conteúdo completo do arquivo `.key.pub` (texto Base64), não o caminho. |
| Variable | `CENTRAL_SOS_UPDATER_URL` | URL HTTPS real no formato abaixo. |
| Secret | `TAURI_SIGNING_PRIVATE_KEY` | Conteúdo completo da chave privada, somente no painel seguro do GitHub. |
| Secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Senha escolhida ao gerar a chave. |

O `GITHUB_TOKEN` é o token temporário fornecido pelo próprio workflow; não crie PAT
no frontend. O token de CI acessa drafts/uploads; a rota pública não exige token.
O runner recebe os secrets somente nos passos que precisam deles.

A chave pública é aplicada a `plugins.updater.pubkey` pelo overlay. Não é necessário
editar o TypeScript nem o arquivo base para cada publicação. Para build local com
updater, defina as duas variáveis públicas no ambiente do PowerShell; os scripts
não leem `.env`. Não forneça valores privados ao Codex.

### 3. Definir e publicar a rota HTTPS real

Formato exato obrigatório:

```text
https://<dominio-de-producao>/api/app-update
```

Sem query string, fragmento ou credenciais na URL. O domínio precisa servir o
deployment que contém `api/app-update.ts`, com TLS válido. Vercel usa a Function
TypeScript, com imports `.js` compatíveis com Node ESM. O Vite disponibiliza a mesma
rota durante desenvolvimento. Esta tarefa não publica deployment.

Antes da primeira distribuição assinada, publique a Function e configure o domínio
real no GitHub. Uma instalação antiga sem pubkey/endpoint compilados precisará ser
substituída manualmente pelo primeiro instalador configurado: ela não passa a
receber configuração só porque uma variável do GitHub foi alterada.

## Publicação explícita

A workflow `.github/workflows/release.yml` é executada por **workflow_dispatch**;
selecione **main** e uma tag nova `vMAJOR.MINOR.PATCH`. A versão já deve estar
atualizada e consistente em package.json/lock, tauri.conf.json e Cargo.toml/lock
antes de solicitar publicação. Esta tarefa conserva `0.1.0`; não permite republicar
uma tag existente, nem reutilizar uma versão menor/igual à maior estável publicada.
Uma nova versão futura precisa de autorização e versionamento em tarefa própria.

Fluxo:

1. Conferir main/commit, versão, tag nova e configuração pública.
2. Instalar dependências; validar TypeScript, Web, testes, Desktop, Core, Link e Agent.
3. `tauri-apps/tauri-action` gera NSIS x64 assinado, `.exe.sig` e `latest.json`,
   e anexa esses artefatos a uma Release **draft** da versão/commit solicitado.
4. Verificar criptograficamente o instalador local contra a chave pública compilada,
   incluindo o campo de versão do comentário assinado, usando `minisign-verify`
   (a mesma biblioteca do plugin Tauri). A CLI sozinha apenas avisa sobre chaves
   divergentes; esta etapa recusa a publicação.
5. Verificar os assets realmente enviados: JSON válido, mesma tag/versão, URLs
   oficiais e assinaturas do JSON iguais aos arquivos `.sig` publicados.
6. Somente então tornar a Release pública, normal, sem prerelease.

Uma falha depois do upload pode deixar draft/tag/artefatos para inspeção humana;
não há exclusão automática nem sobrescrita de histórico. A repetição é recusada
se a tag/Release existir; trate o estado anterior explicitamente antes de repetir.
O instalador `.exe` permanece disponível para download manual. Em Tauri 2 os
artefatos Windows são o próprio instalador e sua `.sig`; não se usa ZIP legado.
Durante a conferência do draft, o verificador considera a futura URL da tag para
os assets que o GitHub ainda identifica como `untagged-*`, como faz a Tauri Action.
As consultas autenticadas continuam usando os IDs reais da API; o `latest.json`
publicado deve apontar sempre para a tag final, nunca para `untagged-*`.

## `/api/app-update`

A rota de leitura consulta a **lista paginada** de Releases, ignora `tools-*`,
drafts, prereleases e tags inválidas e seleciona a maior versão semver canônica
do aplicativo. Não usa `/releases/latest`, datas nem ordem dos resultados.
Versões máximas duplicadas são recusadas; metadata inválida da maior versão não
faz fallback silencioso para uma versão antiga.

Reutiliza `latest.json` de sua própria Release, preservando o contrato estático
Tauri (`version`, `notes`/`pub_date` opcionais e `platforms`). Confere plataforma
Windows x64 NSIS, URLs da mesma Release e vínculo com os assets/`.sig`. Não expõe
token, não aceita URL externa enviada pelo usuário e não redistribui instaladores.

- `200`: contrato válido, cache de servidor por 60 segundos.
- `204`: nenhuma Release estável de aplicativo; sem corpo.
- `405`: método diferente de GET.
- `502`: GitHub indisponível ou artefatos inválidos; sem cache do erro.

O Desktop usa o plugin updater Rust, não fetch da WebView. A experiência existente
continua manual: verificar → mostrar versão → confirmar → baixar e validar
assinatura/versão → instalar → reiniciar. Não permite downgrade. O endpoint não
substitui a validação criptográfica no cliente.

## Limites e validação posterior

Sem as configurações reais não é possível validar assinatura com o par operacional,
workflow GitHub, TLS/Function publicada ou atualização entre dois instaladores reais.
Após configurar e autorizar publicação, teste instalação anterior → nova Release →
verificação manual → confirmação → instalação/reinício, incluindo assinatura inválida.

Este updater cobre **somente Desktop**. O Windows Service Agent tem ciclo de vida
próprio e será coordenado posteriormente. Tools e Download mantêm seus fluxos.
Warnings `@__PURE__` de Zod/Rollup são de dependências; não edite `node_modules`.

Referências oficiais: [Tauri Updater](https://v2.tauri.app/plugin/updater/),
[Tauri Action](https://github.com/tauri-apps/tauri-action),
[configuração Tauri 2](https://v2.tauri.app/reference/config/).
