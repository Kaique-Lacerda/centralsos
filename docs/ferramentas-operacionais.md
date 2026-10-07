# Ferramentas operacionais do CENTRAL SOS

Esta implementação separa suporte a um problema atual das regras de baseline da Validação. A coleta e as ações são iniciadas por solicitação do técnico. O catálogo mantém Computador, Impressoras, Rede e Serviços e acrescenta Conectividade, Firebird, Compartilhamentos, Sistema, Processos e Dependências.

## Rede

Reutiliza a coleta e a classificação de adaptadores existentes. Acrescenta Index, InterfaceIndex, NetEnabled e DHCPEnabled, necessários para correlacionar rotas e endereçar uma interface real. O inventário não foi removido: está em detalhes recolhidos.

Consulta rotas padrão IPv4, proxy manual WinINET do usuário atual, configuração padrão WinHTTP, gateway por ICMP, até quatro DNS configurados por UDP 53 e github.com por DNS/TCP 443. Os resultados destes destinos não representam toda a Internet. Sem resposta ICMP ou UDP não prova bloqueio por Firewall.

O catálogo de problemas contém os 14 IDs pedidos. APIPA, DHCP habilitado sem endereço utilizável, interface física desabilitada, mídia desconectada, ausência de gateway/DNS, falha de resolução, DNS UDP sem resposta, teste TCP externo malsucedido, proxy, múltiplas rotas e VPN desconectada são identificados com evidência. WINSOCK_SUSPECT e ROUTE_SUSPECT ficam reservados, sem resultado fabricado.

Correções: Enable de uma interface desabilitada e RenewDHCPLease para DHCP + APIPA, ambos com confirmação. Cache DNS somente se um DNS configurado respondeu diretamente e o resolver do Windows falhou, com nova consulta no backend. Proxy manual WinINET ou padrão WinHTTP é removido somente com confirmação separada; PAC/WPAD/configurações por aplicação são preservados. Não são oferecidos reset de Winsock, reinício de adaptador, alteração de DNS ou registro DNS sem evidência/regra específica que justifique a ação.

## Conectividade

Host/IP e porta opcional de 1 a 65535. Presets 3050, 445, 3389, 80 e 443. DNS com limite de 4 segundos e no máximo quatro resoluções pendentes; ICMP IPv4 com 900 ms; TCP direto em Rust com 900 ms por endereço, até quatro endereços. IPv6 pode ser resolvido e usado por TCP; ICMP IPv6 permanece não verificado.

Para destinos locais, consulta listeners IPv4 e regras de Firewall por porta TCP exata quando disponíveis. Falha na consulta de listeners não invalida DNS/TCP. Perfis, precedência, regras por intervalo e o bloqueio efetivo do Firewall não são inferidos. Nenhum Firewall é desligado.

## Serviços

Iniciar, reiniciar e parar por nome interno real; parâmetros validados no Rust. Reiniciar/parar e início de serviço fora do conjunto conhecido exigem confirmação. Serviços essenciais ficam bloqueados no backend. Inicialização desabilitada e estado transitório/desconhecido não autorizam ação. Nenhum modo de inicialização é alterado.

Verificar e corrigir inicia somente Spooler, serviços Firebird reconhecidos e Cobian reconhecido que estejam parados e habilitados. Cada falha é registrada independentemente. O Windows é consultado novamente para confirmar Running/Stopped, com limite de espera de transição de 20 segundos. A consulta WMI existente passa a executar em spawn_blocking.

## Firebird

Consulta registros Uninstall HKLM/HKCU nas duas visões, serviços, executáveis/versões PE, arquitetura quando conhecida, processos Firebird e TCP local 3050 com PID/nome do listener. Não pressupõe versão 2.5. Guardian e Server na mesma pasta não contam como duas instalações. Mais de uma pasta identificada gera aviso; registros sem caminho não comprovam múltiplas instalações físicas.

Verificar e corrigir pode iniciar os serviços conhecidos parados e habilitados. Serviço desabilitado, conflito de porta, banco ausente e diferenças de versão não são corrigidos automaticamente. O link para Instalações leva ao catálogo existente e não baixa/instala nada.

O caminho do banco é fixo: `C:\SoS Soluções\Troia\Banco\autocom.fdb`. Coleta existência de arquivo, tamanho e modificação. Permissões do token atual são consultadas por ACL/AccessCheck e atributo somente leitura, sem abrir conteúdo, SQL, repair ou restore. Isto não garante que uma aplicação conseguirá abrir o banco: bloqueio de arquivo e outras restrições permanecem não verificados.

## Compartilhamentos

