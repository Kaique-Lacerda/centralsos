import type { ToolDefinition } from '../types';
export const toolRegistry: ToolDefinition[] = [
  { id: 'computer-diagnostic', name: 'Diagnóstico do Computador', description: 'Consulte informações básicas do sistema local.', category: 'Sistema', path: '/tools/computer-diagnostic', availableOn: ['desktop'], enabled: true },
  { id: 'printer-diagnostic', name: 'Diagnóstico de Impressoras', description: 'Consulte impressoras, padrão, driver, porta, conexão e status.', category: 'Impressão', path: '/tools/printer-diagnostic', availableOn: ['desktop'], enabled: true },
  { id: 'network-diagnostic', name: 'Diagnóstico de Rede', description: 'Normalize interfaces, endereços, gateways, DNS e conexão principal.', category: 'Rede', path: '/tools/network-diagnostic', availableOn: ['desktop'], enabled: true }
];
