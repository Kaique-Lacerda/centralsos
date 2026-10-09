# Instalador integrado do CENTRAL SOS Cliente (PR #21)

## Arquitetura e componentes

Versão pública **0.2.0**, sem alteração das versões internas dos crates. Somente NSIS x64
MSVC: Cliente Tauri (`requireAdministrator`), Agent Service e Session Helper (`asInvoker`).
O Suporte permanece outro produto e não é incluído; MSI está desabilitado porque ainda não
tem este lifecycle. Não substituímos o template NSIS padrão do Tauri: usamos seus quatro hooks.

```text
NSIS elevado -> Cliente Tauri
             -> CentralSOSAgent (SCM, LocalSystem, Session 0)
                  -> supervisor WTS -> Helper não elevado do usuário
                       -> Named Pipe autenticado existente
```

O Cliente não precisa ficar aberto. Não há task agendada, listener TCP, novo comando remoto,
shell/script/path arbitrário ou mecanismo paralelo de atualização do Agent.

## Caminhos e permissões

Program Files x64 é obtido pela API do Windows. O caminho aceito é:

```text
%ProgramFiles%\CENTRAL SOS\
  central-sos.exe
  uninstall.exe                     # template Tauri
  client-package.json               # recibo, sem credenciais
  Agent\central-sos-agent.exe
  Agent\central-sos-session-helper.exe
  .central-sos-installer\
    incoming\central-sos.exe
    incoming\Agent\central-sos-agent.exe
    incoming\Agent\central-sos-session-helper.exe
    incoming\package.json
    operation.lock                  # lock de handle, liberado pelo kernel em crash
    transaction.json                # somente enquanto a transação estiver pendente
    backup\<nomes fixos>            # somente durante a transação
    uninstall-receipt.json          # repetir remoção interrompida
```

Outro `/D=` é recusado. Diretórios novos gerenciados têm owner Administradores e DACL
protegida: SYSTEM/Administradores full, Users read/execute, herdada pelos próprios filhos.
Objetos existentes são validados, nunca re-ACL'd. O template pode criar `$INSTDIR` antes
do hook; ele também precisa passar a validação.

Antes de extrair/executar Agent, NSIS inspeciona owner/DACL/metadados e pina diretórios
sem share-delete. Recusa reparse points, hardlinks, owners não confiáveis e allows de
mutação para principals não confiáveis. Denies não dispensam recusa no bootstrap
(política conservadora). Inspeciona todos os ancestrais. O adapter Rust mantém os pins
de `trusted_image`/`trusted_directory`, usando a política existente do Link.

**Não modifica ACL de C:\, Program Files ou qualquer diretório externo.** ACL externa
insegura causa falha, mesmo com pasta final segura; reparo exige análise/autorização separada.
Administradores/SYSTEM/TrustedInstaller são a fronteira de confiança. Não há proteção contra
um administrador malicioso que controla a instalação.

## Build e inspeção

```powershell
npm ci
npm run tauri:build
```

Wrapper fixa NSIS/x64. `beforeBuildCommand` compila UI Cliente e usa target dedicado
`.installer-build/cargo-target` para Agent e Helper, com CRT estático e um job por vez:

```text
cargo build --locked --release --target x86_64-pc-windows-msvc --manifest-path crates/agent/Cargo.toml
cargo build --locked --release --target x86_64-pc-windows-msvc --manifest-path crates/session-helper/Cargo.toml
```

Cargo verifica o grafo/lockfiles a cada build, reaproveitando somente seu cache de compilação.
Não copiamos binários sem passar por `cargo build --locked --release`. O staging de pacote é
sempre novo/isolado em `.installer-build/stage-*`, e o índice anterior é invalidado antes do build.
Falha impede empacotamento; nunca usa `target/debug`. Saídas Cargo podem ter hardlink em `deps`:
são copiadas para arquivos exclusivos, com nlink=1, antes da validação/deploy. Não relaxamos
a policy de hardlinks de produção. Remove variáveis privadas de assinatura dos subprocessos
e remapeia caminhos dos fontes. `.installer-build` é ignorado pelo Git.

