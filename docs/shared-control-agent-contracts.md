# Contratos e regras neutros de Control/Agent

Base desta extração: main `fb04807` (PR #14). Nenhum entrypoint de produto,
comando remoto, contrato serializado ou regra de autorização foi alterado.

## Inventário anterior à movimentação

| Origem | Papel e consumidores | Destino/decisão |
| --- | --- | --- |
| `src/agent/RulesRuntime.ts` | Dispatcher tipado, compilado por esbuild e incorporado no Agent | `packages/agent-rules/RulesRuntime.ts` |
| `src/control/contracts.ts` | Schemas Zod, comandos/resultados, enrollment, heartbeat, perfis, topologia e estado; Backend, Control e testes | `packages/contracts/control/contracts.ts` |
| `src/control/CommandPolicy.ts`, `command-policy.json` | Allow-list única, confirmação, contexto, perfis, timeout e operações; TypeScript e Rust Link | `packages/contracts/control/` |
| `src/control/SessionHelperContract.ts` | Contrato serializável de IPC e validação de mensagens; testes de Helper/Control | `packages/contracts/control/SessionHelperContract.ts` |
| `src/control/ruleset.ts` | Metadados futuros, sem consumidor atual; não faz parte do bundle Agent | Permanece no frontend nesta extração |
| `src/types/machine.ts`, `printer-diagnostic.ts` | Contratos de coleta e operações usados pelo Agent e Desktop | `packages/contracts/` |
| `src/types/index.ts` | Perfil + configuração local, runtime, logs e definição de ferramentas | Somente `MachineRole` extraído para `packages/contracts/profile.ts`; reexport sem cópia |
| `src/types/support.ts` | Contratos das ferramentas locais de suporte, não usados pelo Agent | Permanece no frontend |
| `src/services/validation/types.ts` | Resultados, contexto e contratos de instalação usados pelo Desktop/Agent | `packages/contracts/validation.ts` |
| `ValidationEngine.ts`, `ValidationRegistry.ts` | Execução, seleção, resumo e agrupamento puros; Desktop/Agent | `packages/agent-rules/validation/` |
| `rules/baseline/{system,resources}.ts`, `rules/terminal/baseline.ts`, `rules/server/installation.ts` | Regras puras sobre dados coletados; Desktop/Agent | `packages/agent-rules/validation/rules/` |
| `runMachineValidation.ts`, `installation/InstallationSnapshotService.ts` | Orquestração da configuração local e coleta Tauri | Permanecem no frontend |
| `PrinterAutoFix.ts`, `PrinterHealth.ts`, `PrinterKnownIssues.ts`, `PrinterPresence.ts` | Decisões e pipeline compartilhados, sem transporte/UI; recebem dados e cliente tipado | `packages/agent-rules/printers/` |
| `PrinterCorrections.ts` | Plano e execução de correções locais; Agent usava apenas serialização do diagnóstico | Permanece; somente `diagnosticRecord` extraído para `PrinterDiagnosticRecord.ts` |
| `PrinterService.ts`, `PrinterActionClient.ts` | Adaptadores das ações locais Tauri | Permanecem no frontend |
| `PrinterQueueMonitor.ts`, `PrinterQueryCoordinator.ts`, `PrinterPresenceMonitor.ts` | Monitoramento/coordenadores do produto local | Permanecem no frontend |
| `PrinterPresentation.ts` | Presenter e decisões de apresentação | Permanece no frontend |
| `PrinterDiagnostic.ts`, `PrinterConnections.ts`, `PrinterOperations.ts` | Diagnóstico local, UNC/discovery e disponibilidade de ações do produto | Permanecem no frontend |
| Testes em `src/services/{validation,printers}/tests` | Exercitam regras compartilhadas e produto local | Permanecem; imports das regras apontam para packages |
| `scripts/build-agent-rules.mjs` | Build-time esbuild invocado por Cargo | Permanece em scripts, consumindo somente packages neutros |

## Estrutura

Antes:

```text
src/
  agent/RulesRuntime.ts
  control/{contracts,CommandPolicy,SessionHelperContract}.ts
  control/command-policy.json
  services/validation/ (regras + coleta/orquestração)
  services/printers/ (regras + ações/monitoramento/presenter)
  types/ (contratos + configuração do frontend)
```

Depois:

```text
packages/
  contracts/
    control/{contracts,CommandPolicy,SessionHelperContract}.ts
    control/command-policy.json
    {machine,printer-diagnostic,profile,validation}.ts
  agent-rules/
    RulesRuntime.ts
    validation/{ValidationEngine,ValidationRegistry}.ts
    validation/rules/{baseline,terminal,server}/
    printers/{PrinterAutoFix,PrinterHealth,PrinterKnownIssues,
              PrinterPresence,PrinterDiagnosticRecord}.ts
src/
  pages/                        UI preservada
  services/control/             transporte Control preservado
  services/printers/            ações/monitoramento/presenter locais
  services/validation/          coleta/orquestração locais
  types/{index,support}.ts       contratos exclusivos do frontend
scripts/build-agent-rules.mjs
```

Os diretórios packages são módulos-fonte, sem novos workspaces npm, aliases,
dependências instaladas ou publicação de pacotes. Imports relativos funcionam
com Vite, tsc, esbuild e Node. Imports server-side preservam specifiers `.js`.

## Consumidores e segurança

Backend (`server/control`) e Control (`src/pages/control`, `src/services/control`)
importam a mesma fonte em `packages/contracts/control/contracts`. Rust Link
incorpora exatamente `packages/contracts/control/command-policy.json`.
A policy, os nove comandos e os bloqueios existentes permanecem idênticos.
O caminho do include Rust mudou; o conteúdo JSON não mudou.

Cargo observa `packages/contracts`, `packages/agent-rules` e o script de build.
O builder verifica o grafo real via metafile e recusa inputs fora desses dois
diretórios antes de gravar `OUT_DIR/rules.js`. O Agent incorpora esse código
no binário como antes. Não consome nenhuma fonte do frontend `src/`.
Ainda requer Node/esbuild e as dependências do repositório durante o build.

Printer AutoFix continua recebendo um cliente tipado; não fornece shell,
transporte nem novas operações. No Service, os comandos que exigem usuário
continuam bloqueados/delegados conforme a policy atual, sem fallback SYSTEM.
Pipe, ACL, trusted image, journal, vault, DPAPI e protocolo Rust não mudaram.

## Testes e próximos limites

`tests/control/SharedArchitecture.test.mjs` verifica o build real, imports de
tipos, unicidade da policy, consumo comum Backend/Control, ausência de cópias
no frontend, ausência de executor genérico e preservação dos adaptadores locais.
Os testes funcionais existentes continuam junto de suas funcionalidades.

O próximo PR poderá separar entrypoints Cliente, Suporte e Web, reutilizando
estes módulos e o Core independente. O frontend atual ainda reúne esses
produtos; essa separação e o lifecycle de instalação não fazem parte deste PR.