Valida UNC no formato servidor/compartilhamento, sem subpastas, wildcard ou caminhos de dispositivo. Separa DNS, TCP 445, existência e acesso/listagem usando o usuário atual do Windows. Preserva códigos de acesso negado, credenciais recusadas/conexão conflitante, caminho ausente e timeout.

NetShareEnum lista apenas o servidor explicitamente informado, filtrando compartilhamentos administrativos ocultos. Até 16 páginas por consulta. As consultas têm limite de resposta de 12 segundos e no máximo duas operações nativas pendentes; uma operação do Windows que ultrapasse o prazo pode continuar no background até retornar. Não há varredura de rede nem formulário de senha.

## Sistema

Reutiliza volumes para espaço livre; alerta operacional abaixo de 2 GB ou 5%. Dados de espaço ausentes não comprovam falha física do volume. Consulta uptime, indicadores CBS/Windows Update/PendingFileRenameOperations, timezone registrado e estado do W32Time. w32tm é executado pelo caminho oficial System32 e apenas argumentos fixos de consulta ou resync. Nenhum shell ou argumento livre é exposto.

Sincronização exige confirmação, preserva timezone/fontes NTP e pode iniciar W32Time se estiver parado e habilitado. A interpretação do indicador de salto reconhece a saída em inglês/português; outros formatos ficam não verificados, com saída nos detalhes.

A amostragem de temporários cobre até 10 mil entradas e quatro níveis por raiz oficial (LocalAppData/Temp e Windows/Temp). Exclusão somente de arquivos .tmp/.temp com pelo menos sete dias, após confirmação. Não exclui diretórios, outros tipos, reparse points, junctions, arquivos readonly ou arquivos cujo acesso exclusivo falha. Usa caminho final do handle e FILE_DISPOSITION_INFO; não aceita caminho fornecido pelo frontend. Resultados informam bytes/arquivos removidos e itens preservados.

## Processos

Consulta por ação explícita, fora do MachineSnapshot inicial. Prioriza nomes conhecidos e permite pesquisar todo o inventário por nome, PID ou caminho. Mostra memória, tempo, caminho/usuário quando disponíveis. CPU permanece não verificada porque a coleta não mede um intervalo de utilização.

Múltiplas instâncias são informativas. Ausência esperada/caminho divergente só são avaliáveis quando os helpers receberem uma configuração explícita; não foi inventado requisito do Tróia. Reiniciar aplicação permanece para um futuro comando dedicado a executáveis autorizados.

Encerrar exige PID, nome e tempo de criação esperados + confirmação. Rust revalida pelo mesmo handle, usa IsProcessCritical, protege o próprio app, denylist e executáveis de System32/SysWOW64, e confirma a saída. Não aceita wildcard, linha de comando ou encerramento em massa.

## Dependências

Consulta WebView2 por registro EdgeUpdate; .NET Framework por NDP; .NET Desktop Runtime por registros de versões instaladas e Uninstall; Visual C++ Redistributable por Uninstall. Versão, arquitetura e localização só aparecem quando encontrados. A visão de registro, sozinha, não é usada como arquitetura do executável. Instalações portáteis/sem registro podem não ser detectadas.

Não declara compatibilidade do Tróia nem uma versão requerida. Link para Instalações é mostrado quando a dependência ausente tem correspondência no catálogo publicado. A ausência/erro do catálogo não impede o inventário local.

## Novos comandos Tauri

- support_get_network
- support_test_connectivity
- support_network_action
- support_service_action
- support_get_firebird
- support_test_share
- support_list_shares
- support_get_system
- support_cleanup_temp
- support_sync_time
- support_get_processes
- support_terminate_process
- support_get_dependencies

Todos os comandos novos executam trabalho bloqueante fora da thread de UI. A Web não invoca comandos Windows e não simula resultados locais. Não foram adicionados banco, backend remoto, autenticação, shell arbitrário, instalador automático ou configuração de Firewall.

## Arquivos desta implementação

Criados:

- src/types/support.ts
- src/support-tools.css
- src/services/support/SupportService.ts
- src/services/support/SupportInterpretation.ts
- src/services/support/SupportRepair.ts
- src/services/support/NetworkKnownIssues.ts
- src/services/support/tests/SupportTools.test.mjs
- src/pages/tests/OperationalTools.test.mjs
- src/pages/support/SupportUI.tsx
- src/pages/support/NetworkOperationsPanel.tsx
- src/pages/support/ConnectivityPage.tsx
- src/pages/support/FirebirdPage.tsx
- src/pages/support/SharesPage.tsx
- src/pages/support/SystemPage.tsx
- src/pages/support/ProcessesPage.tsx
- src/pages/support/DependenciesPage.tsx
- src-tauri/src/commands/support.rs
- crates/core/src/models/support.rs
- crates/core/src/services/support/mod.rs
- crates/core/src/services/support/connectivity.rs
- crates/core/src/services/support/network.rs
- crates/core/src/services/support/services.rs
- crates/core/src/services/support/firebird.rs
- crates/core/src/services/support/shares.rs
- crates/core/src/services/support/system.rs
- crates/core/src/services/support/processes.rs
- crates/core/src/services/support/dependencies.rs
- crates/core/src/services/support/windows.rs
- docs/ferramentas-operacionais.md