`beforeBundleCommand` confere target, versão e fingerprint dos fontes Git (inclusive novos
não ignorados). O bundler Tauri ainda aplica o marcador NSIS/assinatura Windows depois desse
hook. Por isso o hook NSIS executa **somente durante a compilação** um `!system` com Node/script
fixos para selar o Cliente final, antes dos `File`. Não há Node/script executado na instalação.
Recusa Cliente sem marcador NSIS, mudança dos fontes e segundo passe com PE divergente.
Depois do bundle, Tauri restaura o marcador original no executável avulso. Na comparação
final, o inspector normaliza somente esse marcador em uma cópia em memória; qualquer
outra diferença de byte/hash continua recusada. O PE real embutido é verificado integralmente.
Parseia PE/COFF e árvore **real** RT_MANIFEST ID 1: x64 PE32+, subsistema
Windows, Cliente requireAdministrator, Agent/Helper asInvoker, uiAccess=false. String solta
não conta como manifesto. Gera tamanho/SHA-256/destino/protocolo/commit/fingerprint no pacote.

Hooks `File` embutem os três PEs e manifesto. Nada é compilado/baixado no PC cliente.
WebView2 Evergreen **por máquina** é pré-requisito; se ausente, recusa e orienta canal oficial.
Não há bootstrapper de rede. Compression `none` aumenta tamanho, mas permite comprovar
byte por byte os três PEs no `.exe` final, sem executá-lo nem depender de extrator externo.
Inspector também confere template gerado, hooks, versão, modo e arquitetura:

```powershell
node scripts/client-bundle.mjs inspect "src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/CENTRAL SOS_0.2.0_x64-setup.exe"
```

Wrapper executa automaticamente; relatório `.installer-build/inspection.json`. Pacote
incompleto, PE incorreto ou staging antigo falha. Inspeção não é execução/homologação dos hooks.

## Instalação, upgrade e SCM

1. Bootstrap valida/pina caminho e extrai incoming protegido.
2. Agent elevado valida pacote/hashes/protocolo/versão e identidade/configuração SCM.
3. Salva Preparing e backups conhecidos; nunca copia credenciais/dados persistentes.
4. Desabilita start do próprio serviço, Stop, aguarda Stopped **e saída do processo pelo
   handle original autenticado**. Probe exclusivo do Helper; imagem ainda em uso bloqueia,
   sem kill por nome nem substituição no reboot.
5. Salva Prepared; template copia Cliente/recursos padrão.
6. Salva Replacing; reconfere Cliente; substitui atomicamente Agent/Helper.
7. Valida todo conjunto; reutiliza `--install-service`/`--start-service`.
8. Consulta SCM até Running/AutoStart, OWN_PROCESS, LocalSystem, caminho fixo. Rotinas
   mantêm recovery restart 10/30/60 segundos e reset 24 horas.
9. Grava recibo/Committed; limpa backups e journal por último.

Running não significa enrollment, Helper disponível, heartbeat online ou Backend configurado.
Sem sessão elegível o serviço pode estar Running sem Helper. Pipe/policy/supervisão do PR #20
permanecem intactos. Status reporta esses limites, sem tokens, senhas ou SIDs completos.

Updater assinado entrega o **mesmo NSIS completo**. O template reconhece `/UPDATE` e pula
uninstall prévio, mantendo PREINSTALL/POSTINSTALL. No instalador interativo, atualizar sem
desinstalar previamente permite rollback; escolher uninstall prévio é remoção explícita,
sem backup do antigo conjunto para rollback.

Start Disabled durante troca impede auto/recovery restart de conjunto misto após crash/reboot.
O recibo gerenciado também impede downgrade numérico no adapter local, além do bloqueio
do NSIS/updater. Mesma versão pode ser reinstalada para recuperação.
Journal existente bloqueia novo install/upgrade. Não há retomada silenciosa ou fallback inseguro.

## Rollback e recuperação administrativa

Falha de cópia/registro/recovery/start/verificação/recibo chama rollback: parar próprio serviço;
validar **todos** os backups; restaurar arquivos/recibo e modo/estado SCM anterior; verificar;
salvar RolledBack; limpar. Preparing distingue backup incompleto sem troca dos arquivos finais.
Committed/RolledBack permitem repetir apenas cleanup. Temporários fixos são validados e
descartados sem execução/recursão.

Falha de restauração deixa journal/backups e `INSTALL_ROLLBACK_INCOMPLETE`; não reinicia
serviço com imagens parciais. Se nem desabilitar/parar for possível, não se garante SCM
quiescente: falha explícita e intervenção administrativa. Não há rollback absoluto sob perda
de energia, disco corrompido, ACL alterada ou processo que não termina.

Transação protege as três imagens e SCM. ARP/shortcuts/uninstall.exe são do template e não
formam transação atômica com NTFS/SCM. Falha pode deixar metadata visual parcial, que não
indica sucesso. Após recuperação, reexecutar installer reconcilia metadata.

