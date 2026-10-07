# Session Helper: fundação local de contexto do usuário

## Arquitetura

```text
Control → HTTPS outbound / polling → Agent LocalSystem (Session 0)
                                          │
                                policy tipada / journal
                                          │
                               descoberta WTS e token
                                          │
                    Named Pipe local autenticado e com DACL
                                          │
                  central-sos-session-helper.exe (usuário interativo)
                                          │
                          APIs Windows somente leitura
```

Não há TCP local, shell, executor genérico, script/path remoto, credencial adicional ou fallback SYSTEM. O transporte remoto, heartbeat e journal seguem existentes. Diagnóstico Geral e remediações locais não foram alterados.

## Contratos e operações

O protocolo local independente é `protocolVersion=1`. Timestamp/expiração são milissegundos UTC; janela máxima de 30 segundos. `requestId` e `nonce` são UUIDs gerados pelo Agent. A validade também é limitada à expiração remota e ao prazo monotônico confirmado no ACK do backend.

O request contém exatamente `requestId`, `protocolVersion`, `timestamp`, `expiresAt`, `nonce`, `session`, `operation` e `payload`. `session` contém `sessionId`, `userSid` e `logonSid`. Os três payloads aceitam somente `{}`. Respostas vinculam requestId, nonce, versão, timestamp e sessão, e têm `outcome.status=completed|rejected`, resultado discriminado ou erro `{code,message}`.

- `session.info`: identidade de token, username/domain WTS e estado active.
- `session.processes`: PID e nome dos processos da mesma sessão **e do mesmo token de logon/usuário**. Não consulta command line nem aceita PID de ação. Processos que não podem ter proprietário verificado são omitidos com `incomplete=true`.
- `session.printers`: inventário via EnumPrinters LOCAL/CONNECTIONS e padrão via GetDefaultPrinter no contexto real do Helper. Não acessa fila, imprime, instala ou altera impressoras. Default não verificável usa `isDefault=null` e `incomplete=true`.

Limites: frames de 256 KiB (prefixo u32 little-endian, verificado antes da alocação); 512 processos; 128 impressoras; buffer nativo de impressoras de até 4 MiB. Inventários limitados têm `truncated=true`.

`application.restart {product:TROIA}` está somente reservado em tipos futuros. Não existe no enum executável, schema remoto ou policy. Printer check/auto-fix continuam bloqueados em Session 0; estas três consultas não habilitam ações remotas de impressão.

## Autenticação e segurança

Diagnóstico de ACL por objeto, sem exceções por caminho, e procedimento de integração Windows sem backend: [Session Helper: ACL Windows e teste local pelo SCM](session-helper-windows-test.md).

- Nome do pipe deriva apenas da sessão e hash do **logon SID obtido do token**, evitando reutilização do mesmo endpoint após novo logon. Não há caminho configurável remotamente.
- Helper cria primeira instância exclusiva, retida entre requests, com `PIPE_REJECT_REMOTE_CLIENTS` e DACL explícita permitindo conexão somente a SYSTEM. Owner é o usuário real do Helper. Não são permitidos Everyone, anônimo ou clientes administrativos comuns.
- Helper verifica PID/session ID do cliente pelo kernel, token LocalSystem/Session 0, PID do serviço `CentralSOSAgent` em execução no SCM e imagem `central-sos-agent.exe` instalada ao seu lado.
- Agent verifica PID/session ID do servidor pelo kernel, SID do usuário/logon/sessão descobertos via WTS e imagem `central-sos-session-helper.exe` instalada ao seu lado.
- Ambos verificam owner e DACL dos executáveis e ancestrais: somente SYSTEM, Administradores ou TrustedInstaller podem substituir/modificar imagens. Reparse points, ACLs desconhecidas ou imagem em pasta gravável por usuário são rejeitados. Essa checagem é somente leitura; não altera permissões.
- Cliente SYSTEM usa SQOS `SECURITY_IDENTIFICATION`: o servidor do usuário não pode impersonar SYSTEM. Handles não são herdáveis, e os handles de processos autenticados permanecem abertos durante a transação.
- Requests inválidos/desconhecidos não chegam ao executor. Expiração e identidade são verificadas antes/depois da leitura. Nonces ficam em um cache limitado de replay enquanto válidos. Mensagens sem envelope confiável são encerradas, sem ecoar conteúdo não autenticado.
- Pipe usa OVERLAPPED, prazo global de 5 segundos e CancelIoEx para I/O pendente. ACK de consumo evita descartar uma resposta ainda buffered ao desconectar.
- Coleta nativa roda em worker com prazo de 3,5 segundos. Se Windows/spooler bloquear, o Helper envia SESSION_TIMEOUT e **encerra todo o processo**, evitando acumular workers bloqueados. Uma nova execução do Helper é necessária.
- Logs não incluem inventários, SIDs, payloads ou credenciais. O Control/journal pode persistir os resultados solicitados conforme a autorização já existente; esses dados são sensíveis de suporte.

