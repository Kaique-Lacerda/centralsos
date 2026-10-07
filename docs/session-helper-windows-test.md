# Session Helper: ACL Windows e teste local pelo SCM

## Resultado da investigação

Base: `main` / `cd21355` (merge do Session Helper). A instalação real e ambos os executáveis têm owner Administradores e usuários comuns com leitura/execução. Essas permissões passaram pela verificação nativa.

A rejeição ocorre em **`C:\`**, que nesta máquina tem uma ACE efetiva de **Everyone/Todos: Full Control**, além das entradas de SYSTEM, Administradores, Users e Authenticated Users. A entrada de Everyone não é INHERIT_ONLY. O diagnóstico nativo retornou:

```text
SessionPeerRejected: Imagem/diretório modificável por principal não confiável
(ACE=4, direitos=0x000C0150); etapa=VolumeRoot, ancestral=4, caminho=C:\
```

O índice da ACE vem da DACL obtida diretamente por handle; a apresentação/reordenação do PowerShell pode mostrar outro índice. `0x000C0150` corresponde a WRITE_DAC, WRITE_OWNER, FILE_DELETE_CHILD, FILE_WRITE_EA e FILE_WRITE_ATTRIBUTES. Não é leitura/traversal. A pasta Program Files protegida não permite ignorar a capacidade de alterar/remover componentes pelo ancestral. **A rejeição observada não era um falso positivo**. A correção não aceita essa ACL e não modifica o Windows.

Uma prova adicional com CreateFileW, no processo **não elevado**, conseguiu abrir/fechar handles de C: solicitando separadamente FILE_DELETE_CHILD, WRITE_DAC e WRITE_OWNER (Win32Error=0 nos três). Nenhuma exclusão, escrita, mudança de owner ou de ACL foi executada. Isso confirma direitos efetivamente concedidos pelo Windows, além da inspeção da DACL.

É necessário que o administrador responsável revise a ACL da raiz antes de validar esta implantação. Não fornecer/restaurar uma ACL genérica de C: automaticamente: isso pode afetar outros programas, herança e dados. Não remover direitos sem examinar a política real da máquina.

## Modelo de segurança aplicado

- Owner: somente SYSTEM, Administradores e TrustedInstaller, em cada objeto do caminho.
- Executável: recusar escrita/append/EA/attributes, DELETE, WRITE_DAC e WRITE_OWNER por principal não confiável.
- Pasta imediata: também recusar criação de arquivos/subdiretórios e FILE_DELETE_CHILD; evita introduzir arquivos na instalação.
- Outros ancestrais: criar um arquivo/subdiretório não relacionado, por si só, não substitui um componente existente protegido. Continuam bloqueados DELETE, FILE_DELETE_CHILD, WRITE_DAC/OWNER, alteração de EA/attributes.
- Raiz do volume: a raiz não pode ser renomeada/excluída; excluir filhos, alterar DACL/owner ou metadados continua sendo perigoso.
- Direitos genéricos passam por MapGenericMask. ACE herdada efetiva é avaliada normalmente; INHERIT_ONLY não aplica ao objeto atual, e cada filho existente é verificado separadamente.
- Deny é processado na ordem armazenada: só reduz um allow quando vem antes e cobre comprovadamente o mesmo SID ou Everyone. Não inferimos associação a grupos arbitrários; casos não demonstráveis permanecem recusados. Deny posterior não desfaz um allow anterior.
- DACL nula, ACE efetiva desconhecida ou descriptor inválido falham de forma fechada. DACL vazia, com owner confiável, não concede escrita a terceiros.
- Reparse points são recusados em qualquer componente. Executável deve ter exatamente um hardlink; aliases adicionais são recusados conservadoramente, embora ACLs de hardlinks sejam compartilhadas.
- ACL e metadados são lidos por handle do mesmo objeto. Handles sem compartilhamento de exclusão ficam vivos até o fim da transação, e o Helper mantém a própria imagem/caminho fixados enquanto serve. Não há reparo de ACL.
- Logs mostram razão, papel do objeto, nível ancestral e direitos; somente caminhos com componentes fixos de implantação são exibidos. Caminhos de perfil/outros nomes ficam omitidos. Não há SID de usuário/logon, inventário, payload ou credencial.

ACLs condicionais/object ACEs efetivas não são interpretadas como permissão segura: permanecem recusadas. Administrador local/SYSTEM comprometido está fora da fronteira de proteção. Lifecycle continua pendente: instalação protegida, registro/conta do serviço, lançamento não elevado na sessão do usuário, atualização coordenada dos dois binários e reinício controlado.

## Recompilar

Na pasta do projeto, PowerShell:

```powershell
$cargo = "$env:USERPROFILE\.cargo\bin\cargo.exe"
& $cargo test --manifest-path crates/link/Cargo.toml
& $cargo test --manifest-path crates/agent/Cargo.toml
& $cargo test --manifest-path crates/session-helper/Cargo.toml
& $cargo test --manifest-path crates/session-helper/Cargo.toml live_user_read_only_results_obey_the_contract -- --ignored
& $cargo build --manifest-path crates/agent/Cargo.toml --bins --example session-info-service
& $cargo build --manifest-path crates/session-helper/Cargo.toml
```

Binários de produção (debug, destinados a este teste):

- `crates/agent/target/debug/central-sos-agent.exe`
- `crates/session-helper/target/debug/central-sos-session-helper.exe`

Artefato **somente de teste**, não incluído no Agent de produção:

- `crates/agent/target/debug/examples/session-info-service.exe`

Cargo normalmente mantém hardlinks entre `target/debug` e `target/debug/deps`. Esses artefatos são conservadoramente recusados pela política se executados diretamente. `Copy-Item` para a instalação cria uma cópia independente; o binário instalado deve ter um único link e owner/ACL confiáveis.

Antes de copiar, realizar o probe somente leitura do caminho instalado:

```powershell
& $cargo test --manifest-path crates/link/Cargo.toml installed_images_read_only_trust_probe -- --ignored --nocapture
if ($LASTEXITCODE -ne 0) { throw 'Implantação não confiável: revise o diagnóstico/ACL antes de prosseguir.' }
```

Na máquina investigada esse probe falhou pela ACL de C:, como previsto. Ele requer os executáveis existentes e verifica ambos. Os testes de DACL típica usam descriptors Windows nativos controlados; não modificam a ACL do host. Os testes reais de junction/hardlink criam somente fixtures dentro de `crates/link/target/image-security-tests` e as removem.

## Copiar os dois executáveis de produção

Depois de a instalação passar no probe, em um PowerShell **administrador**, na raiz do projeto:

```powershell
$install = 'C:\Program Files\CENTRAL SOS\Agent'
Stop-Service -Name CentralSOSAgent
# Encerre manualmente o Helper antigo na janela do usuário antes de copiar.
Copy-Item -LiteralPath '.\crates\agent\target\debug\central-sos-agent.exe' -Destination "$install\central-sos-agent.exe"
Copy-Item -LiteralPath '.\crates\session-helper\target\debug\central-sos-session-helper.exe' -Destination "$install\central-sos-session-helper.exe"
Start-Service -Name CentralSOSAgent
Get-CimInstance Win32_Service -Filter "Name='CentralSOSAgent'" |
    Select-Object Name, State, StartName, ProcessId, PathName
