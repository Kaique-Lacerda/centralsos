import { classifyNetworkAdapter, networkConnectionState, selectPrimaryAdapter } from '../network/NetworkDiagnostic';
import { collectNetworkIssues } from '../support/NetworkKnownIssues';
import { isOperationalService } from '../support/SupportInterpretation';
import { isReadOnlyService } from '../support/ServiceSafety';
import { volumeKind } from '../system/VolumePresentation';
import { collectPrinterKnownIssues, needsPhysicalIntervention } from '../../../packages/agent-rules/printers/PrinterKnownIssues';
import { isProblemJob } from '../../../packages/agent-rules/printers/PrinterAutoFix';
import { isRedirected, isRemotePrinter, printerPresence } from '../../../packages/agent-rules/printers/PrinterPresence';
import { diagnosisAreas, type ActionId, type AreaResult, type Confidence, type DiagnosisArea, type DiagnosisObservations, type Finding, type Remediation, type Severity } from './types';

const routes: Record<DiagnosisArea, string> = {
  system: '/tools/system', network: '/tools/network-diagnostic', services: '/tools/windows-services-diagnostic',
  firebird: '/tools/firebird', printing: '/tools/printer-diagnostic', dependencies: '/tools/dependencies', compliance: '/validation',
};
export const manualRemediation = (): Remediation => ({ kind: 'manual', requiresConfirmation: false, safeToBatch: false, revalidationTargets: [] });
export function automatic(actionId: ActionId, targets: DiagnosisArea[], target?: string): Remediation {
  return { kind: 'automatic', actionId, ...(target === undefined ? {} : { target }), requiresConfirmation: true, safeToBatch: true, revalidationTargets: targets };
}
function finding(source: DiagnosisArea, id: string, title: string, severity: Severity, confidence: Confidence, evidence: string[], suggestedAction: string, remediation = manualRemediation(), correlationKey = id): Finding {
  return { id, source, title, description: title, severity, confidence, evidence, suggestedAction, remediation, correlationKey, toolRoute: routes[source] };
}
export function systemFindings(data: DiagnosisObservations): Finding[] {
  const found: Finding[] = [];
  const system = data.system;
  if (!system) return found;
  for (const volume of system.volumes.items) {
    const label = `${volume.unit} · ${volumeKind(volume.driveType)}`;
    if (!volume.totalBytes || volume.freeBytes === null || volume.driveType === 5) {
      found.push(finding('system', `volume.inventory.${volume.unit}`, `${label}: capacidade não determinada`, 'info', 'inconclusive', ['Ausência de tamanho não comprova falha de armazenamento.'], 'Consulte a mídia e os detalhes em Sistema.'));
    } else if (volume.freeBytes < 2 * 1024 ** 3 || volume.freeBytes / volume.totalBytes < .05) {
      found.push(finding('system', `volume.space.${volume.unit}`, `Espaço crítico em ${volume.unit}`, 'problem', 'confirmed', [`${volume.freeBytes} bytes livres de ${volume.totalBytes} · ${volumeKind(volume.driveType)}`], 'Revise os arquivos e o espaço livre em Sistema. Nenhum arquivo será removido automaticamente.'));
    }
  }
  if (system.rebootReasons.length) found.push(finding('system', 'system.reboot', 'Windows indica reinicialização pendente', 'warning', 'confirmed', system.rebootReasons, 'Salve o trabalho e combine uma reinicialização manual.'));
  if (system.timeSync.state === 'warning' || system.timeSync.state === 'error') {
    // Code 3 is the parsed Windows Time leap indicator, not a guessed cause from an error string.
    const explicitUnsynced = system.timeSync.code === 3;
    const enabled = ['Auto', 'Manual'].includes(system.timeService?.startMode ?? '');
    found.push(finding('system', 'system.time', explicitUnsynced ? 'Horário do Windows não sincronizado' : 'Sincronização de horário requer verificação', 'warning', explicitUnsynced ? 'confirmed' : 'inconclusive', [system.timeSync.message], 'Confira a fonte de horário. Sincronizar pode ajustar o relógio e iniciar o Windows Time.', explicitUnsynced && enabled ? automatic('system.syncTime', ['system']) : manualRemediation()));
  }
  return found;
}

