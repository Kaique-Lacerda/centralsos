import { Navigate, Route, Routes } from 'react-router-dom';
import { ControlPage } from '../../pages/control/ControlPage';
import { SupportShell } from './SupportShell';

export function SupportRouter() {
    return <Routes><Route element={<SupportShell />}>
        <Route index element={<Navigate to="/control" replace />} />
        <Route path="control" element={<ControlPage />} />
        <Route path="*" element={<Navigate to="/control" replace />} />
    </Route></Routes>;
}