Alterados para integração:

- package.json (somente incluir os novos testes no script)
- src/app/App.tsx (novas páginas/rotas, preservando a navegação já alterada)
- src/pages/Pages.tsx (catálogo de dez cards/ícones)
- src/pages/ComputerDiagnosticPage.tsx (título Computador)
- src/pages/NetworkDiagnosticPage.tsx
- src/pages/WindowsServicesDiagnosticPage.tsx
- src/services/windows-services/WindowsServicePresentation.ts
- src/tools/registry.ts
- packages/contracts/machine.ts (campos de rede adicionais)
- src-tauri/src/commands/mod.rs
- src-tauri/src/commands/windows_services.rs
- src-tauri/src/lib.rs
- crates/core/src/models/mod.rs
- crates/core/src/models/machine.rs
- crates/core/src/services/mod.rs
- crates/core/src/services/network.rs
- crates/core/src/services/installation.rs (somente visibilidade de dois helpers PE existentes)

Os arquivos de navegação ocultada anteriormente permanecem locais e preservados. Implementação de Impressoras, coletor de Impressoras, catálogo/downloads de Tools e regras da Validação não foram reescritos.

## Validação manual pendente no Windows

### Validações automatizadas executadas

- `npm.cmd run typecheck`: passou.
- `npm.cmd run build`: passou; build Web gerado em `dist/`.
- `npm.cmd run test:validation`: 208 testes passaram, incluindo 28 testes de lógica/serviços operacionais e 3 testes de cards/rotas das novas ferramentas.
- `npm.cmd run test:tools`: 24 testes passaram.
- `cargo check --manifest-path src-tauri/Cargo.toml`, usando o Cargo de `%USERPROFILE%\.cargo\bin`: passou.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib services::support::`: 10 testes Rust passaram. São testes de parâmetros, políticas, interpretação e pacotes simulados; não alteram a máquina.
- `git diff --check`: passou.

Branch preservada: `feature/network-diagnostic`. HEAD permaneceu `a63cae02a0236e3c5c27df88bd9f6995b2272f89`. Nenhum commit, push, merge ou alteração de versão foi realizado. Não foi gerado instalador nesta tarefa.

### Cenários reais que o técnico precisa testar

Os testes automatizados usam fixtures, mocks e funções puras. Não executam ações reais nas áreas abaixo:

- NIC desabilitada/APIPA, renovação DHCP com aviso de possível perda de suporte remoto, DNS configurado sem resposta e proxy manual deliberadamente configurado.
- Destino TCP conhecido aberto/fechado e ICMP bloqueado; conferir listeners e regras retornadas na própria máquina.
- Início de um serviço de teste e confirmação de restart/stop; comprovar recusa para serviços essenciais/desabilitados.
- Firebird real, versões/pastas, listener 3050, conflito deliberado em ambiente de teste e permissões do banco sem abrir seu conteúdo.
- UNC existente/inexistente, acesso negado e conflito de credencial; listar apenas um servidor autorizado.
- Temporários de teste: arquivo elegível, arquivo novo, readonly, em uso e junction; comparar estimativa, bytes removidos e arquivos preservados.
- Relógio/W32Time e idioma real do Windows, após confirmação manual.
- Processo descartável para término; comprovar bloqueio de crítico e mudança de identidade/PID.
- Runtimes reais registrados e versões/arquiteturas; conferir instalações não registradas separadamente.
- Conferir visualmente cards, detalhes recolhidos e diálogos no Desktop. A Web foi coberta por renderização/rotas em testes, sem coletas locais.

## APIs consultadas

ICMP usa a API documentada em [IcmpSendEcho](https://learn.microsoft.com/en-us/windows/win32/api/icmpapi/nf-icmpapi-icmpsendecho). A ausência de resposta é apresentada separadamente do teste TCP.

Compartilhamentos são enumerados pela API oficial [NetShareEnum](https://learn.microsoft.com/en-us/windows/win32/api/lmshare/nf-lmshare-netshareenum).

A proteção de processos usa [IsProcessCritical](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-isprocesscritical) além das validações locais.

As permissões do banco são consultadas por [AccessCheck](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-accesscheck), sem testar leitura/escrita de conteúdo.
