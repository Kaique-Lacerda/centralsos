import type { ValidationResult, ValidationRule, ValidationCategory, InspectionValue } from '../../types';

function result(id: string, title: string, category: ValidationCategory, status: ValidationResult['status'], description: string, expected?: string, actual?: string): ValidationResult {
  return { ruleId: id, title, category, status, severity: status === 'error' ? 'error' : status === 'warning' ? 'warning' : 'info', description, expected, actual };
}
function inspected(id: string, title: string, category: ValidationCategory, inspection: InspectionValue | undefined, expected: string, match: (value: string) => boolean, describe: (value: string) => string): ValidationResult {
  if (!inspection || inspection.value === null) return result(id, title, category, 'ignored', inspection?.error || 'A consulta não foi disponibilizada.', expected, 'Não verificável');
  const ok = match(inspection.value);
  return result(id, title, category, ok ? 'success' : 'error', describe(inspection.value), expected, inspection.value);
}
const rules: ValidationRule[] = [
  { id: 'terminal-uac-enable-lua', name: 'UAC conforme procedimento', category: 'system', profiles: ['terminal'], validate: ({ installation }) => inspected('terminal-uac-enable-lua','UAC conforme procedimento','system',installation?.uacEnableLua,'EnableLUA = 0 (Nunca notificar)',v=>/^0x0$|^0$/i.test(v),v=>/^0x0$|^0$/i.test(v)?'UAC desativado conforme EnableLUA = 0.':'EnableLUA diferente de 0; o estado atual diverge do procedimento.') },
  { id: 'terminal-network-discovery', name: 'Descoberta de rede', category: 'network', profiles: ['terminal'], validate: ({ installation }) => inspected('terminal-network-discovery','Descoberta de rede','network',installation?.networkDiscovery,'Ativada',v=>v==='true',()=> 'A leitura confiável do estado efetivo não está disponível.') },
  { id: 'terminal-device-setup', name: 'Configuração automática de dispositivos', category: 'network', profiles: ['terminal'], validate: ({ installation }) => inspected('terminal-device-setup','Configuração automática de dispositivos','network',installation?.automaticNetworkDeviceSetup,'Ativada',v=>v==='true',()=> 'A leitura confiável do estado efetivo não está disponível.') },
  { id: 'terminal-file-printer-sharing', name: 'Compartilhamento de arquivos e impressoras', category: 'sharing', profiles: ['terminal'], validate: ({ installation }) => inspected('terminal-file-printer-sharing','Compartilhamento de arquivos e impressoras','sharing',installation?.filePrinterSharing,'Ativado',v=>v==='true',()=> 'A leitura confiável do estado efetivo não está disponível.') },
  { id: 'terminal-password-sharing', name: 'Compartilhamento protegido por senha', category: 'sharing', profiles: ['terminal'], validate: ({ installation }) => inspected('terminal-password-sharing','Compartilhamento protegido por senha','sharing',installation?.passwordProtectedSharing,'Desativado',v=>v==='false',()=> 'A leitura confiável do estado efetivo não está disponível.') },
  ...(['system32','syswow64'] as const).map((folder): ValidationRule => ({
    id: `terminal-procedure-dll-${folder}`, name: `DLL do procedimento · ${folder === 'system32' ? 'System32' : 'SysWOW64'}`, category: 'files', profiles: ['terminal'],
    validate: ({ installation }) => {
      if (!installation?.dllFileName) return result(`terminal-procedure-dll-${folder}`,`DLL do procedimento · ${folder === 'system32' ? 'System32' : 'SysWOW64'}`,'files','ignored','O procedimento não definiu o nome esperado da DLL; a regra está pronta para receber esse nome.','Nome exato da DLL do procedimento','Não configurado');
      const check = folder === 'system32' ? installation?.dllSystem32Exists : installation?.dllSyswow64Exists;
      if (!check || check.value === null) return result(`terminal-procedure-dll-${folder}`,`DLL do procedimento · ${folder === 'system32' ? 'System32' : 'SysWOW64'}`,'files','ignored',check?.error || 'A presença do arquivo não pôde ser determinada.','Presente', 'Não verificável');
      const found = check.value === 'true';
      return result(`terminal-procedure-dll-${folder}`,`DLL do procedimento · ${folder === 'system32' ? 'System32' : 'SysWOW64'}`,'files',found?'success':'error',found?'Arquivo encontrado; conteúdo e arquitetura não foram presumidos nem validados.':'Arquivo não encontrado.',`${installation.dllFileName} presente`,`${installation.dllFileName} · ${found?'presente':'ausente'}`);
    }
  })),
  { id: 'terminal-printer-basics', name: 'Ambiente básico de impressão', category: 'printers', profiles: ['terminal'], validate: ({ snapshot }) => {
    if (snapshot.printers.error) return result('terminal-printer-basics','Ambiente básico de impressão','printers','skipped',`Coleta de impressoras indisponível: ${snapshot.printers.error}`,'Dados básicos da impressora','Não verificável');
    if (snapshot.printers.items.length === 0) return result('terminal-printer-basics','Ambiente básico de impressão','printers','skipped','Nenhuma impressora foi retornada; não há uma impressora esperada definida.','Impressoras retornadas pelo Windows','Nenhuma encontrada');
    const complete = snapshot.printers.items.filter(p=>p.name&&p.driver&&p.port).length;
    const summary = snapshot.printers.items.map(p=>`${p.name} (driver: ${p.driver||'indisponível'}, porta: ${p.port||'indisponível'})`).join('; ');
    return result('terminal-printer-basics','Ambiente básico de impressão','printers',complete===snapshot.printers.items.length?'success':'warning',complete===snapshot.printers.items.length?'Nome, driver e porta disponíveis nas impressoras retornadas.':'Há impressoras com informações básicas incompletas.','Nome, driver e porta disponíveis',summary);
  } }
];
export const terminalRules: readonly ValidationRule[] = rules;
