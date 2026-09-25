import { Navigate, Route, Routes } from 'react-router-dom';
import type { ComponentType } from 'react';
import { Shell } from '../components/Shell';
import { Dashboard, DiagnosticPage, DownloadPage, FavoritesPage, InstallationsPage, SettingsPage, SupportPage, ToolsPage, ValidationPage } from '../pages/Pages';
import { toolRegistry } from '../tools/registry';
import { runtimeEnvironment } from '../services/runtime/environment';

const toolPages: Record<string, ComponentType> = {
  'computer-diagnostic': DiagnosticPage
};

function ToolRoute({ toolId }: { toolId: string }) {
  const tool = toolRegistry.find(candidate => candidate.id === toolId);
  if (!tool || !tool.enabled) return <main className="page">Esta ferramenta não está habilitada.</main>;
  if (!tool.availableOn.includes(runtimeEnvironment)) {
    return <main className="page"><h1>{tool.name}</h1><p>Esta ferramenta exige o aplicativo Desktop.</p></main>;
  }
  const Page = toolPages[tool.id];
  return Page ? <Page /> : <main className="page">A página desta ferramenta ainda não está disponível.</main>;
}

export function App(){return <Routes><Route element={<Shell/>}><Route index element={<Dashboard/>}/><Route path="tools" element={<ToolsPage/>}/>{toolRegistry.map(tool=><Route key={tool.id} path={tool.path.replace(/^\//,'')} element={<ToolRoute toolId={tool.id}/>}/>)}<Route path="validation" element={<ValidationPage/>}/><Route path="installations" element={<InstallationsPage/>}/><Route path="favorites" element={<FavoritesPage/>}/><Route path="support" element={<SupportPage/>}/><Route path="settings" element={<SettingsPage/>}/><Route path="download" element={<DownloadPage/>}/><Route path="*" element={<Navigate to="/" replace/>}/></Route></Routes>}
