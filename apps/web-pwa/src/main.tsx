import { createRoot } from 'react-dom/client';
import App from './App';
import { loadClientSettings } from './config';
import { AppProvider } from './state/AppContext';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element was not found.');

createRoot(root).render(
  <AppProvider settings={loadClientSettings()}>
    <App />
  </AppProvider>,
);
