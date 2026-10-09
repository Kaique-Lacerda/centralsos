# Lifecycle do Agent e Session Helper

Empacotamento/upgrade/uninstall por máquina: [Instalador Cliente + Agent + Helper](client-agent-installer.md).
O NSIS reutiliza estas rotinas SCM e exige recuperação de transação pendente antes de nova
instalação. Não altera a autenticação do pipe nem o mecanismo de supervisão.

## Arquitetura anterior e nova

O Agent já tinha dispatcher/Stop/Shutdown do SCM, polling HTTPS, heartbeat independente,
policy tipada, journal e entrega de resultados. WTS e Named Pipe autenticado já existiam;
o Helper precisava ser iniciado externamente. Nada dessas responsabilidades remotas foi
substituído.

Agora o serviço supervisiona exclusivamente seu Helper fixo, sem depender do Desktop,
enrollment ou disponibilidade do Backend:

```text
Suporte nativo -> Backend HTTPS <- Agent outbound HTTPS (LocalSystem, Session 0)
                                   |
                                   +-- supervisor WTS / SCM
                                          |
                                          +-- Helper não elevado do usuário
                                              Named Pipe autenticado existente
```

Não há listener TCP, shell, senha de usuário, task agendada ou caminho recebido remotamente.
Somente `session.info`, `session.processes` e `session.printers` cruzam o IPC existente.
Os comandos e as políticas remotas anteriores permanecem intactos; reparos de impressora
não foram habilitados no Service.

## Decisão: SCM + WTS + CreateProcessAsUser + Job Object

A escolha reutiliza a descoberta WTS/identidade do Windows e concentra propriedade e
encerramento no Agent. Uma task no logon deixaria o ciclo de vida e a propriedade separados,
exigindo adoção de processos externos; isso é recusado por esta implementação.

O SCM informa alterações de sessão. A notificação só acorda o supervisor; o ID recebido
não é usado para escolher o usuário. WTS é consultado novamente, também periodicamente
(aproximadamente 1 segundo, acrescido do IPC limitado). O supervisor usa relógio monotônico.

1. Validar Agent LocalSystem/Session 0 e imagem protegida; manter os handles de trust abertos.
2. Escolher a única sessão elegível com a política WTS anterior.
3. Validar o Helper irmão `central-sos-session-helper.exe`, **todos** os ancestrais e ACLs.
4. Recusar pipe já existente/não verificável; não adotar nem matar instância externa.
5. Obter token primário por `WTSQueryUserToken`; quando elevado, usar o linked token limitado.
   Conferir user SID, logon SID, sessão, `TokenIsElevated == 0` e integridade no máximo Medium.
   Se não houver token limitado verificável, recusar. Não solicitar UAC nem alterar token
   de sessão/integridade para forçar uma aprovação.
