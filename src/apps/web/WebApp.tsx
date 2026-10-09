import { BrowserRouter } from 'react-router-dom';
import { WebRouter } from './WebRouter';

export function WebApp() { return <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><WebRouter /></BrowserRouter>; }
