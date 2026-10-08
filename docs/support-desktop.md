# CENTRAL SOS Suporte Desktop

## Produto e estrutura

O técnico usa **CENTRAL SOS Suporte**, um Tauri 2 independente em `src-tauri-support/`, com frontend `src/apps/support/` e saída `dist/support/`. Identifier `br.com.centralsos.support`; executável `central-sos-support.exe`. A versão inicial local do Suporte é 0.1.0: não é uma distribuição publicada, nem a versão pública 0.2.0 do Cliente.

O manifesto Windows é `asInvoker` e preserva a dependência Common Controls v6 do Tauri. O instalador opcional NSIS é por usuário (`currentUser`). Não há instalação de Agent/Helper, comandos de administração local, plugin updater, shell, HTTP ou filesystem exposto ao frontend. Apenas os ícones neutros existentes são compartilhados. Cliente (`src-tauri`, `br.com.centralsos.desktop`) e portal público permanecem separados.

```text
React Suporte → comandos IPC tipados → Rust Suporte
                                       ↓ HTTPS autenticado
                                  Backend / Control
                                       ↑ HTTPS outbound / polling
                                  Agent no Cliente
                                       ↓ Named Pipe autenticado
                                  Session Helper
```

## Comandos Rust e contratos

As únicas permissões da janela `main` são:

- `support_status`: estado local sanitizado, sem rede;
- `support_login_start`: gera prova e abre a autorização validada;
- `support_login_poll`: verifica aprovação respeitando intervalo/expiração;
- `support_login_complete`: exige confirmação explícita da identidade;
- `support_session`: revalida a sessão com o Backend;
- `support_logout`: apaga imediatamente a credencial e tenta revogar remotamente;
- `support_control`: dispatcher `environments`, `devices`, `device`, `command`, `send`, `pair`.

Não existe comando genérico de URL, cabeçalho, path, executável ou script. O Rust aplica sua própria whitelist e valida UUID, payload e confirmação obrigatória pela matriz compartilhada `packages/contracts/control/command-policy.json`. O Backend continua impondo autorização por operador/empresa/perfil e estado do dispositivo. `SupportDesktop.ts` contém os contratos IPC e valida os resultados usando os tipos de Control existentes, sem criar outro domínio.

## Autenticação e armazenamento

1. **Entrar** gera 32 bytes aleatórios com `OsRng`, verifier base64url e challenge SHA-256/S256 no Rust.
2. O host chama `/api/control/auth/native/start`; verifica versão, TTL, código e URL exata no Backend configurado.
3. Somente essa URL de autorização pode abrir no navegador padrão via API Windows. Não há WebView de login nem cópia de cookies.
4. A UI mostra o código de conferência. O polling respeita o intervalo tanto no React quanto no Rust, expira a transação e não faz resgate automático.
5. Após autorização no navegador, a UI mostra o nome e exige **Confirmar identidade e entrar**.
6. O host resgata com o `expectedSubject` guardado internamente, consome a tentativa local uma única vez e verifica a sessão/identidade/expiração antes de habilitar Control. Se a resposta se perder, é necessário novo login.

TransactionId, deviceCode, verifier e Bearer nunca atravessam IPC para React. O Bearer `sos_operator_…` fica exclusivamente na memória Rust, protegido por `Zeroizing`, sem arquivo, storage browser, token Agent ou client secret. Reiniciar exige login novamente. A UI recebe estado, nome, expiração, código de conferência, origem não sensível e erros seguros.

O logout remove a credencial antes da chamada HTTP; chamadas subsequentes falham localmente, e resultados de sessão anterior são descartados por geração. Falha na revogação é avisada explicitamente: a sessão remota poderá continuar válida até expiração. Credenciais obtidas durante uma conclusão cancelada também têm revogação tentada.

## HTTP e sessão

`reqwest`/Rust usa apenas HTTPS com verificação TLS padrão, origem fixa lida na inicialização, redirects desabilitados, timeout total 12 s e conexão 5 s. O corpo é limitado **durante a leitura** a 2 MB, inclusive sem Content-Length. Mensagens HTTP não confiáveis não são repassadas; 401, 403, 429 e 503 possuem códigos seguros. Não há logs de corpos, cookies, tokens ou URLs de autenticação.

Respostas de autenticação são DTOs Rust tipados. Respostas de domínio são JSON limitado, passam pelo filtro nativo de campos de credencial e pela validação de contratos compartilhados no adapter antes de chegarem a ControlPage. Não se aceita retorno contendo o Bearer local. O dispatcher nunca expõe endpoints de emissão de credencial.

`createControlApi` e `createControlNativeTransport` são reutilizados. `SupportDesktopBridge` converte requests lógicos em operações IPC; não transmite a URL/cabeçalhos que o contrato interno de transporte usa. A origem do React não escolhe o destino Rust. A prévia Web do Suporte conserva transporte same-origin; o portal público não contém Control.

