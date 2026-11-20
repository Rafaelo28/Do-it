import type { ServerMessage } from '@do-it/shared';

interface Socket {
  send(data: string): void;
  ping?(): void;
  close(): void;
  readyState: number;
}

/** Hält die WebSocket-Verbindungen und stupst Geräte an, wenn es Neues gibt. */
export class Hub {
  private sockets = new Map<string, Set<Socket>>();
  private timer: NodeJS.Timeout | null = null;

  add(userId: string, socket: Socket): void {
    let set = this.sockets.get(userId);
    if (!set) this.sockets.set(userId, (set = new Set()));
    set.add(socket);
    this.send(socket, { type: 'hello', userId });
  }

  remove(userId: string, socket: Socket): void {
    const set = this.sockets.get(userId);
    set?.delete(socket);
    if (set && !set.size) this.sockets.delete(userId);
  }

  poke(userIds: Iterable<string>): void {
    for (const id of new Set(userIds)) {
      for (const s of this.sockets.get(id) ?? []) this.send(s, { type: 'poke' });
    }
  }

  /** Alle 30 s ein Lebenszeichen, damit Cloudflare die Verbindung nicht nach 100 s Leerlauf trennt. */
  startPing(intervalMs = 30_000): void {
    this.timer = setInterval(() => {
      for (const set of this.sockets.values()) {
        for (const s of set) {
          this.send(s, { type: 'ping' });
          s.ping?.();
        }
      }
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const set of this.sockets.values()) for (const s of set) s.close();
    this.sockets.clear();
  }

  get connectionCount(): number {
    let n = 0;
    for (const set of this.sockets.values()) n += set.size;
    return n;
  }

  private send(s: Socket, msg: ServerMessage): void {
    if (s.readyState === 1) s.send(JSON.stringify(msg));
  }
}