6. Criar ambiente do usuário com `bInherit=false` e filtrar para variáveis padrão necessárias
   (`SYSTEMROOT`, `WINDIR`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`,
   `COMPUTERNAME`, `USERNAME`, `USERDOMAIN`, `HOMEDRIVE`, `HOMEPATH`). Não passar PATH,
   variáveis arbitrárias, credenciais/vault do Agent, argumentos ou handles herdados.
7. Criar processo suspenso com caminho absoluto fixo, argv contendo somente o próprio
   executável, diretório protegido e desktop `winsta0\default`. Não ajustar ACL desse desktop:
   acesso negado resulta em falha segura.
8. Associar atomicamente ao Job via `PROC_THREAD_ATTRIBUTE_JOB_LIST` na criação. O Job
   privado limita a um processo, não permite breakaway e usa `KILL_ON_JOB_CLOSE`.
   Isso fecha a janela de processo órfão se o Agent morrer entre criação e ResumeThread.
9. Validar handle/PID/token/identidade/imagem/Job, reconferir WTS, então retomar a thread.
10. Só liberar comandos após `session.info` autenticado e compatível. O PID do servidor
    precisa ser exatamente o PID que o supervisor criou, além de **todos** os controles
    anteriores do pipe.

O Helper tem subsistema Windows e manifesto `asInvoker`, `uiAccess=false`. Ele próprio
recusa token elevado/SYSTEM/Session 0 antes de servir o pipe; o manifesto sozinho não é
tratado como garantia de não elevação.

Referências de implementação: [WTSQueryUserToken](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/nf-wtsapi32-wtsqueryusertoken),
[CreateProcessAsUserW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw),
[atribuição atômica a Job](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812),
[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

## Sessões, RDP e encerramento

| Situação | Comportamento |
| --- | --- |
| Nenhum usuário | `SESSION_REQUIRED`; não iniciar Helper |
| Bloqueada | `SESSION_LOCKED`; invalidar acesso e retirar somente o Helper controlado |
| RDP desconectada | `SESSION_DISCONNECTED`; não tratar conexão RDP como sessão ativa |
| Mais de uma sessão | `SESSION_AMBIGUOUS`; nenhuma escolha arbitrária |
| Token/estado desconhecido | Recusar com erro estruturado |
| Logoff/novo logon | Invalidar identidade anterior, retirar o processo próprio, descobrir novamente |
| Unlock/reconexão elegível | Criar novo Helper validado para o logon atual |
| Helper externo/pipe ocupado | Não adotar/encerrar; indisponível com backoff |
| Stop/Shutdown | Revogar disponibilidade, encerrar processo próprio e liberar recursos |

Não existe processo escolhido por nome nem PID fornecido pelo Backend. O handle original
do processo e o Job privado são mantidos durante o lifecycle, impedindo confusão por
reutilização de PID. O gate de comandos permanece travado durante IPC limitado; retirada
não libera a propriedade durante uma troca. Probes de saúde compartilham esse gate e não
competem com comandos normais.

Antes de terminar um processo vivo, o supervisor verifica novamente token, identidade,
imagem protegida e vínculo com seu Job. Divergência suspende novas operações/inícios
(`Quarantined`). Sem comprovação não se chama `TerminateJobObject` nem `TerminateProcess`.
A quarentena é irreversível nessa instância do supervisor: não autoriza IPC, adoção, novo
Helper ou retirada explícita mesmo que uma consulta posterior pareça comprovar a identidade.
O Agent tenta desarmar `KILL_ON_JOB_CLOSE` imediatamente ao recusar a retirada, mantendo
os handles originais abertos. Consulta os limites atuais, altera **somente** essa flag,
verifica o retorno de `SetInformationJobObject` e consulta novamente para confirmar o
desarme. Limite de um processo e ausência de breakaway permanecem intactos.

Falhas produzem estados finitos `JOB_QUARANTINE_QUERY_FAILED`, `JOB_QUARANTINE_SET_FAILED`
ou `JOB_QUARANTINE_CONFIRM_FAILED` no log protegido do Agent ao retirar o Helper;
`JOB_QUARANTINE_DISARMED` indica desarme confirmado. No descarte normal, tenta novamente.
Se ainda não puder confirmar o desarme, **não fecha** os handles do processo/Job nem os pins
das imagens/ancestrais: eles são deliberadamente retidos até o término do processo Agent,
com diagnóstico finito também em stderr (que pode não estar capturado pelo SCM).
Isso sacrifica a liberação normal de recursos nessa condição excepcional e exige investigação
administrativa; não é recuperação automática nem uma licença para relançar filhos.

**Limitação real:** se o Agent encerrar/crashar antes do desarme confirmado, o Windows
fecha seus handles. Se a flag continuar ativa, o fechamento do **último** handle do Job
pode encerrar seu processo associado, mesmo que a identidade já não seja comprovável.
Outro handle ainda aberto posterga esse evento; não elimina o risco no último fechamento.
Uma falha abrupta também pode impedir `Drop`, nova tentativa e registro do diagnóstico.
Não existe garantia absoluta de que nenhum processo será encerrado nesse cenário. Se o
desarme foi confirmado, fechar o Job não causa essa terminação automática, porém o Helper
pode permanecer órfão/quarentenado; o Agent não o adota nem o encerra por PID/nome.
O Job é privado, não herdado e só recebe o processo criado atomicamente pelo supervisor.
Investigação administrativa é necessária para esses estados excepcionais.
O modelo não protege contra administrador/SYSTEM malicioso nem contra falha do kernel;
o Windows deve continuar aplicando identidade de token e isolamento do Job.

## Recuperação e estados locais

Probes autenticados aproximadamente a cada 15 segundos; inicialização limitada a 10 segundos.
Pipe ocupado por comando normal não causa retirada imediata. Sem nova comprovação de saúde
por 45 segundos, retirar o processo próprio e entrar em backoff. IPC continua limitado a
5 segundos/expiração; o coletor anterior mantém seu limite e aposentadoria em caso de timeout.

Após falhas: 2, 4, 8, 16 segundos; na quinta falha e seguintes, pausa de 5 minutos.
Sessão de novo logon reinicia o contexto; estabilidade comprovada por 60 segundos reinicia
a contagem. Não acumular processos. Job/handles/tokens/environment/attribute list/imagens
têm RAII no caminho normal, com retenção excepcional descrita acima. Restart/crash do Agent
fecha seus handles; com `KILL_ON_JOB_CLOSE` ativo o último fechamento retira o filho associado,
sujeito à limitação de identidade descrita acima. Serviço automático
retoma após boot, e recovery do SCM pode reiniciar após falha.

Estados: `Starting`, `Available`, `Unavailable(código)`, `Backoff`, `RepeatedFailure`,
`Quarantined`, `Stopped`. Erros incluem `SESSION_HELPER_UNAVAILABLE`, `SESSION_PEER_REJECTED`
(trust/token/ownership), `SESSION_PROTOCOL_MISMATCH`, `SESSION_TIMEOUT` e os erros de sessão
já existentes. Não foram acrescentados campos/versões ao protocolo remoto ou IPC.
Quando o supervisor já identificou incompatibilidade ou falha de trust, a recusa de comandos
preserva esse código estruturado; não o converte indiscriminadamente em Helper ausente.

Logs registram apenas transições e códigos finitos; não incluem PID, SID, logon SID,
inventário, payload, senha ou token. O Agent registra Running/falha de início no log local
protegido existente. Falha de trust nunca é corrigida automaticamente.

Stop/Shutdown sinalizam todos os workers. O SCM recebe StopPending com checkpoints enquanto
operações nativas anteriores, limitadas pela policy, terminam. Não forçar abort de threads
que possam estar realizando efeitos. O Helper tem retirada independente do Backend;
heartbeat/polling/journal/outbox continuam com seus mecanismos anteriores de reconexão.
Comandos expirados são recusados antes de IPC e novamente pelo protocolo/engine; não há
fallback de sessão como SYSTEM.

## Contrato para o instalador (PR #21, não implementado aqui)

As rotinas só são chamadas por **opção local explícita**, executada por administrador já
elevado; não rodam em dispatch, testes ou build e não elevam automaticamente o usuário:

```text
central-sos-agent.exe --install-service
central-sos-agent.exe --start-service
central-sos-agent.exe --service-status
central-sos-agent.exe --stop-service
central-sos-agent.exe --uninstall-service
```

Nenhum argumento adicional, path ou credencial é aceito. **Install e start** exigem as duas
imagens lado a lado e protegidas, com a verificação integral de `trusted_image`.
**Status, stop e uninstall** constituem o caminho explícito de recuperação: exigem administrador
elevado autorizado pelo Windows e a imagem Agent de nome/local fixos, protegida junto de
todos os ancestrais, mas não abrem nem executam o Helper. Helper ausente, corrompido,
incompatível ou com trust recusado não bloqueia esse caminho e nunca é iniciado por ele.
Não há exceção para trust do Agent, ACL da raiz `C:\`, junctions ou hardlinks.
Um serviço existente
com outra imagem/argumentos/conta/tipo/dependências é recusado antes de alteração. Serviço
ausente é criado apenas em install explícito; status ausente retorna `state: "Absent"`,
stop/uninstall ausentes são sucesso idempotente. Rerun de install
em serviço Running já configurado exatamente (AutoStart/recovery) retorna sucesso sem mutação.
Mudanças de configuração e uninstall exigem serviço parado; start/stop são idempotentes para os respectivos estados
finais. Stop espera até 30 segundos; timeout exige diagnóstico e nunca autorização para
remover serviço ainda em execução.

O SCM é aberto localmente com o nome fixo `CentralSOSAgent` e os direitos mínimos de cada
opção. Confere caminho absoluto do **mesmo Agent administrativo**, sem argumentos,
OWN_PROCESS, LocalSystem e ausência de dependências. Havendo PID, confere pelo handle do
processo imagem confiável no mesmo diretório, LocalSystem/Session 0 e PID; Running sem PID
e Stopped com PID são recusados. Os handles/pins permanecem vivos durante a operação.
Antes de stop/delete, reconfere configuração e estado; após a espera de stop, reconfere
Stopped. Configuração divergente retorna `SCM_FOREIGN_CONFIGURATION_REJECTED` e identidade
não comprovável retorna `SCM_PROCESS_IDENTITY_REJECTED`, sem alterações nessa instalação.
Não há remoção de arquivo, mudança de ACL ou terminação de processo por nome/PID.
Administradores/SYSTEM concorrentes continuam fora do modelo adversarial: o SCM não
oferece transação atômica entre consulta de configuração e controle de serviço.

### Recuperar instalação/upgrade parcial (execução manual autorizada)

Em terminal **já elevado**, execute a partir da imagem Agent original ainda confiável,
no diretório daquela instalação (não copie um Agent de outro local para contornar trust):

```powershell
& 'C:\Program Files\CENTRAL SOS\Agent\central-sos-agent.exe' --service-status
& 'C:\Program Files\CENTRAL SOS\Agent\central-sos-agent.exe' --stop-service
& 'C:\Program Files\CENTRAL SOS\Agent\central-sos-agent.exe' --service-status
& 'C:\Program Files\CENTRAL SOS\Agent\central-sos-agent.exe' --uninstall-service
& 'C:\Program Files\CENTRAL SOS\Agent\central-sos-agent.exe' --service-status
```

O diretório acima é ilustrativo; use **o local original registrado no SCM**, sem argumentos
extras. Execute a próxima etapa apenas após sucesso da anterior e confirmação de Stopped
antes da remoção. Uma falha durante configuração de recovery pode deixar um serviço criado
e parado: o caminho de recuperação permite consultar/remover esse estado sem Helper.
Falha em stop/timeout não autoriza delete. Falha de rollback/delete permanece erro explícito;
consulte novamente e repita a remoção quando a causa for resolvida, sem criar outro serviço.
`DeleteService` marca o serviço para exclusão: enquanto outros handles SCM estiverem abertos,
a exclusão pode permanecer pendente; nova abertura pode retornar indisponível (1072),
não sucesso/ausência inventados. Feche os consumidores legítimos e consulte novamente.
Se o Agent também estiver ausente/não confiável, esta recuperação recusa: é necessária
intervenção administrativa externa autorizada, não exceção de segurança no aplicativo.

Configuração: `CentralSOSAgent`, OWN_PROCESS, AutoStart, LocalSystem, sem argumentos,
senhas/dependências. Recovery: restart em 10/30/60 segundos, reset em 24 horas, também em
falha não crash; nenhum reboot/comando externo. A inicialização do Helper é responsabilidade
do supervisor, portanto não há task/Run key separada para remover.

PR #21 ainda deve fornecer empacotamento, assinatura/distribuição, cópia protegida dos
binários e dependências, validação da cadeia de ACL **sem alterar raiz C:**, orquestração
administrativa de stop/configure/start/status, rollback, upgrade e uninstall completos.
Também deve verificar prontidão real/health pós-instalação, persistência de enrollment
segundo a política existente e homologação em máquinas representativas.

## Testes e homologação Windows

Automáticos: supervisor com WTS/processos mockados (inclui recursos com Drop), handler/status
SCM sem serviço instalado, configuração fixa/recovery/recusa de serviço estrangeiro sem
alteração do SCM, recuperação parcial/Helper ausente-corrompido-não confiável,
autorização/trust obrigatórios, rollback/delete falho e reexecução, configuração divergente
antes da mutação, timeout/stop falho sem delete, falhas Query/Set/confirmação do Job,
retenção de handles e retry de descarte, preservação dos demais limites, ambiente sem segredo,
rejeição de token elevado real por consulta somente
leitura, testes existentes de ACL/imagens/tokens/pipe/protocolo/expiração e suites TS/Rust.
Mocks verificam transições; **não comprovam** boot, recovery ou operação SCM real.

Teste opt-in apenas de observação de instalação já existente:

```powershell
$env:CENTRAL_SOS_LIFECYCLE_TEST_AUTHORIZED='1'
$env:CENTRAL_SOS_TEST_HELPER_PID='<PID observado do Helper instalado>'
cargo test --manifest-path crates/link/Cargo.toml installed_service_and_helper_have_matching_protected_user_context -- --ignored
```

Esse teste consulta SCM/tokens/imagens e confere o Helper ao usuário
atual; **não instala, inicia ou encerra processos/serviços** e não substitui o teste de IPC
positivo em serviço real. O PID de observação só existe no teste, nunca no protocolo/lifecycle.

Homologação manual, em VM Windows autorizada e instalação confiável: boot sem Desktop,
LocalSystem/Session 0; usuário padrão e administrador com UAC; logon/logoff/lock/unlock;
RDP ativa/desconectada/múltiplos usuários; crash/hang do Helper; crash/restart do Agent;
Backend offline; Helper incompatível/ausente; imagem/ACL rejeitada; comandos expirados;
Stop/Shutdown/recovery; repetição install/start/stop/uninstall e rollback. Conferir nenhum
Helper duplicado, nenhum peer externo adotado/encerrado explicitamente, nenhum segredo no
log e nenhuma operação de sessão como SYSTEM. Em VM autorizada, injetar falha de desarme e
observar separadamente o descarte normal (handles retidos) e o término do Agent (limitação
do último handle descrita acima). Cenários destrutivos/configuração real exigem autorização
específica e não são executados pelos testes comuns.

## Limites

Windows 10+ (JOB_LIST/semântica de bloqueio WTS), serviço instalado, privilégios LocalSystem
e acesso legítimo ao desktop do usuário são pré-requisitos. Conta administrativa sem token
limitado (p.ex. política que desabilita UAC) é recusada, não recebe fallback elevado. Não
carregar perfil de usuário nem alterar ACLs para contornar WTS/desktop negado. Não há seleção
de sessão via Control: múltiplas sessões continuam ambíguas. Processos de instalação antiga
externos ao Job/pipe são recusados; investigação/upgrade deverá ser tratado pelo instalador.

Esta entrega não registra serviço, não altera ACL, não testa boot/RDP/recovery ao vivo e
não publica instalador. Imagens em target/debug ou sob ancestrais inseguros não passam a
ser instalação confiável. O diagnóstico conhecido de ACL permissiva em C: permanece uma
recusa legítima que o administrador precisa investigar, sem exceção para Program Files.