export function networkFindings(data: DiagnosisObservations): Finding[] {
  const network = data.network;
  if (!network) return [];
  const externalOk = network.external.dns.state === 'success' && network.external.tcp.state === 'success';
  const primary = selectPrimaryAdapter(network.adapters.items).adapter;
  const found = collectNetworkIssues(network).map((issue, index) => {
    const contextual = ['NETWORK_MEDIA_DISCONNECTED', 'VPN_DISCONNECTED', 'PROXY_CONFIGURED', 'MULTIPLE_DEFAULT_GATEWAYS', 'NETWORK_ADAPTER_DISABLED'].includes(issue.id)
      || externalOk && ['DEFAULT_GATEWAY_MISSING', 'DNS_MISSING', 'DNS_UNREACHABLE'].includes(issue.id);
    const severity: Severity = contextual ? 'info' : 'warning';
    const confidence: Confidence = ['DNS_UNREACHABLE', 'INTERNET_UNREACHABLE'].includes(issue.id) ? 'probable' : 'confirmed';
    const key = ['DNS_UNREACHABLE', 'DNS_RESOLUTION_FAILED', 'INTERNET_UNREACHABLE'].includes(issue.id) ? 'network.connectivity'
      : ['APIPA_ADDRESS', 'DHCP_FAILED'].includes(issue.id) ? `network.address.${issue.evidence[0]}` : `network.${issue.id}.${index}`;
    const remediation: Remediation = issue.action === 'flushDns' && issue.autoFix ? automatic('network.flushDns', ['network'])
      : issue.action ? { kind: 'assisted', requiresConfirmation: true, safeToBatch: false, revalidationTargets: ['network'] } : manualRemediation();
    return finding('network', `network.${issue.id}.${index}`, issue.description, severity, confidence, [issue.id, ...issue.evidence], issue.suggestedAction, remediation, key);
  });
  const connected = network.adapters.items.filter(a => classifyNetworkAdapter(a) !== 'Sistema' && networkConnectionState(a.status) === 'connected');
  if (!network.adapters.error && !connected.length && !externalOk) found.push(finding('network', 'network.offline', 'Nenhuma interface conectada foi encontrada', 'warning', 'confirmed', network.adapters.items.map(a => `${a.name}: mídia ${a.status}; administrativo ${a.netEnabled === false ? 'desabilitado' : a.netEnabled === true ? 'habilitado' : 'não determinado'}`), 'Confira cabo, Wi-Fi e conexão esperada. Uma interface sem mídia não está necessariamente desabilitada.'));
  found.push(finding('network', 'network.context', primary ? `Conexão principal: ${primary.name}` : 'Conexão principal não determinada', 'info', primary ? 'confirmed' : 'inconclusive', primary ? [...primary.ipv4, ...primary.gateways, ...primary.dnsServers] : ['Múltiplas interfaces ou evidência insuficiente; nenhuma conexão foi escolhida arbitrariamente.'], 'Consulte as interfaces e rotas em Rede.'));
  return found;
}

export function serviceFindings(data: DiagnosisObservations): Finding[] {
  const criticalExpectedRunning = new Set(['rpcss', 'rpceptmapper', 'dcomlaunch', 'eventlog', 'lsm', 'samss']);
  return (data.services?.items ?? []).flatMap(service => {
    const name = service.name ?? '';
    const critical = criticalExpectedRunning.has(name.toLowerCase());
    // Firebird and printing contribute through their own correlation layers.
    if (/^(spooler|firebird)/i.test(name) || !critical && !isOperationalService(service)) return [];
    if (service.state !== 'Stopped' || !critical && service.startMode !== 'Auto') return [];
    const fix = !isReadOnlyService(service) && isOperationalService(service) && service.startMode === 'Auto';
    return [finding('services', `service.${name}`, `${service.displayName || name} está parado`, 'problem', 'confirmed', [`${name} · ${service.state} · ${service.startMode}`, service.pathName ?? 'Executável não informado'], critical ? 'Serviço estrutural: somente leitura. Investigue o Windows e seus eventos; não pare nem reinicie este serviço pela ferramenta.' : 'Iniciar somente o serviço de suporte identificado e consultar novamente seu estado.', fix ? automatic('service.start', ['services'], name) : manualRemediation())];
  });
}

