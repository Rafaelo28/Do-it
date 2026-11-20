import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { toast } from './lib/store';
import './styles.css';

/** Fängt unerwartete Fehler ab, statt eine leere Seite zu zeigen. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="auth">
        <div className="card">
          <h1>Ups – da ist etwas schiefgelaufen</h1>
          <p className="muted">Deine Daten sind sicher gespeichert. Lade die App neu.</p>
          <pre className="small muted" style={{ whiteSpace: 'pre-wrap' }}>
            {this.state.error.message}
          </pre>
          <button className="btn primary" onClick={() => location.reload()}>
            Neu laden
          </button>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) toast('Neue Version verfügbar', { action: { label: 'Neu laden', run: () => location.reload() } }, 15000);
  });
}
