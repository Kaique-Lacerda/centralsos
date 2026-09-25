# CENTRAL SOS

Aplicação interna para organizar ferramentas de suporte técnico, com uma interface compartilhada entre Web e Desktop Windows. Esta etapa oferece a fundação de navegação, catálogo, configuração local, validação inicial e um diagnóstico explícito do sistema no Desktop.

## Arquitetura

React + TypeScript renderiza a interface. Os serviços TypeScript intermediam o runtime e chamam somente comandos Tauri nomeados. Tauri 2 (Rust) implementa comandos permitidos explicitamente; não há executor genérico de shell. `MachineEnvironment` é guardado no `localStorage` do dispositivo. Não há backend, banco de dados ou autenticação real.

## Stack e ambientes

- React, TypeScript, Vite, React Router
- Tailwind CSS e Lucide React
- Tauri 2, Rust, `sysinfo` e WMI tipado (`wmi`, somente Windows)
- Web: interface, catálogo, validações pendentes e página de download sem URL publicada.
- Desktop: mesma interface; `get_machine_snapshot` consulta sistema, discos, adaptadores e impressoras sob demanda. A resposta preserva erros parciais por seção.

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

O bundle Windows está configurado para NSIS e MSI. A configuração `src-tauri/tauri.conf.json` usa o nome de produto CENTRAL SOS. A distribuição e URL de release não foram configuradas.

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
src/services/validation/ Motor, registry, regras por domínio e resumo
src/services/{processes,windows}/  Reservas de serviços
src/services/support/    Abstração mock claramente identificada
src/services/logs/       Logger leve para console
src/types/               Tipos compartilhados
src-tauri/src/commands/  Comandos Rust expostos ao frontend
src-tauri/src/models/    Contratos Rust serializados como MachineSnapshot
src-tauri/src/services/  Coleta WMI específica por área
src-tauri/capabilities/  Permissões Tauri mínimas
```

## Adicionar uma ferramenta

1. Registre id, descrição, categoria, rota, ambientes e estado `enabled` em `src/tools/registry.ts`.
2. Crie a página e registre sua rota em `src/app/App.tsx`.
3. Para ferramentas exclusivas do Desktop, valide runtime no gate e trate a rota Web com uma mensagem explicativa.
4. Implemente acesso local em serviço específico; nunca aceite nome de comando vindo de entrada arbitrária do usuário.

## Adicionar comando Tauri

Implemente uma função Rust específica em `src-tauri/src/commands/`, registre o módulo e a função em `src-tauri/src/lib.rs`, e crie uma chamada tipada em um serviço React. Não exponha execução arbitrária de CMD, PowerShell ou shell.

## Adicionar validação

Adicione uma regra com id, título, categoria, perfis aplicáveis e `validate(snapshot)` em `src/services/validation/rules/`. Registre-a em `ValidationRegistry.ts`. `ValidationEngine` executa regras independentes, converte exceções isoladas em erro e calcula o resumo; componentes React apenas solicitam a execução e exibem os resultados. Use status `success`, `warning`, `error` ou `skipped`, severidade `info`, `warning` ou `error`, e inclua `expected`, `actual` e `suggestedAction` quando fizer sentido.

## Estado desta fundação

As páginas de Instalações e Favoritos são estruturas iniciais; os serviços de processos e Windows continuam reservados. O mock de suporte não autentica ninguém. O dashboard só mostra estado “não verificado” quando não há dados. Configure uma URL central de release quando houver um artefato publicado; nenhuma URL fictícia é incluída.

## Coleta MachineSnapshot

O snapshot é obtido manualmente por `MachineSnapshotService.getSnapshot()`. O comando `get_machine_snapshot` lê hostname, usuário e arquitetura, e consulta via WMI sistema operacional, versão/build, fabricante/modelo, CPU, RAM, BIOS, volumes lógicos, adaptadores/IP/gateway/DNS e impressoras. Uma falha em uma consulta fica indicada na seção correspondente sem descartar as demais. Serviços e processos não são listados; há apenas tipos para consultas futuras direcionadas.
