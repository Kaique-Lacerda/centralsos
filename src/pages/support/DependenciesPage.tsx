import { useState } from 'react';
import { Puzzle } from 'lucide-react';
import { SupportService } from '../../services/support/SupportService';
import { dependencyFamily, dependencyState } from '../../services/support/SupportInterpretation';
import { getGitHubToolsCatalog } from '../../services/tools/GitHubToolsService';
import type { SoftwareInfo } from '../../types/support';
import type { SnapshotCollection } from '../../../packages/contracts/machine';
import { SupportHeader, SupportFeedback, TechnicalDetails, useSupportTask, InstallationsLink } from './SupportUI';
export function DependenciesPage() {
  const task = useSupportTask<SnapshotCollection<SoftwareInfo>>(); const [catalogNames, setCatalogNames] = useState<string[]>([]);
  const refresh = () => task.run(async () => { const result = await SupportService.dependencies(); try { const catalog = await getGitHubToolsCatalog(); setCatalogNames(catalog.status === 'available' ? catalog.tools.filter(t => t.assetStatus === 'available').map(t => t.name.toLowerCase()) : []); } catch { setCatalogNames([]); } return result; });
  return <><SupportHeader title="Dependências" description="Inventário de runtimes encontrados, sem inventar requisitos do Tróia." icon={Puzzle} busy={task.busy} action={refresh}/><SupportFeedback {...task}/>{task.result && <><div className="support-cards">{['WebView2','.NET Framework','.NET Desktop Runtime','Visual C++ Redistributable'].map(family => { const items = task.result!.items.filter(s => dependencyFamily(s) === family); return <section className="support-card" key={family}><h2>{family}</h2><p>{dependencyState(task.result!.items, family, task.result!.error)}</p>{items.map((s,index) => <p key={index}>{s.name} · {s.version || 'Versão não informada'} · {s.architecture || 'Arquitetura não determinada'}</p>)}{items.length === 0 && catalogNames.some(name => name.includes(family.toLowerCase())) && <InstallationsLink/>}<p>Compatibilidade com a aplicação depende de requisitos explícitos futuros.</p></section>; })}</div><TechnicalDetails data={task.result}/></>}</>;
}
