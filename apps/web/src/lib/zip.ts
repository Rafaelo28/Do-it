/**
 * Kleiner ZIP-Leser für Todoist-Backups (Verfahren "stored" und "deflate").
 * Entpackt wird mit der eingebauten DecompressionStream des Browsers, ganz ohne Bibliothek.
 */

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export async function unzip(data: ArrayBuffer | Uint8Array): Promise<ZipEntry[]> {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Das ist keine gültige ZIP-Datei.');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  if (count === 0xffff || p === 0xffffffff) throw new Error('Die ZIP-Datei ist zu groß.');

  const utf8 = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > u8.length || view.getUint32(p, true) !== CENTRAL) throw new Error('Die ZIP-Datei ist beschädigt.');
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = utf8.decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error('Verschlüsselte ZIP-Dateien werden nicht unterstützt.');
    if (view.getUint32(localOffset, true) !== LOCAL) throw new Error('Die ZIP-Datei ist beschädigt.');
    // Größen aus dem zentralen Verzeichnis nehmen: im lokalen Kopf können sie 0 sein (Datendeskriptor)
    const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const raw = u8.subarray(start, start + compressedSize);
    if (method === 0) entries.push({ name, bytes: raw });
    else if (method === 8) entries.push({ name, bytes: await inflateRaw(raw) });
    else throw new Error(`Packverfahren ${method} in „${name}“ wird nicht unterstützt.`);
  }
  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
