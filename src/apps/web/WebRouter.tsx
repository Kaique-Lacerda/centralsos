import { Navigate, Route, Routes } from 'react-router-dom';
import { ClientDownloadPage } from '../../components/distribution/ClientDownloadPage';
import { ToolsCatalogPage } from '../../components/distribution/ToolsCatalogPage';
import { WebShell } from './WebShell';
import { PortalHome, SupportDownloadPage } from './PortalPages';

export function WebRouter() {
    return <Routes><Route element={<WebShell />}>
        <Route index element={<PortalHome />} />
        <Route path="download/client" element={<ClientDownloadPage />} />
        <Route path="download/support" element={<SupportDownloadPage />} />
        <Route path="download" element={<Navigate to="/download/client" replace />} />
        <Route path="tools" element={<ToolsCatalogPage title="Ferramentas homologadas" />} />
        <Route path="installations" element={<Navigate to="/tools" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
    </Route></Routes>;
}
