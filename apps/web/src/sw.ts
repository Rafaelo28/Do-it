/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (string | { url: string; revision: string | null })[] };

self.addEventListener('install', () => void self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//, /^\/oauth\//, /^\/\.well-known\//, /^\/mcp/] }));

interface Payload {
  title: string;
  body?: string;
  tag?: string;
  url?: string;
  taskId?: string;
  actions?: { action: string; title: string }[];
  tokens?: Record<string, string>;
}

self.addEventListener('push', (event) => {
  let p: Payload;
  try {
    p = event.data?.json() as Payload;
  } catch {
    p = { title: 'Do-it', body: event.data?.text() };
  }
  const maxActions = (Notification as unknown as { maxActions?: number }).maxActions ?? 2;
  const options = {
    body: p.body,
    tag: p.tag,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    data: { url: p.url ?? '/today', tokens: p.tokens ?? {} },
    actions: (p.actions ?? []).slice(0, maxActions),
  };
  event.waitUntil(self.registration.showNotification(p.title || 'Do-it', options as NotificationOptions));
});

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  n.close();
  const data = (n.data ?? {}) as { url?: string; tokens?: Record<string, string> };
  const token = event.action ? data.tokens?.[event.action] : undefined;
  event.waitUntil(
    (async () => {
      if (token) {
        const res = await fetch('/api/push/action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
        }).catch(() => null);
        for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'sync' });
        if (res?.ok) return;
      }
      const url = new URL(data.url ?? '/today', self.location.origin).href;
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of windows) {
        await c.focus();
        await c.navigate(url).catch(() => {});
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
