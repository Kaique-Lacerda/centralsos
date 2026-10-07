import { Navigate, Route, Routes } from 'react-router-dom';
import type { ComponentType } from 'react';
import { ClientShell } from './ClientShell';
import { Dashboard, DiagnosticPage, DownloadPage, FavoritesPage, InstallationsPage, SettingsPage, SupportPage, ToolsPage, ValidationPage } from '../../pages/Pages';
import { toolRegistry } from '../../tools/registry';
import { runtimeEnvironment } from '../../services/runtime/environment';
import { PrinterDiagnosticPage } from '../../pages/PrinterDiagnosticPage';
import { NetworkDiagnosticPage } from '../../pages/NetworkDiagnosticPage';
import { WindowsServicesDiagnosticPage } from '../../pages/WindowsServicesDiagnosticPage';
import { navigationItems } from './navigation';
import { ConnectivityPage } from '../../pages/support/ConnectivityPage';
import { FirebirdPage } from '../../pages/support/FirebirdPage';
import { SharesPage } from '../../pages/support/SharesPage';
import { SystemPage } from '../../pages/support/SystemPage';
import { ProcessesPage } from '../../pages/support/ProcessesPage';
import { DependenciesPage } from '../../pages/support/DependenciesPage';

const toolPages: Record<string, ComponentType> = {
  'computer-diagnostic': DiagnosticPage,
  'printer-diagnostic': PrinterDiagnosticPage,
  'network-diagnostic': NetworkDiagnosticPage,
  'windows-services-diagnostic': WindowsServicesDiagnosticPage,
  'connectivity': ConnectivityPage,
  'firebird': FirebirdPage,
  'shares': SharesPage,
  'system-support': SystemPage,
  'processes': ProcessesPage,
  'dependencies': DependenciesPage
};

function ToolRoute({ toolId }: { toolId: string }) {
  const tool = toolRegistry.find(candidate => candidate.id === toolId);
  if (!tool || !tool.enabled) return <main className="page">Esta ferramenta não está habilitada.</main>;
  if (!tool.availableOn.includes(runtimeEnvironment)) {
    return <main className="page">
      <h1>{tool.name}</h1>
      <p>Esta ferramenta requer o aplicativo Desktop.</p>
      <p>Dados locais e ações do Windows não são simulados no navegador.</p>
    </main>;
  }
  const Page = toolPages[tool.id];
  return Page ? <Page /> : <main className="page">A página desta ferramenta ainda não está disponível.</main>;
}

function NavigationPage({ path, Page }: { path: string; Page: ComponentType }) {
  if (!navigationItems.find(item => item.path === path)?.enabled) return <Navigate to="/" replace />;
  return <Page />;
}

export function ClientRouter(){return <Routes><Route element={<ClientShell/>}><Route index element={<Dashboard/>}/><Route path="tools" element={<ToolsPage/>}/>{toolRegistry.map(tool=><Route key={tool.id} path={tool.path.replace(/^\//,'')} element={<ToolRoute toolId={tool.id}/>}/>)}<Route path="validation" element={<ValidationPage/>}/><Route path="installations" element={<InstallationsPage/>}/><Route path="favorites" element={<NavigationPage path="/favorites" Page={FavoritesPage}/>}/><Route path="support" element={<NavigationPage path="/support" Page={SupportPage}/>}/><Route path="settings" element={<SettingsPage/>}/><Route path="download" element={<DownloadPage/>}/><Route path="*" element={<Navigate to="/" replace/>}/></Route></Routes>}
