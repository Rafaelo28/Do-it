import type { Me } from '@do-it/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { deviceTimeZone } from '../lib/time';

type Mode = 'setup' | 'login' | 'register';

export function AuthView({ mode, token, onDone }: { mode: Mode; token?: string; onDone: (me: Me) => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<{ valid: boolean; invitedBy?: string; projectName?: string | null } | null>(null);

  useEffect(() => {
    if (mode === 'register' && token) {
      api<{ valid: boolean; invitedBy?: string; projectName?: string | null }>('GET', `/api/invites/${token}`)
        .then(setInvite)
        .catch(() => setInvite({ valid: false }));
    }
  }, [mode, token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const timezone = deviceTimeZone();
      const r =
        mode === 'login'
          ? await api<{ user: Me }>('POST', '/api/auth/login', { email, password })
          : mode === 'setup'
            ? await api<{ user: Me }>('POST', '/api/auth/setup', { name, email, password, timezone })
            : await api<{ user: Me }>('POST', '/api/auth/register', { token, name, email, password, timezone });
      onDone(r.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const heading = mode === 'setup' ? 'Willkommen bei Do-it' : mode === 'login' ? 'Anmelden' : 'Konto anlegen';

  return (
    <div className="auth">
      <form className="card" onSubmit={(e) => void submit(e)}>
        <img className="logo" src="/icons/icon.svg" alt="" />
        <h1>{heading}</h1>
        {mode === 'setup' && <p className="muted">Lege das erste Konto an. Es wird Admin und kann später andere einladen.</p>}
        {mode === 'register' && invite && !invite.valid && <p className="error-text">Diese Einladung ist ungültig oder abgelaufen.</p>}
        {mode === 'register' && invite?.valid && (
          <p className="muted">
            {invite.invitedBy} lädt dich ein{invite.projectName ? ` – zum Projekt „${invite.projectName}“` : ''}.
          </p>
        )}
        {mode !== 'login' && (
          <label className="field">
            <span>Name</span>
            <input className="input" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        )}
        <label className="field">
          <span>E-Mail</span>
          <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>Passwort</span>
          <input
            className="input"
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            minLength={mode === 'login' ? undefined : 8}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="error-text">{error}</p>}
        <button className="btn primary" disabled={busy || (mode === 'register' && invite?.valid === false)}>
          {mode === 'login' ? 'Anmelden' : 'Konto anlegen'}
        </button>
        {mode === 'register' && (
          <a className="small muted" href={`/login?next=/invite/${token}`}>
            Ich habe schon ein Konto
          </a>
        )}
      </form>
    </div>
  );
}
