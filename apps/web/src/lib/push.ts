import { api } from './api';

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export async function enablePush(): Promise<void> {
  if (!pushSupported()) throw new Error('Dieser Browser unterstützt keine Benachrichtigungen');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Benachrichtigungen wurden nicht erlaubt');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api<{ publicKey: string }>('GET', '/api/push/key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
  await api('POST', '/api/push/subscription', sub.toJSON());
}

/**
 * Beim Start: vorhandenes Abo erneut melden. Der Server ordnet es so der aktuellen Sitzung zu –
 * wird das Gerät später abgemeldet, bekommt es keine Benachrichtigungen mehr.
 */
export async function refreshPushSubscription(): Promise<void> {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  const sub = await currentSubscription();
  if (sub) await api('POST', '/api/push/subscription', sub.toJSON());
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await api('DELETE', '/api/push/subscription', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}