A UI tem estados não configurado, indisponível, sem autorização, login pendente, confirmação de identidade, login/sessão expirados, autenticado e revogação pendente. Control só monta após autenticação. Mantém ambientes, dispositivos, topologia, pairing, comandos conhecidos, confirmações, polling, resultados e histórico. Sem ambientes, mostra a mensagem existente; dispositivos offline não recebem comandos. O Desktop não consulta o GitHub pela WebView para comparar versões do Cliente: a versão publicada aparece como não confirmada, sem fingir atualidade. Isso não altera o Download nem o updater do Cliente.

O estado local é consultado a cada segundo sem HTTP; login respeita intervalo do servidor; sessão é revalidada a cada 60 s e em chamadas autenticadas no Backend. Expiração/revogação remove a credencial e desmonta Control. Não há renovação silenciosa.

## Configuração real necessária

Nenhum domínio padrão foi inventado. No Windows, configure somente a origem pública real em:

`%APPDATA%\br.com.centralsos.support\backend.json`

Formato (substitua o placeholder pela origem validada; **não use literalmente**):

```json
{"origin":"https://<host-real-do-control>"}
```

O arquivo não contém segredo. HTTPS canônico, sem usuário/senha, path, query ou fragment; porta HTTPS explícita é aceita. O host lê no início, não possui comando IPC para alterar o arquivo ou destino. Arquivo ausente/inválido resulta em **Backend não configurado**. Depois de configurar, reinicie.

Login real exige Backend publicado por HTTPS, PostgreSQL e migrações Control/NativeAuth aplicadas, OIDC configurado com callback `/api/control/auth/native/callback`, usuário habilitado e memberships válidos. Credenciais OIDC/PG pertencem ao Backend, nunca ao Suporte. Não foi necessário criar chave updater para este produto.

## Desenvolvimento, testes e build

```powershell
npm run support:dev
npm run support:check
npm run support:test
npm run support:build
```

**Comando único do executável de produção local:** `npm run support:build` (frontend + Tauri, sem bundle/updater).

**Comando único do instalador local opcional:** `npm run support:bundle` (frontend + Tauri + NSIS currentUser).

Saídas relativas à raiz:

- `src-tauri-support/target/release/central-sos-support.exe`;
- opcional: `src-tauri-support/target/release/bundle/nsis/CENTRAL SOS Suporte_0.1.0_x64-setup.exe`.

Na máquina de desenvolvimento atual, executável:

`C:\Users\Suporte3\Desktop\DEV\CENTRAL SOS\src-tauri-support\target\release\central-sos-support.exe`

Os scripts resolvem Cargo em `%USERPROFILE%\.cargo\bin` se necessário e não usam overlays ou chaves do Cliente. Builds, permissões geradas e schemas ficam ignorados pelo Git.

Testes JS estão em `tests/control/SupportDesktop.test.mjs` e nas suítes Control existentes; testes Rust em `src-tauri-support/src/host/tests.rs`. Cobrem S256, início, intervalo, expiração, confirmação/resgate único, credencial ausente/expirada, logout antes de HTTP, falha de revogação, erro de conexão, origem/redirect/limites, payload/path inválidos, whitelist, confirmação obrigatória, token não exposto, isolamento Agent, identidade/capabilities e estados UI. Use também typecheck, builds dos três produtos e suítes validation/tools/control/release/diagnosis e Rust Desktop/Core/Link/Agent/Helper.

## Limitações e próximos passos

Sem PostgreSQL/OIDC/HTTPS reais, os fluxos autenticados são verificados com testes controlados, sem declarar login integrado em produção. A validação local da janela real verifica inicialização e estado não configurado; não substitui homologação com infraestrutura real.

Nesta implementação, o executável Windows de produção foi gerado e seu manifesto embutido foi extraído: `asInvoker`, `uiAccess=false` e Common Controls v6 confirmados. `support:dev` iniciou em `http://localhost:1421/` e abriu a janela real **CENTRAL SOS Suporte**. A conferência visual automatizada não foi concluída: a captura retornou timeout e a interação foi interrompida pelo usuário com Escape. O estado não configurado foi coberto pelos testes do host/React; sua apresentação no Windows e o login real ainda exigem teste manual.

O `cargo test` completo do **Cliente** encontra uma restrição existente: seu binário de teste herda `requireAdministrator` e não pode iniciar neste terminal comum (`os error 740`). O check e os testes da biblioteca passam; testes Windows reais ignorados permanecem ignorados. Não se removeu a elevação do Cliente para contornar a restrição. O Suporte mantém `asInvoker` e testes executáveis em usuário comum.

Não há persistência da sessão, atualização/distribuição oficial do Suporte ou conexão direta aos clientes. Os próximos passos são configurar e homologar o login real, testar autorização por papel com Agents reais e definir uma distribuição própria para Suporte; isso exige trabalho posterior e não modifica a esteira do Cliente neste PR.
