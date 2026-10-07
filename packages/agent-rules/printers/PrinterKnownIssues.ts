import type { PrinterDiagnosticSnapshot } from '../../contracts/printer-diagnostic';
import { diagnosePort } from './PrinterHealth';
import { isRedirected, isRemotePrinter } from './PrinterPresence';

export interface PrinterKnownIssue {
  id: string;
  severity: 'info' | 'warning' | 'error';
  title: string;
  description: string;
  evidence: string[];
  autoFix: 'startSpooler' | 'resume' | 'cancelErrors' | 'restartSpooler' | null;
  requiresConfirmation: boolean;
  suggestedAction: string;
  physicalIntervention: boolean;
}
type Definition = Omit<PrinterKnownIssue, 'id' | 'evidence'>;
const manual = (title: string, action: string, physicalIntervention = true, severity: Definition['severity'] = 'error'): Definition =>
  ({ title, description: title, suggestedAction: action, severity, physicalIntervention, autoFix: null, requiresConfirmation: false });
const automatic = (title: string, autoFix: Definition['autoFix']): Definition =>
  ({ ...manual(title, 'Verificar e corrigir.', false), autoFix });

export const printerIssueCatalog: Record<string, Definition> = {
  SPOOLER_STOPPED: automatic('Serviço de impressão parado', 'startSpooler'),
  SPOOLER_PAUSED: automatic('Serviço de impressão pausado', 'restartSpooler'),
  PRINTER_PAUSED: automatic('Impressora pausada', 'resume'),
  PRINTER_OFFLINE: manual('Impressora Offline', 'Verifique se a impressora está ligada e conectada.'),
  WORK_OFFLINE: manual('Usar impressora offline está configurado', 'Verifique a conexão e a opção offline nas configurações do Windows.', false, 'warning'),
  DEVICE_NOT_PRESENT: manual('Impressora desconectada', 'Conecte a impressora ao computador.'),
  PORT_DEVICE_MISSING: manual('Dispositivo da porta ausente', 'Conecte a impressora ao computador.'),
  PORT_NOT_REGISTERED: manual('Porta não registrada', 'Verifique a porta configurada.', false),
  PORT_MISMATCH: { ...manual('Possível porta incorreta', 'Confirme a alteração para a porta detectada.', false, 'warning'), requiresConfirmation: true },
  DRIVER_MISSING: manual('Driver ausente', 'Existe um possível problema de driver. Verifique o driver instalado.', false),
  DEVICE_ERROR: manual('Dispositivo com erro no Windows', 'Verifique o dispositivo e seu driver.', false),
  ACCESS_DENIED: manual('Acesso negado', 'Verifique as permissões da impressora.', false),
  REMOTE_QUEUE_UNAVAILABLE: manual('Fila remota indisponível', 'Verifique a conexão com o servidor de impressão.', false),
  QUEUE_UNAVAILABLE: manual('Fila indisponível', 'Verifique o acesso à impressora.', false),
  QUEUE_BLOCKED: automatic('Há trabalhos bloqueados na fila', 'cancelErrors'),
  JOB_ERROR: automatic('Trabalho com erro', 'cancelErrors'),
  JOB_BLOCKED_DRIVER: automatic('Trabalho bloqueado pelo driver', 'cancelErrors'),
  JOB_OFFLINE: manual('Trabalho aguardando impressora offline', 'Verifique se a impressora está ligada e conectada.'),
  JOB_PAPEROUT: manual('Trabalho aguardando papel', 'Adicione papel à impressora.'),
  JOB_PAUSED: { ...manual('Trabalho pausado', 'Verifique o trabalho na Fila.', false, 'warning'), requiresConfirmation: true },
  JOB_USER_INTERVENTION: manual('Trabalho exige intervenção', 'Verifique a indicação no equipamento.'),
  PAPER_OUT: manual('A impressora está sem papel', 'Adicione papel à impressora.'),
  PAPER_LOW: manual('Pouco papel na impressora', 'Reponha o papel.', true, 'warning'),
  PAPER_PROBLEM: manual('Problema na alimentação de papel', 'Verifique o papel na impressora.'),
  PAPER_JAM: manual('Papel preso', 'Remova o papel preso.'),
  DOOR_OPEN: manual('A tampa da impressora está aberta', 'Feche a tampa da impressora.'),
  TONER_LOW: manual('Toner baixo', 'Providencie a reposição do toner.', true, 'warning'),
  NO_TONER: manual('A impressora está sem toner', 'Reponha o toner.'),
  OUTPUT_BIN_FULL: manual('Bandeja de saída cheia', 'Esvazie a bandeja de saída.'),
  USER_INTERVENTION: manual('Intervenção necessária', 'Verifique a indicação no equipamento.'),
  MANUAL_FEED: manual('Alimentação manual solicitada', 'Insira o papel no alimentador manual.'),
  OUT_OF_MEMORY: manual('Memória insuficiente', 'Revise o documento ou a memória da impressora.', false),
  NOT_AVAILABLE: manual('Impressora não disponível', 'Verifique o equipamento e a conexão.', false),
  SERVER_UNKNOWN: manual('Servidor não determinado', 'Verifique o servidor de impressão.', false, 'warning'),
  PAGE_PUNT: manual('Não foi possível imprimir a página', 'Verifique o documento e a indicação na impressora.', false),
  PRINTER_ERROR: manual('Erro reportado pela impressora', 'Consulte os detalhes do Windows e do equipamento.', false),
};
const nativeFlags: [number, string][] = [
  [1,'PRINTER_PAUSED'], [8,'PAPER_JAM'], [0x10,'PAPER_OUT'], [0x20,'MANUAL_FEED'],
  [0x40,'PAPER_PROBLEM'], [0x80,'PRINTER_OFFLINE'], [0x800,'OUTPUT_BIN_FULL'],
  [0x1000,'NOT_AVAILABLE'], [0x20000,'TONER_LOW'], [0x40000,'NO_TONER'],
  [0x80000,'PAGE_PUNT'], [0x100000,'USER_INTERVENTION'], [0x200000,'OUT_OF_MEMORY'],
  [0x400000,'DOOR_OPEN'], [0x800000,'SERVER_UNKNOWN'],
];
const wmiErrors: Record<number,string> = {3:'PAPER_LOW',4:'PAPER_OUT',5:'TONER_LOW',6:'NO_TONER',7:'DOOR_OPEN',8:'PAPER_JAM',9:'USER_INTERVENTION',10:'OUTPUT_BIN_FULL',11:'PAPER_PROBLEM',12:'PAGE_PUNT',13:'USER_INTERVENTION',14:'OUT_OF_MEMORY',15:'SERVER_UNKNOWN'};
const jobFlags: [number,string][] = [[1,'JOB_PAUSED'],[2,'JOB_ERROR'],[0x20,'JOB_OFFLINE'],[0x40,'JOB_PAPEROUT'],[0x200,'JOB_BLOCKED_DRIVER'],[0x400,'JOB_USER_INTERVENTION']];
export function collectPrinterKnownIssues(s: PrinterDiagnosticSnapshot): PrinterKnownIssue[] {
  const issues = new Map<string, PrinterKnownIssue>();
  const add = (id: string, evidence: string) => {
    const existing = issues.get(id);
    if (existing) existing.evidence.push(evidence);
    else issues.set(id, { id, ...printerIssueCatalog[id], evidence: [evidence] });
  };
  const bits = s.printer?.statusBits ?? 0;
  for (const [flag,id] of nativeFlags) if (bits & flag) add(id, `GetPrinter.Status: 0x${flag.toString(16)}`);
  // The generic ERROR flag is reported, but never used to guess its cause.
  if (bits & 2) add('PRINTER_ERROR', 'GetPrinter.Status: ERROR; causa não determinada apenas por este bit.');
  if ((s.printer?.attributes ?? 0) & 0x400) add('WORK_OFFLINE', 'GetPrinter.Attributes: WORK_OFFLINE; não comprova disponibilidade física.');
  for (const field of ['detectedErrorState','extendedDetectedErrorState'] as const) {
    const value = s.deviceStatus?.[field];
    if (value != null && wmiErrors[value]) add(wmiErrors[value], `Win32_Printer.${field}: ${value}`);
  }
  const extended = s.deviceStatus?.extendedPrinterStatus;
  if (extended === 7) add('PRINTER_OFFLINE', 'Win32_Printer.ExtendedPrinterStatus: 7');
  if (extended === 8) add('PRINTER_PAUSED', 'Win32_Printer.ExtendedPrinterStatus: 8');
  if (extended === 11) add('NOT_AVAILABLE', 'Win32_Printer.ExtendedPrinterStatus: 11');
  if (extended === 18) add('MANUAL_FEED', 'Win32_Printer.ExtendedPrinterStatus: 18');
  const port = diagnosePort(s);
  if (port.presence.present === false) {
    add('DEVICE_NOT_PRESENT', port.presence.detail);
    add('PORT_DEVICE_MISSING', port.presence.detail);
  }
  if (!isRedirected(s) && port.registered === false) add('PORT_NOT_REGISTERED', s.printer?.port ?? '');
  if (port.mismatch && port.candidates.length === 1 && port.candidates[0].name.toLowerCase() !== s.printer?.port?.toLowerCase()) add('PORT_MISMATCH', `Atual: ${s.printer?.port}; detectada: ${port.candidates[0].name}; identidade VID/PID única.`);
  if (port.serialFault) add('DEVICE_ERROR', port.presence.detail);
  if ([2,126,1797].includes(s.driverError?.code ?? 0) || s.printer && !s.printer.driver) add('DRIVER_MISSING', s.driverError?.message ?? 'GetPrinter não informou driver.');
  const accessError = [s.printerError, s.queue.error, s.driverError?.message].filter(Boolean).join(' ');
  if (s.driverError?.code === 5 || /(?:código Windows: |Windows )(5)(?:\D|$)|negou acesso/i.test(accessError)) add('ACCESS_DENIED', accessError);
  if (s.printerError || s.queue.error) add(isRemotePrinter(s) ? 'REMOTE_QUEUE_UNAVAILABLE' : 'QUEUE_UNAVAILABLE', accessError);
  if (!isRemotePrinter(s) && !isRedirected(s) && !s.spooler.error) {
    if (s.spooler.state === 1) add('SPOOLER_STOPPED','SCM: STOPPED');
    if (s.spooler.state === 7) add('SPOOLER_PAUSED','SCM: PAUSED');
  }
  if (!s.queue.error) for (const job of s.queue.items) {
    if ((job.statusBits ?? 0) & (4|0x80|0x100|0x1000|0x2000)) continue;
    for (const [flag,id] of jobFlags) if ((job.statusBits ?? 0) & flag) add(id, `JOB_INFO_2 #${job.jobId}: 0x${flag.toString(16)}`);
    if ((job.statusBits ?? 0) & (2|0x200)) add('QUEUE_BLOCKED', `JOB_INFO_2 #${job.jobId}: erro/bloqueio reportado.`);
  }
  const weight = (issue: PrinterKnownIssue) => issue.id === 'DEVICE_NOT_PRESENT' ? -1 : issue.physicalIntervention ? 0 : issue.severity === 'error' ? 1 : 2;
  return [...issues.values()].sort((a,b) => weight(a)-weight(b));
}
export function printerIssueDecision(issue: PrinterKnownIssue): 'physical' | 'confirmation' | 'auto' | 'none' {
  return issue.physicalIntervention ? 'physical' : issue.requiresConfirmation ? 'confirmation' : issue.autoFix ? 'auto' : 'none';
}
export function needsPhysicalIntervention(s: PrinterDiagnosticSnapshot): boolean {
  return collectPrinterKnownIssues(s).some(issue => issue.physicalIntervention);
}
