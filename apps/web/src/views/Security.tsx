import type { Me } from '@do-it/shared';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { toast } from '../lib/store';
import { sync } from '../lib/sync';

function copy(text: string, what: string) {
  void navigator.clipboard
    .writeText(text)
    .then(() => toast(`${what} kopiert`))
    .catch(() => toast('Kopieren nicht möglich – bitte markieren und kopieren', { kind: 'error' }));
}

/** Zwei-Faktor-Anmeldung mit einer Authenticator-App (TOTP). */
export function TwoFactor({ me }: { me: Me }) {
  const [setup, setSetup] = useState<{ secret: string; uri: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [off, setOff] = useState({ password: '', code: '' });
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  if (recovery) {
    return (
      <section className="card" style={{ marginTop: 16, display: 'grid', gap: 10 }}>
        <strong>Zwei-Faktor-Anmeldung ist an</strong>
        <span className="small muted">
          Das sind deine Wiederherstellungscodes. Jeder funktioniert genau einmal anstelle des 6-stelligen Codes – zum Beispiel, wenn dein Handy weg ist. Bewahre sie
          sicher auf (Passwort-Manager oder ausgedruckt). Sie werden nur jetzt angezeigt.
        </span>
        <ul className="recovery-codes">
          {recovery.map((c) => (
            <li key={c}>
              <code>{c}</code>
            </li>
          ))}
        </ul>
        <div className="row">
          <button className="btn" onClick={() => copy(recovery.join('\n'), 'Codes')}>
            Kopieren
          </button>
          <button className="btn primary" onClick={() => setRecovery(null)}>
            Ich habe sie gespeichert
          </button>
        </div>
      </section>
    );
  }

  if (me.twoFactor) {
    return (
      <section className="card" style={{ marginTop: 16, display: 'grid', gap: 10 }}>
        <strong>Zwei-Faktor-Anmeldung</strong>
        <span className="small muted">Aktiv. Beim Anmelden auf einem neuen Gerät fragt Do-it nach dem Code aus deiner Authenticator-App.</span>
        <details className="small">
          <summary>Ausschalten</summary>
          <div className="grid2" style={{ marginTop: 8 }}>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              placeholder="Passwort"
              value={off.password}
              onChange={(e) => setOff({ ...off, password: e.target.value })}
            />
            <input
              className="input"
              autoComplete="one-time-code"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="Code oder Wiederherstellungscode"
              value={off.code}
              onChange={(e) => setOff({ ...off, code: e.target.value })}
            />
          </div>
          <button
            className="btn danger"
            style={{ marginTop: 8 }}
            disabled={busy || !off.password || !off.code}
            onClick={() =>
              void run(async () => {
                await api('POST', '/api/me/2fa/disable', off);
                setOff({ password: '', code: '' });
                toast('Zwei-Faktor-Anmeldung ausgeschaltet');
                await sync.sync();
              })
            }
          >
            Ausschalten
          </button>
        </details>
      </section>
    );
  }

  return (
    <section className="card" style={{ marginTop: 16, display: 'grid', gap: 10 }}>
      <strong>Zwei-Faktor-Anmeldung</strong>
      <span className="small muted">
        Schützt dein Konto, auch wenn jemand dein Passwort kennt: Beim Anmelden auf einem neuen Gerät fragt Do-it zusätzlich nach einem 6-stelligen Code aus einer
        Authenticator-App (z. B. Aegis, 2FAS, Google oder Microsoft Authenticator).
      </span>
      {!setup ? (
        <div>
          <button className="btn" disabled={busy} onClick={() => void run(async () => setSetup(await api('POST', '/api/me/2fa/setup')))}>
            Einrichten
          </button>
        </div>
      ) : (
        <>
          <div className="totp-setup">
            <img className="qr" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(setup.qr)}`} width={176} height={176} alt="QR-Code für die Authenticator-App" />
            <div style={{ display: 'grid', gap: 8, alignContent: 'start' }}>
              <span className="small">1. QR-Code mit der Authenticator-App scannen.</span>
              <span className="small muted">
                Auf diesem Handy? <a href={setup.uri}>In der Authenticator-App öffnen</a> oder den Schlüssel von Hand eingeben:
              </span>
              <div className="row">
                <code className="secret">{setup.secret}</code>
                <button className="btn small" onClick={() => copy(setup.secret.replace(/\s/g, ''), 'Schlüssel')}>
                  Kopieren
                </button>
              </div>
              <span className="small">2. Den angezeigten Code eingeben:</span>
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    const r = await api<{ recoveryCodes: string[] }>('POST', '/api/me/2fa/enable', { code });
                    setRecovery(r.recoveryCodes);
                    setSetup(null);
                    setCode('');
                    await sync.sync();
                  });
                }}
              >
                <input
                  className="input"
                  style={{ width: 140 }}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  aria-label="Code aus der Authenticator-App"
                />
                <button className="btn primary" disabled={busy || code.replace(/\s/g, '').length !== 6}>
                  Aktivieren
                </button>
              </form>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

interface SessionInfo {
  device: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

/** Angemeldete Geräte; andere lassen sich auf einmal abmelden. */
export function Sessions() {
  const [list, setList] = useState<SessionInfo[] | null>(null);
  const load = () =>
    void api<{ sessions: SessionInfo[] }>('GET', '/api/me/sessions')
      .then((r) => setList(r.sessions))
      .catch(() => {});
  useEffect(load, []);
  const others = list?.filter((s) => !s.current).length ?? 0;
  const fmt = (iso: string) => new Date(iso).toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <section className="card" style={{ marginTop: 16, display: 'grid', gap: 10 }}>
      <strong>Angemeldete Geräte</strong>
      {!list ? (
        <span className="small muted">Wird geladen …</span>
      ) : (
        <ul className="session-list">
          {list.map((s, i) => (
            <li key={i}>
              <span>
                {s.device}
                {s.current && (
                  <span className="chip" style={{ marginLeft: 8 }}>
                    dieses Gerät
                  </span>
                )}
              </span>
              <span className="small muted">
                angemeldet {fmt(s.createdAt)} · zuletzt aktiv {fmt(s.lastSeenAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {others > 0 && (
        <div>
          <button
            className="btn"
            onClick={() =>
              void api<{ removed: number }>('POST', '/api/me/sessions/logout-others')
                .then((r) => {
                  toast(r.removed === 1 ? '1 Gerät abgemeldet' : `${r.removed} Geräte abgemeldet`);
                  load();
                })
                .catch((e: Error) => toast(e.message, { kind: 'error' }))
            }
          >
            Alle anderen Geräte abmelden
          </button>
        </div>
      )}
    </section>
  );
}