export function firebirdFindings(data: DiagnosisObservations): Finding[] {
  const f = data.firebird;
  if (!f) return [];
  const relevant = f.database.exists === true || f.installations.items.length > 0 || f.services.items.length > 0 || f.processes.items.length > 0;
  if (!relevant) return [];
  const unavailable = ['error', 'timeout'].includes(f.port.tcp.state);
  const missing = !f.installations.error && !f.services.error && !f.processes.error && !f.installations.items.length && !f.services.items.length && !f.processes.items.length;
  const found: Finding[] = [];
  if (unavailable) {
    const stopped = f.services.items.filter(s => isOperationalService(s) && !isReadOnlyService(s) && s.state === 'Stopped' && s.startMode === 'Auto');
    const fix = stopped.length === 1 && !f.services.error && f.port.listeners.length === 0 && !f.port.listenerError;
    const rem = fix ? automatic('service.start', ['firebird', 'services'], stopped[0].name!) : manualRemediation();
    const add = (id: string, evidence: string, confidence: Confidence = 'confirmed') => {
      const item = finding('firebird', `firebird.${id}`, 'Firebird indisponível', 'problem', confidence, [evidence], fix ? 'Iniciar a instância identificada e revalidar serviço, processo e TCP 3050.' : 'Abra Firebird e confirme a instalação/instância e o acesso à porta 3050. Nenhuma instalação será executada.', rem, 'firebird.unavailable');
      item.description = f.database.exists === true ? 'Banco AUTOCOM encontrado, mas o endpoint local 127.0.0.1:3050 não respondeu ao teste TCP.' : 'O endpoint local 127.0.0.1:3050 não respondeu ao teste TCP. Consulte os dados da instância identificada.';
      found.push(item);
    };
    add('tcp', `127.0.0.1:3050 · ${f.port.tcp.state}: ${f.port.tcp.message}`, unavailable ? 'confirmed' : 'inconclusive');
    if (f.database.exists === true) add('database', `Banco encontrado: ${f.database.path}`);
    if (!f.installations.error && !f.installations.items.length) add('installation', 'Instalação não encontrada.');
    if (!f.services.error && !f.services.items.length) add('service', 'Serviço não encontrado.');
    if (!f.processes.error && !f.processes.items.length) add('process', 'Processo não encontrado.');
    if (stopped.length) add('stopped', stopped.map(s => `${s.name}: parado`).join('; '));
  }
  else if (missing && f.port.tcp.state !== 'success') found.push(finding('firebird', 'firebird.unknown', 'Disponibilidade do Firebird não confirmada', 'warning', 'inconclusive', [f.port.tcp.message, 'Sem instalação, serviço ou processo nas fontes consultadas.'], 'Confirme a instância e o endpoint em Firebird. A consulta inconclusiva não comprova indisponibilidade.'));
  if (f.port.tcp.state === 'success') {
    const conflicts = f.port.listeners.filter(l => l.processName && !/^(fbserver|fb_inet_server|firebird)\.exe$/i.test(l.processName));
    if (conflicts.length) found.push(finding('firebird', 'firebird.port.conflict', 'TCP 3050 associado a outro processo', 'warning', 'confirmed', conflicts.map(l => `${l.processName} · PID ${l.pid} · ${l.address}:${l.port}`), 'Confirme a instância e o processo em Firebird. Nenhum processo será encerrado.'));
    else found.push(finding('firebird', 'firebird.tcp.context', 'TCP 3050 acessível no endpoint local', 'info', 'confirmed', [f.port.tcp.message, 'O teste TCP não valida o protocolo Firebird nem autenticação/acesso lógico ao banco.'], 'Consulte os dados da instância em Firebird.'));
  }
  if (f.database.exists === true && f.database.readAccess === false) found.push(finding('firebird', 'firebird.database.access', 'Banco AUTOCOM sem acesso de leitura', 'problem', 'confirmed', [f.database.path], 'Confira a conta e as permissões em Firebird. Não será alterada a ACL do arquivo.'));
  return found;
}

