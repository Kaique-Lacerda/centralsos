import type { PrinterSnapshot, SnapshotCollection } from '../../types/machine';

export type PrinterKind = 'Local' | 'Compartilhada' | 'Remota' | 'Virtual' | 'Não determinado';
export type PrinterSignalState = 'available' | 'attention' | 'problem';

export interface PrinterSignal {
  id: string;
  label: string;
  state: PrinterSignalState;
  detail: string;
}

export function classifyPrinter(printer: PrinterSnapshot): PrinterKind {
  if (printer.shared === true) return 'Compartilhada';
  if (printer.network === true || Boolean(printer.server?.trim())) return 'Remota';
  if (printer.local === true) return 'Local';
  return 'Não determinado';
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
  const kind = classifyPrinter(printer);
  return [
    { id: 'driver', label: 'Driver', state: printer.driver?.trim() ? 'available' : 'attention', detail: printer.driver?.trim() || 'Não disponível' },
    { id: 'port', label: 'Porta', state: printer.port?.trim() ? 'available' : 'attention', detail: printer.port?.trim() || 'Não disponível' },
    { id: 'server', label: 'Servidor', state: printer.server?.trim() ? 'available' : kind === 'Local' ? 'available' : 'attention', detail: printer.server?.trim() || (kind === 'Local' ? 'Local' : 'Não disponível') },
    { id: 'status', label: 'Estado', state: available === false ? 'problem' : available === true ? 'available' : 'attention', detail: printer.status?.trim() || 'Não conclusivo' },
    { id: 'classification', label: 'Tipo', state: kind === 'Não determinado' ? 'attention' : 'available', detail: kind }
  ];
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
