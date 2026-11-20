export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** vollständige Fehlerantwort des Servers (z. B. twoFactorRequired) */
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Keine Verbindung zum Server');
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* leer */
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) onUnauthorized?.();
    const data = json && typeof json === 'object' ? (json as Record<string, unknown>) : {};
    throw new ApiError(res.status, typeof data.error === 'string' ? data.error : `Fehler ${res.status}`, data);
  }
  return json as T;
}
