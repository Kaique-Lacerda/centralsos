import type { PrinterSnapshot, SnapshotCollection } from '../../types/machine';

export type PrinterKind = 'Local' | 'Compartilhada' | 'Remota' | 'Virtual' | 'Não determinado';
export type PrinterConnection = 'USB' | 'COM' | 'TCP-IP' | 'Rede' | 'Compartilhada' | 'Local' | 'Wi-Fi' | 'Não identificado';
export type PrinterSignalState = 'available' | 'attention' | 'problem';
export type PrinterHealth = 'ok' | 'attention' | 'problem' | 'not-validated';

export interface PrinterSignal {
  id: string;
  label: string;
  state: PrinterSignalState;
  detail: string;
}

export interface PrinterTechnicalDetail {
  label: string;
  detected: string;
  expected: string;
  source: string;
}

export function classifyPrinter(printer: PrinterSnapshot): PrinterKind {
  if (printer.shared === true) return 'Compartilhada';
  if (printer.network === true || Boolean(printer.server?.trim())) return 'Remota';
  if (printer.local === true) return 'Local';
  return 'Não determinado';
}

/** Classifica somente quando os metadados do Windows dão evidência suficiente. */
export function classifyPrinterConnection(printer: PrinterSnapshot): PrinterConnection {
  if (printer.shared === true) return 'Compartilhada';
  if (printer.network === true || Boolean(printer.server?.trim())) return 'Rede';

  const port = printer.port?.trim() ?? '';
  if (/^USB\d*$/i.test(port)) return 'USB';
  if (/^COM\d+$/i.test(port)) return 'COM';
  if (/^IP_.+/i.test(port) || /^TCP\s*\/\s*IP\b/i.test(port)) return 'TCP-IP';
  if (printer.local === true) return 'Local';

  // Win32_Printer não identifica com confiabilidade uma conexão Wi-Fi.
  // Não inferimos wireless pelo nome amigável nem por portas WSD.
  return 'Não identificado';
}

export function getPrinterOperationalState(printer: PrinterSnapshot): { label: string; tone: 'success' | 'warning' | 'error' | 'unknown' } {
  const normalized = printer.status?.trim().toLocaleLowerCase('pt-BR');
  if (normalized === 'imprimindo') return { label: 'Imprimindo', tone: 'success' };
  if (normalized === 'ociosa') return { label: 'Ociosa', tone: 'success' };
  if (normalized === 'aquecendo') return { label: 'Conectada', tone: 'success' };
  if (normalized === 'offline') return { label: 'Desconectada', tone: 'error' };
  if (normalized === 'parada') return { label: 'Erro', tone: 'error' };
  return { label: 'Desconhecido', tone: 'unknown' };
}

export function printerAvailability(status: string | null): boolean | null {
  if (!status) return null;
  const normalized = status.trim().toLocaleLowerCase('pt-BR');
  if (['ociosa', 'imprimindo', 'aquecendo'].includes(normalized)) return true;
  if (['parada', 'offline'].includes(normalized)) return false;
  return null;
}

export function getPrinterSignals(printer: PrinterSnapshot): PrinterSignal[] {
  const available = printerAvailability(printer.status);
  const kind = classifyPrinterConnection(printer);
  return [
    { id: 'driver', label: 'Driver', state: printer.driver?.trim() ? 'available' : 'attention', detail: printer.driver?.trim() || 'Não disponível' },
    { id: 'port', label: 'Porta', state: printer.port?.trim() ? 'available' : 'attention', detail: printer.port?.trim() || 'Não disponível' },
    { id: 'server', label: 'Servidor', state: printer.server?.trim() ? 'available' : kind === 'Local' ? 'available' : 'attention', detail: printer.server?.trim() || (kind === 'Local' ? 'Local' : 'Não disponível') },
    { id: 'status', label: 'Estado', state: available === false ? 'problem' : available === true ? 'available' : 'attention', detail: printer.status?.trim() || 'Não conclusivo' },
    { id: 'classification', label: 'Tipo', state: kind === 'Não identificado' ? 'attention' : 'available', detail: kind }
  ];
}

export function getPrinterHealth(printer: PrinterSnapshot): { status: PrinterHealth; label: string; description: string } {
  const availability = printerAvailability(printer.status);
  if (availability === false) return { status: 'problem', label: 'Problema', description: `O Windows informa o estado “${printer.status}”.` };
  if (availability === null && !printer.driver?.trim() && !printer.port?.trim()) {
    return { status: 'not-validated', label: 'Não validado', description: 'O Windows não forneceu estado, driver ou porta suficientes para avaliar esta impressora.' };
  }
  if (!printer.driver?.trim() || !printer.port?.trim() || availability === null) {
    return { status: 'attention', label: 'Atenção', description: 'Há dados de configuração ou estado que não foram informados pelo Windows.' };
  }
  return { status: 'ok', label: 'OK', description: 'O Windows informa a impressora disponível e retornou driver e porta.' };
}

export function getPrinterTechnicalDetails(printer: PrinterSnapshot): PrinterTechnicalDetail[] {
  const sharePath = printer.server && printer.shareName
    ? ['', '', printer.server.replace(/^\\+/, ''), printer.shareName.replace(/^\\+/, '')].join('\\')
    : printer.shareName || null;
  const details: Array<[string, string | null, string]> = [
    ['Nome', printer.name, 'Win32_Printer.Name'],
    ['Nome compartilhado', printer.shareName, 'Win32_Printer.ShareName'],
    ['Caminho do compartilhamento', sharePath, 'Derivado de Win32_Printer.ServerName e ShareName'],
    ['Tipo', classifyPrinterConnection(printer), 'Win32_Printer.Local / Network / Shared / ServerName / PortName'],
    ['Padrão', printer.isDefault ? 'Sim' : 'Não', 'Win32_Printer.Default'],
    ['Driver', printer.driver, 'Win32_Printer.DriverName'],
    ['Porta', printer.port, 'Win32_Printer.PortName'],
    ['Servidor', printer.server, 'Win32_Printer.ServerName'],
    ['Estado', printer.status, 'Win32_Printer.PrinterStatus'],
    ['Compartilhamento', printer.shared === null ? null : printer.shared ? 'Ativado' : 'Desativado', 'Win32_Printer.Shared'],
    ['Permissões de compartilhamento', 'Segurança/ACL: não consultada', 'ACLs não fazem parte do snapshot nesta versão.'],
    ['Localização', printer.location, 'Win32_Printer.Location'],
    ['Comentário', printer.comment, 'Win32_Printer.Comment']
  ];
  return details.map(([label, detected, source]) => ({
    label,
    detected: detected?.trim() || 'Não informado pelo Windows',
    expected: 'Informação somente leitura; o CENTRAL SOS não define um valor esperado.',
    source
  }));
}

export function summarizePrinters(collection: SnapshotCollection<PrinterSnapshot>) {
  const available = collection.items.filter(printer => printerAvailability(printer.status) === true).length;
  const determinedStatusCount = collection.items.filter(printer => printerAvailability(printer.status) !== null).length;
  const sharedOrRemote = collection.items.filter(printer => ['Compartilhada', 'Remota'].includes(classifyPrinter(printer))).length;
  const defaults = collection.items.filter(printer => printer.isDefault).map(printer => printer.name);
  return {
    total: collection.items.length,
    available,
    determinedStatusCount,
    sharedOrRemote,
    defaultPrinters: defaults
  };
}

export function partialCollectionNotice(collection: SnapshotCollection<PrinterSnapshot>): string | null {
  return collection.error ? `Parte dos dados de impressoras não pôde ser consultada: ${collection.error}` : null;
}
