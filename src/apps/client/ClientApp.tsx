import { BrowserRouter } from 'react-router-dom';
import { ClientRouter } from './ClientRouter';

export function ClientApp() { return <BrowserRouter><ClientRouter /></BrowserRouter>; }
