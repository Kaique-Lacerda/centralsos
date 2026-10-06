import type { PrintJobSnapshot } from '../../types/machine';
import type { PrinterQueueActionResult } from '../../types/machine';
import type { RuntimeEnvironment } from '../../types';

export function getPrinterActionAvailability(environment: RuntimeEnvironment): { available: boolean; message: string | null } {
  return environment === 'desktop'
    ? { available: true, message: null }
    : { available: false, message: 'Disponível no Desktop' };
}

export function getPrinterConfigurationActionAvailability(environment: RuntimeEnvironment, isElevated: boolean | undefined): { available: boolean; message: string | null } {
  const runtime = getPrinterActionAvailability(environment);
  if (!runtime.available) return runtime;
  if (isElevated === true) return { available: true, message: null };
  return { available: false, message: isElevated === false
    ? 'Esta operação exige que o CENTRAL SOS seja executado como administrador.'
    : 'Não foi possível confirmar os privilégios administrativos.' };
}

export function getQueueStatus(status: string | null | undefined): string {
  const allowed = ['Imprimindo', 'Aguardando', 'Pausado', 'Erro', 'Cancelando', 'Concluído'];
  return status && allowed.includes(status) ? status : 'Desconhecido';
}

export function getQueueSizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Não informado';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;
}

export function getQueueEmptyMessage(jobs: PrintJobSnapshot[]): string | null {
  return jobs.length === 0 ? 'Nenhum trabalho na fila.' : null;
}

export function getQueueCountLabel(jobs: PrintJobSnapshot[] | null): string {
  const count = jobs?.length ?? 0;
  return count ? `${count} ${count === 1 ? 'trabalho' : 'trabalhos'}` : 'Nenhum trabalho';
}

export function getQueueClearMessage(result: PrinterQueueActionResult): string {
  if (!result.removedCount && !result.failedJobIds.length) return 'Nenhum trabalho na fila.';
  if (result.failedJobIds.length) return `${result.removedCount} ${result.removedCount === 1 ? 'trabalho removido' : 'trabalhos removidos'}; ${result.failedJobIds.length === 1 ? '1 trabalho não pôde ser removido' : `${result.failedJobIds.length} trabalhos não puderam ser removidos`}.`;
  return `${result.removedCount} ${result.removedCount === 1 ? 'trabalho removido' : 'trabalhos removidos'} da fila.`;
}

export function getQueuePagesLabel(totalPages: number | null, pagesPrinted: number | null): string {
  if (totalPages !== null && pagesPrinted !== null) return `${pagesPrinted}/${totalPages}`;
  if (totalPages !== null) return String(totalPages);
  if (pagesPrinted !== null) return `${pagesPrinted} impressas`;
  return 'Não informado';
}

export function getPrinterTestErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/indisponível|não encontrada|não foi encontrada|negou acesso|alcançar o servidor/i.test(message)) return message;
  return 'Não foi possível enviar a página de teste.';
}

export function validatePrinterName(value: string): string | null {
  const name = value.trim();
  if (!name) return 'Informe um nome para a impressora.';
  if (name.length > 220 || /[\\/\u0000-\u001f\u007f]/.test(name)) return 'O nome da impressora contém caracteres inválidos ou excede 220 caracteres.';
  return null;
}

export function validatePrinterShareName(value: string): string | null {
  const name = value.trim();
  if (!name) return 'Informe um nome de compartilhamento.';
  if (name.length > 80 || /[\\/,\u0000-\u001f\u007f]/.test(name)) return 'O nome compartilhado contém caracteres inválidos ou excede 80 caracteres.';
  return null;
}

export function validatePrinterMetadata(value: string, label: string): string | null {
  if (value.length > 1024 || value.includes('\0')) return `${label} excede 1024 caracteres ou contém conteúdo inválido.`;
  return null;
}