O usuário local pode encerrar/interferir em seu próprio Helper. Esse risco de disponibilidade não concede permissões de SYSTEM: esta versão aceita apenas leituras e não possui callbacks de ação para o Agent. Não se promete proteção contra administrador local/SYSTEM comprometido.

## Descoberta e erros

WTS enumera todas as sessões de usuário. Session 0/listeners não são escolhidos. Um único usuário Active/unlocked com token verificável é necessário; **nenhuma sessão é selecionada arbitrariamente**, incluindo console e RDP.

| Situação | Código |
|---|---|
| Nenhum usuário logado | SESSION_REQUIRED |
| Sessão bloqueada | SESSION_LOCKED |
| RDP desconectada | SESSION_DISCONNECTED |
| Múltiplas sessões de usuário | SESSION_AMBIGUOUS |
| Estado/token WTS não verificável | SESSION_STATE_UNKNOWN |
| Helper ausente/pipe indisponível | SESSION_HELPER_UNAVAILABLE |
| Protocolo incompatível | SESSION_PROTOCOL_MISMATCH |
| PID/token/imagem/ACL/sessão divergente | SESSION_PEER_REJECTED |
| Payload/operação/envelope inválido | SESSION_INVALID_REQUEST |
| Expirado/replay/oversize/timeout/coleta falha | SESSION_EXPIRED / SESSION_REPLAY / SESSION_MESSAGE_TOO_LARGE / SESSION_TIMEOUT / SESSION_COLLECTION_FAILED |

Falha do Helper resulta em comando remoto REJECTED com código estruturado; nenhuma operação é repetida no Core/SYSTEM. Machine-safe (`service.check`, `spooler.restart` e dados de máquina) não consultam WTS/Helper. Username/HKCU/mappings e impressoras no snapshot do Service permanecem explicitamente incompletos; não são preenchidos por SYSTEM.

## Execução e limites de implantação

Requer Windows 10/11 ou Windows Server atual. A inversão histórica dos flags locked/unlocked do Windows 7/Server 2008 R2 não é suportada. Agent precisa estar instalado como `CentralSOSAgent`, em LocalSystem, com privilégios para WTSQueryUserToken.

Build do processo separado:

```powershell
cargo build --manifest-path crates/session-helper/Cargo.toml
```

Para integração real, os dois executáveis devem estar **lado a lado em instalação protegida**, e o Helper deve ser iniciado pelo usuário dentro da sessão interativa. Não rodar Helper via serviço/SYSTEM. O padrão deste executável é asInvoker; não se altera a elevação do Desktop Tauri.

Esta etapa não instala serviço, copia binários, cria tarefa agendada, altera ACL ou adiciona auto-start. Um build na worktree geralmente tem owner/ACL de usuário: será recusado por projeto. A implantação e o auto-start do Helper ficam para etapa específica. Não são relaxadas verificações para viabilizar teste em pasta não confiável.

## Testes

`npm run test:control` inclui schemas, whitelist, contratos serializáveis, recusa de payload/versão/expiração/oversize, delegação e separação machine-safe. Rust Link cobre seleção de sessão/replay/envelopes, e usa pipe Windows real isolado para framing, oversize, timeout e rejeição de contraparte falsa. Agent usa discovery/transport injetados para testar ausência de usuário/Helper sem fallback. Helper testa recusa de coleta como SYSTEM/Session 0.

Esses testes não instalam/iniciam serviço nem alteram impressoras. Não substituem teste instalado Agent SYSTEM → Helper usuário com RDP/lock/logoff reais.

Prova adicional das três coletas no contexto real do usuário (somente leitura, exige sessão desbloqueada):

```powershell
cargo test --manifest-path crates/session-helper/Cargo.toml live_user_read_only_results_obey_the_contract -- --ignored
```

O teste é opt-in porque CI/Session 0 não representa um usuário interativo; nenhum inventário é impresso no console.

## Arquivos

- `crates/link/Cargo.toml`, `crates/link/src/lib.rs`, `crates/link/src/protocol.rs`
- `crates/link/src/session/{mod.rs,windows.rs,tests.rs}`
- `crates/agent/src/{main.rs,engine.rs,runner.rs,session.rs}`
- `crates/session-helper/{Cargo.toml,Cargo.lock,src/main.rs,src/collector.rs}`
- `packages/contracts/control/{SessionHelperContract.ts,CommandPolicy.ts,command-policy.json,contracts.ts}`
- `packages/agent-rules/RulesRuntime.ts`, `src/pages/control/ControlPage.tsx`
- `tests/control/{Security.test.mjs,SessionHelper.test.mjs}`
- `docs/session-helper.md`, atualização da seção Session Helper em `docs/control-agent-updater.md`

Não há alteração de versão do aplicativo/componentes existentes, updater, workflow, endpoint de atualização ou Diagnóstico Geral.

Referências: [segurança de Named Pipes](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights), [flags de estado WTS](https://learn.microsoft.com/en-us/windows/win32/api/wtsapi32/ns-wtsapi32-wtsinfoex_level1_w), [SQOS no CreateFile](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew).
