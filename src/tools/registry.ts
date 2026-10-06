import type { ToolDefinition } from '../types';
export const toolRegistry: ToolDefinition[] = [
  { id: 'computer-diagnostic', name: 'Computador', description: 'Consulte informações locais do computador.', category: 'Computador', path: '/tools/computer-diagnostic', availableOn: ['desktop'], enabled: true },
  { id: 'printer-diagnostic', name: 'Impressoras', description: 'Consulte e gerencie impressoras, filas e página de teste.', category: 'Impressoras', path: '/tools/printer-diagnostic', availableOn: ['desktop', 'web'], enabled: true },
  { id: 'network-diagnostic', name: 'Rede', description: 'Consulte interfaces, endereços, gateways, DNS e conexão principal.', category: 'Rede', path: '/tools/network-diagnostic', availableOn: ['desktop'], enabled: true },
  { id: 'windows-services-diagnostic', name: 'Serviços', description: 'Consulte serviços do Windows, estado e inicialização.', category: 'Serviços', path: '/tools/windows-services-diagnostic', availableOn: ['desktop'], enabled: true }
];