export function printingFindings(data: DiagnosisObservations): Finding[] {
  const p = data.printing;
  if (!p) return [];
  const found: Finding[] = [];
  const stopped = !p.spooler.error && p.spooler.state === 1;
  if (stopped) found.push(finding('printing', 'printing.spooler', 'Serviço de impressão parado', 'problem', 'confirmed', [`SCM: STOPPED · inicialização ${p.spooler.startMode}`], 'Iniciar o Spooler e verificar novamente o serviço e o acesso às filas.', p.elevated && [2, 3].includes(p.spooler.startMode ?? 0) ? automatic('spooler.start', ['printing']) : manualRemediation()));
  else if (!p.spooler.error && p.spooler.state === 7) found.push(finding('printing', 'printing.spooler.paused', 'Serviço de impressão pausado', 'problem', 'confirmed', ['SCM: PAUSED'], 'Abra Impressoras para avaliar o reinício do Spooler e o impacto sobre todas as filas.'));
  if (p.printers.length && !p.printers.some(p => p.isDefault)) found.push(finding('printing', 'printing.default.context', 'Nenhuma impressora padrão informada', 'info', 'confirmed', ['Há impressoras cadastradas, mas nenhuma foi reportada como padrão.'], 'A necessidade de uma impressora padrão depende do uso. Nenhuma será escolhida automaticamente.'));
  for (const printer of p.printers) {
    const s = printer.snapshot;
    if (!s) continue;
    const local = !isRemotePrinter(s) && !isRedirected(s);
    const safe = local && s.isElevated && !needsPhysicalIntervention(s) && !s.queue.error && !!s.printer && !s.printerError;
    for (const issue of collectPrinterKnownIssues(s)) {
      if (issue.id.startsWith('SPOOLER_') || stopped && ['QUEUE_UNAVAILABLE', 'ACCESS_DENIED'].includes(issue.id)) continue;
      let remediation = manualRemediation();
      if (issue.id === 'PORT_MISMATCH') remediation = { kind: 'assisted', requiresConfirmation: true, safeToBatch: false, revalidationTargets: ['printing'] };
      if (safe && issue.autoFix === 'resume') remediation = automatic('printer.resume', ['printing'], printer.name);
      if (safe && issue.autoFix === 'cancelErrors' && s.queue.items.some(isProblemJob)) remediation = automatic('printer.cancelErrors', ['printing'], printer.name);
      const group = ['DEVICE_NOT_PRESENT', 'PORT_DEVICE_MISSING'].includes(issue.id) ? 'device'
        : ['QUEUE_BLOCKED', 'JOB_ERROR', 'JOB_BLOCKED_DRIVER'].includes(issue.id) ? 'jobs' : issue.id;
      found.push(finding('printing', `printer.${encodeURIComponent(printer.name)}.${issue.id}`, `${printer.name}: ${issue.title}`, issue.severity === 'error' ? 'problem' : 'warning', ['PORT_MISMATCH', 'DEVICE_NOT_PRESENT', 'PORT_DEVICE_MISSING'].includes(issue.id) ? 'probable' : 'confirmed', issue.evidence, issue.autoFix === 'cancelErrors' ? 'Cancelar somente jobs que ainda reportem ERROR/BLOCKED_DEVQ, sem espera por papel ou intervenção. Os documentos cancelados precisarão ser reenviados.' : issue.suggestedAction, remediation, `printer.${encodeURIComponent(printer.name)}.${group}`));
    }
    const presence = printerPresence(s);
    if (printer.isDefault && presence.applicable && presence.present === null && !stopped) found.push(finding('printing', `printer.${encodeURIComponent(printer.name)}.unconfirmed`, 'Impressora padrão: dispositivo físico não confirmado', 'warning', 'inconclusive', [printer.name, presence.detail], 'Confirme alimentação, cabo e comunicação no equipamento. A falta de associação PnP não comprova desconexão.'));
  }
  return found;
}