```

Em outro PowerShell **normal, não elevado**, do usuário logado/desbloqueado:

```powershell
& 'C:\Program Files\CENTRAL SOS\Agent\central-sos-session-helper.exe'
```

O Helper fica esperando a contraparte em vez de encerrar. Não inicia ou corrige impressoras. A existência do pipe sozinha não comprova um round-trip: o Agent de produção recebe comandos exclusivamente do backend, portanto use o harness abaixo para prova sem backend.

## Round-trip local restrito a session.info

O harness é um example compilado explicitamente; não adiciona comando local, argumento, listener TCP ou bypass ao Agent de produção. Ele usa **o mesmo** discover/exchange/autenticador, exige SCM `CentralSOSAgent`, LocalSystem/Session 0, sibling esperado, ACLs e token interativo verdadeiro. Executa uma única `session.info`, com timeout de 30 s, e encerra. Só escreve um marcador sem inventário quando a própria imagem/instalação passa pela política.

**Este procedimento interrompe temporariamente o Agent existente.** Use janela de teste autorizada; não executar junto com comandos remotos. O procedimento não foi executado automaticamente pelo Codex, cujo processo não está elevado; nesta máquina a ACL de C: também bloqueia o teste.

1. Depois de passar no probe, em PowerShell **administrador**, na raiz do projeto, prepare uma pasta de teste nova sob a instalação protegida. Não altere ACLs para fazê-la passar:

```powershell
$testInstall = 'C:\Program Files\CENTRAL SOS\SessionHelperTest'
if (Test-Path -LiteralPath $testInstall) { throw 'Pasta de teste já existe; examine seu conteúdo antes de reutilizá-la.' }
New-Item -ItemType Directory -Path $testInstall | Out-Null
Copy-Item -LiteralPath '.\crates\agent\target\debug\examples\session-info-service.exe' -Destination "$testInstall\central-sos-agent.exe"
Copy-Item -LiteralPath '.\crates\session-helper\target\debug\central-sos-session-helper.exe' -Destination "$testInstall\central-sos-session-helper.exe"
$originalBinary = (Get-CimInstance Win32_Service -Filter "Name='CentralSOSAgent'").PathName
```

2. Em uma segunda janela **não elevada**, execute o Helper de teste e deixe a janela aberta:

```powershell
& 'C:\Program Files\CENTRAL SOS\SessionHelperTest\central-sos-session-helper.exe'
```

O Helper normal e o de teste compartilham o namespace de pipe da mesma sessão. Encerre o Helper antigo antes; a primeira instância exclusiva não permite dois Helpers simultâneos.

3. Na janela administrativa, troque **temporariamente** apenas o binário do mesmo serviço. O nome/conta/política de autenticação permanecem iguais:

```powershell
try {
    Stop-Service -Name CentralSOSAgent
    & sc.exe config CentralSOSAgent binPath= ('"' + $testInstall + '\central-sos-agent.exe"')
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao selecionar o harness no SCM.' }
    Start-Service -Name CentralSOSAgent
    $deadline = (Get-Date).AddSeconds(40)
    do {
        $state = (Get-Service -Name CentralSOSAgent).Status
        if ($state -eq 'Stopped') { break }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    if ($state -ne 'Stopped') { throw 'Harness não concluiu no prazo.' }
    $marker = Get-Content -LiteralPath "$testInstall\session-info-test.result.json" -Raw | ConvertFrom-Json
    if ($marker.status -ne 'PASSED' -or !$marker.peerAuthenticated -or !$marker.responseValidated) {
        throw ('Round-trip recusado: ' + $marker.code)
    }
    $marker | Format-List
} finally {
    Stop-Service -Name CentralSOSAgent -ErrorAction SilentlyContinue
    & sc.exe config CentralSOSAgent binPath= $originalBinary
    if ($LASTEXITCODE -ne 0) { throw 'Restauração do binário original falhou; revise o SCM antes de iniciar.' }
    Start-Service -Name CentralSOSAgent
}
```

Resultado esperado:

```json
{"operation":"session.info","peerAuthenticated":true,"responseValidated":true,"status":"PASSED"}
```

Depois encerre o Helper de teste com Ctrl+C e volte a iniciar o Helper de produção na janela não elevada. Para repetir, examine e remova **somente** o marcador anterior na pasta de teste; `create_new` deliberadamente impede sobrescrever um arquivo/link existente. Nunca copie o harness sobre o Agent de produção. Não é necessário instalar um segundo serviço ou mudar a conta LocalSystem.

## Referências

- [File security and access rights](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights)
- [DACLs and ACEs](https://learn.microsoft.com/en-us/windows/win32/secauthz/dacls-and-aces)
- [File access rights constants](https://learn.microsoft.com/en-us/windows/win32/fileio/file-access-rights-constants)
- [MapGenericMask](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-mapgenericmask)
