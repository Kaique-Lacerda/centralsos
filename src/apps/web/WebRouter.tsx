import { Navigate, Route, Routes } from 'react-router-dom';
import { WebShell } from './WebShell';
import { PortalHome } from './PortalPages';

export function WebRouter() {
    return <Routes><Route element={<WebShell />}>
        <Route index element={<PortalHome />} />
        <Route path="download/client" element={<Navigate to="/#downloads" replace />} />
        <Route path="download/support" element={<Navigate to="/#downloads" replace />} />
        <Route path="download" element={<Navigate to="/#downloads" replace />} />
        <Route path="tools" element={<Navigate to="/#tools" replace />} />
        <Route path="installations" element={<Navigate to="/#tools" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
    </Route></Routes>;
}
