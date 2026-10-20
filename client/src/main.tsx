import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ProviderKeysPage from './ProviderKeysPage';
import ProviderKeyManagerPage from './ProviderKeyManagerPage';
import { getBrowserDiagnosticContext, installGlobalDiagnosticHandlers, logDiagnostic } from './diagnostics';
import './styles.css';

installGlobalDiagnosticHandlers();
logDiagnostic('info', 'app.loaded', getBrowserDiagnosticContext());

const Page = window.location.pathname === '/cards/manage'
  ? ProviderKeyManagerPage
  : window.location.pathname === '/cards'
    ? ProviderKeysPage
    : App;

createRoot(document.getElementById('root')!).render(<StrictMode><Page /></StrictMode>);
