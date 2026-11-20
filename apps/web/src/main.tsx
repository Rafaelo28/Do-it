import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { toast } from './lib/store';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) toast('Neue Version verfügbar', { action: { label: 'Neu laden', run: () => location.reload() } }, 15000);
  });
}
