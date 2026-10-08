# Cliente, Suporte e Web público

## Separação

Antes, `src/main.tsx → App → Shell` reunia ferramentas locais, distribuição e
Control no mesmo frontend. Agora cada produto tem entrypoint, router e shell
próprios. Vite seleciona o grafo no build; não há seleção por URL, CSS ou import
dinâmico de outro produto.

```text
src/apps/client/   main → ClientApp → ClientRouter → ClientShell
src/apps/support/  main → SupportApp → SupportRouter → SupportShell
src/apps/web/      main → WebApp → WebRouter → WebShell
src/apps/product.ts                  produto + host/runtime
src/components/distribution/        download Cliente e catálogo público
src/components/confirmation/        confirmação genérica
src/services/control/ControlBrowserTransport.ts  transporte/auth Web do Suporte
src/services/distribution/products.ts            disponibilidade dos produtos
config/products.ts                  entrypoints, portas e outputs explícitos
```

As páginas e serviços de domínio continuam em seus diretórios. `src/app/App.tsx`,
`src/app/navigation.ts` e `src/components/Shell.tsx` são reexports de compatibilidade
do Cliente; nenhum frontend público ou Suporte os importa. `src/main.tsx` também
permanece como entrada legada do portal. A configuração Vite substitui esse
specifier no HTML por um dos três entrypoints explícitos.

## Ownership e rotas

| Produto | Rotas | Responsabilidade |
| --- | --- | --- |
| Cliente | `/`, `/tools`, `/tools/*` do registry | Dashboard e diagnósticos/ferramentas locais, incluindo Diagnóstico Geral |
| Cliente | `/validation`, `/installations`, `/settings`, `/download` | Conformidade, catálogo com detecção local, configuração, enrollment/status do Agent, updater e download existente |
| Cliente | `/favorites`, `/support` | Compatibilidade: redirecionam para `/` como antes |
| Suporte | `/control` (`/` redireciona para ela) | Control existente: ambientes, dispositivos, topologia, pairing, comandos, resultados e estados |
| Web público | `/` | Portal de distribuição |
| Web público | `/download/client`, `/download/support`, `/tools` | Cliente oficial, Suporte indisponível, catálogo homologado |
| Web público | `/download`, `/installations` | Aliases para `/download/client` e `/tools` |

Cliente e Web não registram `/control`: acesso direto cai no redirect para `/`.
Rotas locais do Cliente também não existem no Web/Suporte. O inventário de APIs
permanece independente: `/api/control/*`, `/api/agent/*`, `/api/tools-manifest`
e `/api/app-update` não foram removidos nem tiveram sua implementação alterada.

## Builds e desenvolvimento

| Comando | Produto | Output / porta |
| --- | --- | --- |
| `npm run dev:client` (também `npm run dev`) | Prévia do Cliente | 1420 |
| `npm run dev:support` | Prévia Web do Suporte | 1421 |
| `npm run dev:web` | Portal público | 1422 |
| `npm run build:client` | Cliente | `dist/client` |
| `npm run build:support` | Suporte | `dist/support` |
| `npm run build:web` (também `npm run build`) | Web público | `dist/web` |
| `npm run tauri:dev` / `npm run tauri:build` | Tauri Cliente existente | Usa dev/build Cliente explicitamente |

O Tauri aponta para `../dist/client`, com `devUrl` em `localhost:1420`.
Identifier, produto do instalador, bundle, versão e updater não mudaram.
O workflow de release permanece intacto: a ação Tauri executa o
`beforeBuildCommand` do Cliente. Não existe segundo Tauri/installer/updater.

`vercel.json` fixa `build:web` e `dist/web`. O fallback SPA exclui `/api`;
Functions e arquivos têm prioridade sobre o fallback. As Functions continuam
usando as mesmas fontes do Backend. Publicar este PR é necessário para mudar o
site em produção; a configuração local não confirma deployment remoto.

## Dependências e distribuição

- Cliente pode importar bridges Tauri, serviços Windows, enrollment e updater.
- Suporte importa Control e contracts compartilhados; não importa ferramentas
  Windows, `SupportUI` local, enrollment nem APIs Tauri.
- Web importa somente UI pública, serviços de Releases/Tools e metadata de
  distribuição. Não importa Control ou serviços locais do Windows.
- A confirmação foi extraída do `SupportUI` para um hook genérico sem runtime
  local. Os shells não são compartilhados.
- `packages/contracts`, `packages/agent-rules` e o Core independente permanecem
  inalterados; Agent e Session Helper não mudaram.

Download Cliente mantém seleção/validação de Releases oficiais e assets existentes.
Suporte fica **Em desenvolvimento**, sem URL nem consulta/reuso do instalador
Cliente. Um futuro contrato de distribuição deverá identificar explicitamente
produto/plataforma; não escolher o primeiro setup para inferir o produto.

Tools conserva validação do manifesto, vínculo exato com assets e restrição de
origem. Seu serviço neutro recebe runtime explicitamente: Web usa a rota
`/api/tools-manifest`; o adaptador Cliente preserva o caminho Desktop existente.
O cache também distingue runtimes. O portal não detecta instalações da máquina;
essa detecção permanece somente no wrapper Cliente. Os downloads seguem as URLs
oficiais e não executam instaladores automaticamente.

## Autenticação e próximo passo

Suporte é atualmente **web-preview**, não um Desktop fingido. O transporte
`ControlBrowserTransport` conserva `/api/control`, cookies `same-origin`, login
em `/api/control/auth/login` e callback `/control`. Para executar a prévia com
login, é preciso o Backend/OIDC/banco já configurados e a origem/callback
compatíveis. Em desenvolvimento Vite preserva o proxy para `control:dev` (1431).

O portal público não hospeda a UI `/control`; publicar somente `dist/web` não
publica a prévia do Suporte. Um host do Suporte deverá servir `dist/support` e
as APIs na origem de autenticação apropriada. Esta mudança não modifica o Backend
nem resolve essa configuração de infraestrutura.

Cookies e callback Web não bastam para autenticação Tauri nativa. Esse é um
bloqueio explícito antes de criar o app Suporte. Não há client secret embarcado,
reuso de credential Agent ou workaround. Próximo PR recomendado: definir o
contrato de autenticação nativa do Suporte (login, retorno, armazenamento seguro,
expiração/revogação) e sua origem de API; só depois criar o segundo app Tauri.

## Testes

`tests/control/ProductArchitecture.test.mjs` usa grafos reais do esbuild,
match de rotas, renderização do portal, configuração Vite efetiva, auth mock e
configuração Tauri/Vercel. `SharedArchitecture.test.mjs` continua garantindo
neutralidade de contracts/regras/Core. Os testes de Tools cobrem runtime
explícito, URLs preservadas e isolamento do cache, sem GitHub real.
