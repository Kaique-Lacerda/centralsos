import type { SupportClient } from './SupportService';
import { collectNetworkIssues, type NetworkKnownIssue } from './NetworkKnownIssues';
import { canCorrectService } from './SupportInterpretation';
import type { WindowsServiceSnapshot } from '../../../packages/contracts/machine';

export async function repairNetwork(client: SupportClient, confirm: (issue: NetworkKnownIssue) => Promise<boolean>) {
  const before = await client.network(); const messages: string[] = [];
  const issues = collectNetworkIssues(before);
  for (const issue of issues) {
    if (!issue.action || issue.id === 'PROXY_CONFIGURED') continue;
    if (issue.requiresConfirmation && !await confirm(issue)) continue;
    try { messages.push(await client.networkAction(issue.action, issue.index ?? null, issue.requiresConfirmation)); }
    catch (error) { messages.push(error instanceof Error ? error.message : String(error)); }
  }
  const after = await client.network();
  return { before, after, messages, remaining: collectNetworkIssues(after) };
}
export async function correctKnownServices(client: SupportClient, services: WindowsServiceSnapshot[]) {
  const results: string[] = [];
  for (const service of services.filter(canCorrectService)) {
    if (!service.name) continue;
    try { const result = await client.serviceAction(service.name, 'start'); results.push(`${service.displayName || service.name}: ${result.after.state === 'Running' ? 'Executando, confirmado pelo Windows.' : 'Estado ainda não confirmado.'}`); }
    catch (error) { results.push(`${service.name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return results;
}