PowerShell **elevado**, Agent incoming preservado em caminho oficial:

```powershell
& "$env:ProgramFiles\CENTRAL SOS\.central-sos-installer\incoming\Agent\central-sos-agent.exe" --installer-status
& "$env:ProgramFiles\CENTRAL SOS\.central-sos-installer\incoming\Agent\central-sos-agent.exe" --installer-rollback
```

Só aceita argumento fixo; sem paths/PIDs/scripts remotos. Prepare/commit exigem incoming
completo/compatível. Rollback/status não executam Helper. Se incoming estiver ausente/não
confiável, não executá-lo. Agent instalado confiável pode consultar e recuperar o SCM; comandos PR #20
`--service-status`, `--stop-service`, `--uninstall-service` continuam disponíveis sem Helper,
com verificação própria/SCM. Não executar `--install-service` no Agent incoming manualmente:
o adapter dos hooks registra caminho **final**, não o staging. Não apagar journal para bypass.
Se não for possível provar trust/ownership, parar para análise administrativa autorizada.
Restauração de imagens exige um Agent de recuperação fora dos arquivos que serão substituídos;
um Agent instalado não pode sobrescrever o próprio executável em uso. Se incoming estiver
danificado, repor os recursos do mesmo pacote verificado em caminho protegido exige análise
administrativa autorizada. Não há fallback para executar Helper não confiável.

## Uninstall, retenção e revogação

PREUNINSTALL valida diretórios, reextrai seu Agent embutido para incoming protegido, recusa
transação pendente, valida recibo/config SCM, desabilita/para/aguarda saída, confere Helper
desbloqueado e remove somente serviço verificado. Helper ausente/corrompido não é executado;
ACL não confiável ou Helper em uso bloqueiam remoção. Recibo de remoção protegido permite
repetir remoção parcial. Ausência completa de serviço/arquivos é no-op. Serviço estrangeiro
nunca é parado/removido.

NSIS deleta somente nomes conhecidos. POSTUNINSTALL comprova Cliente ausente, limpa
incoming/recibos/lock e tenta remover diretórios **vazios**. Arquivos desconhecidos são retidos.
Timeout/acesso negado/SCM ainda marcado para delete falham explicitamente. Não usa taskkill,
remove ProgramData ou percorre perfis. Checkbox de apagar AppData é neutralizado.

Enrollment/identidade/vault DPAPI/command journal/comunicação/configuração legítima e
preferências ficam nos caminhos persistentes anteriores, fora do backup. Instalador não os
copia, regenera ou apaga. Remoção local não revoga dispositivo no Backend: revogação remota
fica **não solicitada**, exigindo operação autorizada separada. Retenção permite reinstalação.
O armazenamento existente do Agent é `%ProgramData%\CENTRAL SOS\Agent` (incluindo vault,
status/health/logs e journals). O instalador não modifica sua política de proteção/DPAPI.

## Updater e pipeline

`release:build` continua exigindo públicos reais e chave privada externa; dev/build local
não exigem assinatura/updater ativo. Workflow manual em main mantém tag/versão/commit,
draft, latest.json, `.sig`, validação criptográfica e publicação controlada. Acrescenta inspeção
do NSIS completo antes da publicação. Sem geração de chaves/configuração de produção.
Assinatura Tauri protege **todo instalador**, inclusive companions; **não é Authenticode**,
nem evita SmartScreen. Instalação manual exige fonte oficial/verificação pelo operador.

## Testes e limites de homologação

Controller Rust tem adapter em memória: cópia/start/rollback/cleanup falhos, interrupção,
foreign configuration, timeout, lock, persistência e idempotência. Nenhum teste comum modifica
SCM/ACL, lança Helper ou executa setup. Node cobre PE/manifestos, pacote, staging/build e Actions.
Build/inspeção prova empacotamento/compilação, **não instalação real**.

Homologação **opt-in, VM autorizada** ainda necessária: install limpo/WebView2/ACL; SCM recovery
e reboot; logon/lock/logoff/RDP/pipe; upgrade `/UPDATE` Running/Stopped/sem serviço; interromper
cada cópia; falhas reais de disco/start/rollback; uninstall repetido/Helper ocupado/ausente/
corrompido/serviço estrangeiro; preservação DPAPI/identidade; ARP/shortcuts; updater assinado real.

Limitações de Job/quarentena do PR #20 continuam: falha abrupta do supervisor não oferece
garantia absoluta de término de processo cuja propriedade perdeu prova. Instalador recusa
Helper ainda em uso; não enfraquece verificação para forçar instalação.
