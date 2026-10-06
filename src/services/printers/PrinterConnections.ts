export interface DiscoveredPrinter { name:string;server:string;path:string;description:string|null }
// Future IP installation belongs in a dedicated request requiring port + driver.
// This version supports only Windows shared-printer connections.
export type AddPrinterRequest = { kind:'unc';path:string };
export function validatePrinterUnc(path:string):string|null {
  if (path.length>512||!path.startsWith('\\\\')||/[\u0000-\u001f\u007f/*?"<>|:]/.test(path)) return 'Informe um caminho válido: \\\\servidor\\impressora.';
  const parts=path.slice(2).split('\\');
  return parts.length!==2||parts.some(part=>!part.trim()||part!==part.trim()||['.','..'].includes(part))?'Informe um caminho válido: \\\\servidor\\impressora.':null;
}
