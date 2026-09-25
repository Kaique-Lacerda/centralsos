import type { MachineRole } from '../../../../types';
import type { ValidationContext, ValidationResult, ValidationRule } from '../../types';

const bothProfiles: readonly MachineRole[] = ['terminal', 'server'];

export const storageAvailableRule: ValidationRule = {
  id: 'storage-available',
  name: 'Armazenamento disponível',
  category: 'storage',
  profiles: bothProfiles,
  validate({ snapshot }: ValidationContext): ValidationResult {
    if (snapshot.storage.error) {
      return { ruleId: 'storage-available', title: 'Armazenamento disponível', category: 'storage', status: 'skipped', severity: 'info', description: 'A consulta de armazenamento não pôde ser concluída.', expected: 'Ao menos um volume consultável', actual: 'Não verificado' };
    }
    const count = snapshot.storage.items.length;
    return count > 0
      ? { ruleId: 'storage-available', title: 'Armazenamento disponível', category: 'storage', status: 'success', severity: 'info', description: 'A coleta encontrou volumes de armazenamento.', expected: 'Ao menos um volume', actual: `${count} volume(s)` }
      : { ruleId: 'storage-available', title: 'Armazenamento disponível', category: 'storage', status: 'warning', severity: 'warning', description: 'A coleta não encontrou volumes de armazenamento.', expected: 'Ao menos um volume', actual: 'Nenhum volume retornado', suggestedAction: 'Confirme se os volumes locais estão disponíveis.' };
  }
};

function isConnected(status: string | null): boolean {
  return status?.trim().toLocaleLowerCase() === 'conectado' || status?.trim().toLocaleLowerCase() === 'connected';
}

export const activeNetworkAdapterRule: ValidationRule = {
  id: 'network-active-adapter',
  name: 'Adaptador de rede ativo',
  category: 'network',
  profiles: bothProfiles,
  validate({ snapshot }: ValidationContext): ValidationResult {
    if (snapshot.network.error) {
      return { ruleId: 'network-active-adapter', title: 'Adaptador de rede ativo', category: 'network', status: 'skipped', severity: 'info', description: 'A consulta dos adaptadores não pôde ser concluída.', expected: 'Ao menos um adaptador conectado', actual: 'Não verificado' };
    }
    const connected = snapshot.network.items.find(adapter => isConnected(adapter.status));
    if (connected) {
      return { ruleId: 'network-active-adapter', title: 'Adaptador de rede ativo', category: 'network', status: 'success', severity: 'info', description: 'Foi encontrado um adaptador conectado.', expected: 'Ao menos um adaptador conectado', actual: `${connected.name} · ${connected.status}` };
    }
    if (snapshot.network.items.length > 0 && snapshot.network.items.every(adapter => !adapter.status)) {
      return { ruleId: 'network-active-adapter', title: 'Adaptador de rede ativo', category: 'network', status: 'skipped', severity: 'info', description: 'O estado dos adaptadores não está disponível para verificação.', expected: 'Ao menos um adaptador conectado', actual: 'Status não informado' };
    }
    return { ruleId: 'network-active-adapter', title: 'Adaptador de rede ativo', category: 'network', status: 'warning', severity: 'warning', description: 'Nenhum adaptador foi identificado como conectado.', expected: 'Ao menos um adaptador conectado', actual: snapshot.network.items.length ? 'Nenhum conectado' : 'Nenhum adaptador retornado', suggestedAction: 'Verifique a conexão e o estado dos adaptadores de rede.' };
  }
};

const offlinePrinterStatuses = new Set(['offline', 'parada', 'stopped']);
const unknownPrinterStatuses = new Set(['desconhecido', 'unknown', 'outro', 'other']);

export const defaultPrinterStatusRule: ValidationRule = {
  id: 'printers-default-status',
  name: 'Estado da impressora padrão',
  category: 'printers',
  profiles: bothProfiles,
  validate({ snapshot }: ValidationContext): ValidationResult {
    if (snapshot.printers.error) {
      return { ruleId: 'printers-default-status', title: 'Estado da impressora padrão', category: 'printers', status: 'skipped', severity: 'info', description: 'A consulta de impressoras não pôde ser concluída.', expected: 'Estado consultável quando houver impressora padrão', actual: 'Não verificado' };
    }
    const defaults = snapshot.printers.items.filter(printer => printer.isDefault);
    if (defaults.length === 0) {
      return { ruleId: 'printers-default-status', title: 'Estado da impressora padrão', category: 'printers', status: 'skipped', severity: 'info', description: 'Não há impressora padrão cujo estado possa ser verificado.', expected: 'Sem impressora padrão configurada', actual: 'Não aplicável' };
    }
    const offline = defaults.find(printer => printer.status && offlinePrinterStatuses.has(printer.status.trim().toLocaleLowerCase()));
    if (offline) {
      return { ruleId: 'printers-default-status', title: 'Estado da impressora padrão', category: 'printers', status: 'warning', severity: 'warning', description: 'A impressora padrão informa estado offline ou parada.', expected: 'Impressora padrão disponível', actual: `${offline.name} · ${offline.status}`, suggestedAction: 'Verifique a impressora e sua conexão.' };
    }
    if (defaults.some(printer => !printer.status || unknownPrinterStatuses.has(printer.status.trim().toLocaleLowerCase()))) {
      return { ruleId: 'printers-default-status', title: 'Estado da impressora padrão', category: 'printers', status: 'skipped', severity: 'info', description: 'O estado informado não permite confirmar a disponibilidade da impressora padrão.', expected: 'Estado conhecido e disponível', actual: 'Estado não conclusivo' };
    }
    return { ruleId: 'printers-default-status', title: 'Estado da impressora padrão', category: 'printers', status: 'success', severity: 'info', description: 'A impressora padrão não informa estado offline ou parado.', expected: 'Impressora padrão disponível', actual: defaults.map(printer => `${printer.name} · ${printer.status}`).join('; ') };
  }
};

export const resourceRules: readonly ValidationRule[] = [
  storageAvailableRule,
  activeNetworkAdapterRule,
  defaultPrinterStatusRule
];
