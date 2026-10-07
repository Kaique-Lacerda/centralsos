# CENTRAL SOS

Aplicação interna para suporte técnico, pensada como aplicativo desktop Windows (.exe) e não como serviço público acessível pela web. O ambiente browser existe apenas como prévia de desenvolvimento e visualização da interface; a coleta de dados do sistema local só é permitida no runtime desktop.

## Arquitetura

React + TypeScript renderiza a interface. Os serviços TypeScript intermediam o runtime e chamam somente comandos Tauri nomeados. Tauri 2 (Rust) implementa comandos permitidos explicitamente; não há executor genérico de shell. `MachineEnvironment` é guardado no `localStorage` do dispositivo. Não há backend, banco de dados ou autenticação real.

## Stack e ambientes

- React, TypeScript, Vite, React Router
- Tailwind CSS e Lucide React
- Tauri 2, Rust, `sysinfo` e WMI tipado (`wmi`, somente Windows)
- Browser/dev: apenas visualização da interface e navegação sem acesso aos dados locais.
- Desktop: coleta real de sistema, discos, rede, impressoras e validações locais em Windows. A resposta preserva erros parciais por seção.

## Executar

Requer Node.js/npm. Para o Desktop Windows, instale também Rust (MSVC), dependências de build do Tauri e WebView2 conforme a documentação oficial do Tauri.

```sh
npm install
npm run dev
npm run typecheck
npm run build
npm run tauri:dev
npm run tauri:build
```

O build local Windows está configurado para NSIS e MSI. A publicação oficial usa NSIS x64 assinado e exige configuração externa real do updater. Consulte [Releases e atualização do Desktop](docs/releases-updater.md) para os comandos, GitHub Actions, chaves e `/api/app-update`.

## Colaboração com Git

Depois que o responsável pelo repositório compartilhar a URL do GitHub, clone o projeto e instale as dependências:

```sh
git clone <URL_DO_REPOSITORIO>
cd <PASTA_DO_PROJETO>
npm install
```

Para trabalhar em uma alteração, atualize a branch principal, crie uma branch própria e envie-a para revisão:

```sh
git pull --rebase
git switch -c feature/nome-da-alteracao
git status
git add <arquivos-da-alteracao>
git commit -m "Descreve a alteração"
git push -u origin feature/nome-da-alteracao
```

Use `npm run dev` para desenvolvimento Web, `npm run tauri:dev` para Desktop Windows e `npm run build` para validar o build Web. Não adicione arquivos `.env` ou credenciais ao Git; use `.env.example` apenas com nomes de variáveis e valores fictícios/não secretos.

## Estrutura

```text
src/app/                 Rotas e gates por runtime
src/components/          Shell e navegação
src/pages/               Dashboard e páginas iniciais
src/tools/               Registry central de ferramentas
src/services/runtime/    Runtime e configuração local
src/services/system/     Diagnóstico e regras de validação
src/services/snapshot/   Entrada tipada para o snapshot da máquina
src/services/{network,printers,storage}/  Projeções do snapshot
src/services/validation/ Coleta e orquestração local de validação
src/services/{processes,windows}/  Reservas de serviços
src/services/support/    Abstração mock claramente identificada
src/services/logs/       Logger leve para console
src/types/               Tipos exclusivos do frontend e reexport do perfil
packages/contracts/      Contratos/policy comuns ao Agent, Backend e frontend
packages/agent-rules/    Motor, registry e regras puras incorporadas no Agent
src-tauri/src/commands/  Comandos Rust expostos ao frontend
crates/core/src/models/  Contratos Rust serializados como MachineSnapshot
crates/core/src/services/ Coleta e operações Windows independentes do Tauri
src-tauri/src/services/  Integrações Desktop: Channel da fila e ferramentas administrativas
src-tauri/capabilities/  Permissões Tauri mínimas
```

## Core Rust e adapters Desktop

O `central-sos-core` possui fontes próprias em `crates/core/src` e não depende do
Tauri. O Desktop reexporta seus modelos e serviços para preservar os commands
existentes; Agent continua consumindo o mesmo crate. A feature `desktop` do Core
é mantida como opção vazia de compatibilidade com comandos de teste existentes.
Os testes do serializer IPC e o monitor `tauri::ipc::Channel` ficam no Desktop.
O build de regras TypeScript do Agent usa somente `packages/contracts` e
`packages/agent-rules`, sem fontes do frontend. Consulte
[Contratos e regras compartilhados](docs/shared-control-agent-contracts.md)
para o inventário e os limites desta separação.

## Adicionar uma ferramenta

1. Registre id, descrição, categoria, rota, ambientes e estado `enabled` em `src/tools/registry.ts`.
2. Crie a página e registre sua rota em `src/app/App.tsx`.
3. Para ferramentas exclusivas do Desktop, valide runtime no gate e trate a rota Web com uma mensagem explicativa.
4. Implemente acesso local em serviço específico; nunca aceite nome de comando vindo de entrada arbitrária do usuário.

## Adicionar comando Tauri

Implemente uma função Rust específica em `src-tauri/src/commands/`, registre o módulo e a função em `src-tauri/src/lib.rs`, e crie uma chamada tipada em um serviço React. Não exponha execução arbitrária de CMD, PowerShell ou shell.

## Adicionar validação

Adicione uma regra com id, título, categoria, perfis aplicáveis e `validate(snapshot)` em `packages/agent-rules/validation/rules/`. Registre-a em `ValidationRegistry.ts`. `ValidationEngine` executa regras independentes, converte exceções isoladas em erro e calcula o resumo; componentes React apenas solicitam a execução e exibem os resultados. Use status `success`, `warning`, `error` ou `skipped`, severidade `info`, `warning` ou `error`, e inclua `expected`, `actual` e `suggestedAction` quando fizer sentido.

## Estado desta fundação

As páginas de Instalações e Favoritos são estruturas iniciais; os serviços de processos e Windows continuam reservados. O mock de suporte não autentica ninguém. O dashboard só mostra estado “não verificado” quando não há dados. Configure uma URL central de release quando houver um artefato publicado; nenhuma URL fictícia é incluída.

## Coleta MachineSnapshot

O snapshot é obtido manualmente por `MachineSnapshotService.getSnapshot()`. O comando `get_machine_snapshot` lê hostname, usuário e arquitetura, e consulta via WMI sistema operacional, versão/build, fabricante/modelo, CPU, RAM, BIOS, volumes lógicos, adaptadores/IP/gateway/DNS e impressoras. Uma falha em uma consulta fica indicada na seção correspondente sem descartar as demais. Serviços e processos não são listados; há apenas tipos para consultas futuras direcionadas.