export function collectFindings(data: DiagnosisObservations): Finding[] {
  const findings = [...systemFindings(data), ...networkFindings(data), ...serviceFindings(data), ...firebirdFindings(data), ...printingFindings(data)];
  for (const software of data.dependencies?.items ?? []) findings.push(finding('dependencies', `dependency.${software.name}.${software.version}`, software.name, 'info', 'confirmed', [software.version ?? 'Versão não determinada', software.architecture ?? 'Arquitetura não determinada', software.location ?? 'Local não determinado'], 'Inventário. Não há requisito de versão configurado para gerar um incidente.'));
  for (const result of data.compliance?.results ?? []) if (result.status !== 'success') findings.push(finding('compliance', `compliance.${result.ruleId}`, result.title, 'info', ['ignored', 'skipped'].includes(result.status) ? 'inconclusive' : 'confirmed', [`Conformidade: ${result.status}`, result.actual ?? result.description, `Esperado: ${result.expected ?? 'Consulte o baseline'}`], 'Consulte Conformidade. Este desvio não comprova uma causa operacional.'));
  for (const area of diagnosisAreas) if (data.errors[area]) findings.push(finding(area, `collection.${area}`, `Coleta de ${area} inconclusiva`, 'info', 'inconclusive', [data.errors[area]!], 'Repita a consulta ou investigue a ferramenta especializada. Nenhum estado saudável foi inferido desta falha.'));
  return findings;
}

export function areaResults(data: DiagnosisObservations, findings: Finding[]): AreaResult[] {
  const partial: Partial<Record<DiagnosisArea, boolean>> = {
    system: !data.machine?.system.operatingSystem || !!data.machine?.system.error || !!data.system?.volumes.error || !!data.system?.rebootError || data.system?.timeSync.state === 'unknown' || data.system?.timeSync.state === 'timeout',
    network: !!data.network?.adapters.error || !!data.network?.routes.error || data.network?.external.dns.state === 'unknown' || data.network?.external.tcp.state === 'unknown' || !!data.network?.proxies.some(p => p.error),
    services: !!data.services?.error,
    firebird: !!data.firebird?.services.error || !!data.firebird?.processes.error || !!data.firebird?.installations.error || !!data.firebird?.database.error || data.firebird?.database.exists === null || data.firebird?.port.tcp.state === 'unknown',
    printing: !!data.printing?.inventoryError || !!data.printing?.spooler.error || data.printing?.spooler.state == null || !!data.printing?.printers.some(p => p.error || p.snapshot?.queue.error || p.snapshot?.printerError || p.snapshot?.ports.error || p.snapshot?.deviceStatusError),
    dependencies: !!data.dependencies?.error,
  };
  return diagnosisAreas.map(area => {
    if (area === 'compliance') return { area, state: data.errors.compliance ? 'inconclusive' : 'skipped', detail: data.errors.compliance ?? (data.compliance ? 'Baseline separado; não integra a contagem de saúde operacional.' : 'Perfil não configurado; baseline não executado.') };
    if (area === 'firebird' && data.firebird && !data.errors.firebird && !partial.firebird && data.firebird.database.exists === false && !data.firebird.installations.items.length && !data.firebird.services.items.length && !data.firebird.processes.items.length) return { area, state: 'skipped', detail: 'Nenhum banco ou componente Firebird encontrado. A exigência do perfil permanece na Conformidade.' };
    const available = area === 'printing' ? data.printing : data[area];
    const incomplete = !!data.errors[area] || !!partial[area] || !available;
    const issues = findings.some(f => f.source === area && f.severity !== 'info');
    return { area, state: incomplete ? 'inconclusive' : issues ? 'issues' : 'healthy', detail: incomplete ? data.errors[area] ?? 'Há informações não verificáveis; consulte os detalhes técnicos.' : issues ? 'Foram encontrados sinais operacionais que exigem atenção.' : 'Sem incidentes nos dados verificados. Não equivale a testar todos os componentes.' };
  });
}
