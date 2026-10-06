import type { ToolDefinition } from '../types';
export const toolRegistry: ToolDefinition[] = [
  { id: 'computer-diagnostic', name: 'Computador', description: 'Consulte informações locais do computador.', category: 'Computador', path: '/tools/computer-diagnostic', availableOn: ['desktop'], enabled: true },
  { id: 'printer-diagnostic', name: 'Impressoras', description: 'Consulte e gerencie impressoras, filas e página de teste.', category: 'Impressoras', path: '/tools/printer-diagnostic', availableOn: ['desktop', 'web'], enabled: true },
  { id: 'network-diagnostic', name: 'Rede', description: 'Consulte interfaces, endereços, gateways, DNS e conexão principal.', category: 'Rede', path: '/tools/network-diagnostic', availableOn: ['desktop'], enabled: true },
  { id: 'connectivity', name: 'Conectividade', description: 'Teste DNS, ping e portas TCP de um destino.', category: 'Rede', path: '/tools/connectivity', availableOn: ['desktop'], enabled: true },
  { id: 'windows-services-diagnostic', name: 'Serviços', description: 'Consulte e opere serviços com ações explícitas.', category: 'Serviços', path: '/tools/windows-services-diagnostic', availableOn: ['desktop'], enabled: true },
  { id: 'firebird', name: 'Firebird', description: 'Confira serviços, porta 3050 e banco AUTOCOM.', category: 'Banco', path: '/tools/firebird', availableOn: ['desktop'], enabled: true },
  { id: 'shares', name: 'Compartilhamentos', description: 'Teste acesso SMB e liste compartilhamentos.', category: 'Rede', path: '/tools/shares', availableOn: ['desktop'], enabled: true },
  { id: 'system-support', name: 'Sistema', description: 'Confira disco, horário, reboot e temporários.', category: 'Sistema', path: '/tools/system', availableOn: ['desktop'], enabled: true },
  { id: 'processes', name: 'Processos', description: 'Pesquise aplicações e processos em execução.', category: 'Sistema', path: '/tools/processes', availableOn: ['desktop'], enabled: true },
  { id: 'dependencies', name: 'Dependências', description: 'Consulte runtimes e versões presentes.', category: 'Sistema', path: '/tools/dependencies', availableOn: ['desktop'], enabled: true }
];
