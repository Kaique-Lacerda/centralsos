# Diagnóstico Geral e remediação local

`/validation` oferece Diagnóstico operacional e Conformidade SOS separados. Nenhuma coleta começa ao montar a página. As ferramentas especializadas permanecem disponíveis.

## Camadas

- `DiagnosisCollector`: adapta MachineSnapshot, SupportService, WindowsServicesService e PrinterService. Captura falhas por área e reutiliza o snapshot base para impressoras e Conformidade.
- `Findings`: interpreta dados efetivamente coletados, preservando inventário e informações inconclusivas.
- `Correlation`: agrupa sinais por chave explícita. Conformidade e findings informativos não viram incidentes operacionais.
- `RemediationPolicy` e `DiagnosisEngine`: permitem apenas ações conhecidas, serializam execução, consultam o estado antes da ação e revalidam a área depois.
- `GeneralDiagnosisPanel`: resumo, incidentes, evidências recolhidas e confirmação do plano.

Finding, Incident, DiagnosisResult e RemediationAttempt contêm somente dados serializáveis. Não há transporte remoto neste marco.

## Correções permitidas

Todas exigem confirmação do plano. Nenhuma instalação é executada.

- Iniciar Spooler identificado como parado, habilitado e com elevação confirmada. A resolução exige serviço em execução e acesso às filas coletadas.
- Retomar impressora local pausada, sem sinais físicos que contraindiquem a ação.
- Cancelar somente jobs que ainda reportem ERROR/BLOCKED_DEVQ e não estejam aguardando papel, dispositivo ou intervenção. O backend revalida cada job. Documentos cancelados precisam ser reenviados.
- Iniciar serviço de suporte reconhecido, com inicialização Auto e estado Stopped. Serviços críticos seguem bloqueados pelo Rust e ficam somente leitura na UI.
- Sincronizar horário somente com indicador de salto 3 e Windows Time habilitado. A operação existente pode iniciar o serviço e ajustar o relógio; não muda a fonte NTP.
- Limpar cache DNS somente se o resolver falhar enquanto um DNS configurado responder diretamente.

`system.timeSync.code` contém o indicador de salto extraído pelo Rust (0–3), ou null quando a consulta falha/não reconhece o idioma. Não se decide sincronização por busca textual de uma mensagem de erro.

Falhas de ação e de revalidação são registradas individualmente. Incidentes não verificáveis permanecem visíveis mesmo após outras ações do lote. resolved indica resolução do incidente observado, não certificação de todo o subsistema.

## Limites

- TCP 3050 não valida protocolo/autenticação Firebird nem integridade do FDB.
- O teste externo existente usa github.com:443; uma falha não comprova indisponibilidade de toda a Internet.
- VPN não exige gateway/DNS próprios. Mídia desconectada não implica interface administrativamente desabilitada.
- A associação PnP ausente não comprova que uma impressora USB esteja desligada. Impressora padrão inconclusiva recebe orientação manual.
- Dependências são inventário: não existe requisito de produto/versão configurado neste motor.
- Tipos de volume vêm de Win32_LogicalDisk.DriveType; mídia sem tamanho é informação, não problema automático.
- Revalidação usa as coletas especializadas existentes; elas podem repetir consultas WMI internas. O snapshot base não é coletado a cada renderização.
- Após uma correção de impressão, são reconsultadas as impressoras do inventário inicial. Uma nova verificação completa atualiza o inventário de filas adicionadas/removidas.

Testes usam fixtures e clientes injetados. Não alteram serviços, filas ou configurações reais do Windows.

Referências dos campos nativos: [Win32_LogicalDisk](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-logicaldisk) e [MultiByteToWideChar](https://learn.microsoft.com/en-us/windows/win32/api/stringapiset/nf-stringapiset-multibytetowidechar).

## Arquivos desta etapa

Criados:

- `src/services/diagnosis/types.ts`
- `src/services/diagnosis/DiagnosisCollector.ts`
- `src/services/diagnosis/Findings.ts`
- `src/services/diagnosis/Correlation.ts`
- `src/services/diagnosis/RemediationPolicy.ts`
- `src/services/diagnosis/DiagnosisEngine.ts`
- `src/services/diagnosis/GeneralDiagnosisService.ts`
- `src/services/diagnosis/tests/fixtures.mjs`
- `src/services/diagnosis/tests/Diagnosis.test.mjs`
- `src/services/diagnosis/tests/DiagnosisUI.test.mjs`
- `src/services/support/ServiceSafety.ts`
- `src/services/system/VolumePresentation.ts`
- `src/pages/GeneralDiagnosisPanel.tsx`
- `src/general-diagnosis.css`
- `docs/general-diagnosis.md`

Alterados:

- `package.json` (script de testes)
- `src/pages/Pages.tsx` (abas e reutilização da Conformidade já coletada)
- `src/pages/NetworkDiagnosticPage.tsx` (mídia e estado administrativo separados)
- `src/pages/WindowsServicesDiagnosticPage.tsx` (serviços críticos somente leitura)
- `src/pages/support/SystemPage.tsx` (tipo de volume e ausência de capacidade)
- `src/services/network/NetworkDiagnostic.ts` (estado administrativo explícito)
- `src/services/support/NetworkKnownIssues.ts` (VPN sem exigência genérica de gateway/DNS)
- `src/services/printers/PrinterService.ts` (exposição da operação existente de cancelamento seguro)
- `src/types/machine.ts` (tipo do volume opcional)
- `src-tauri/src/models/machine.rs` (contrato de tipo do volume, compatível com snapshots antigos)
- `src-tauri/src/services/storage.rs` (DriveType na consulta existente)
- `src-tauri/src/services/support/services.rs` (proteção do RPC Endpoint Mapper e testes de serviços críticos)
- `src-tauri/src/services/support/system.rs` (encoding do horário e indicador tipado)
