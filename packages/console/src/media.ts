// Artwork for rewards (flyers, product shots). The console resizes every upload to one standard
// size in the browser before sending it, so all reward art looks the same in the app; the server
// checks the file and keeps the bytes outside the main data so saves stay small.
import { mkdirSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConsoleError } from './repo.js';
import type { UpstashConfig } from './remote-store.js';

/** Every reward image is stored at this size (16:9). */
export const ART_WIDTH = 1200;
export const ART_HEIGHT = 675;
export const MAX_ART_BYTES = 1_500_000;

export interface MediaInfo {
  id: string;
  /** The uploaded file's name, for the library list. */
  name: string;
  type: 'image/jpeg' | 'image/png' | 'image/webp';
  width: number;
  height: number;
  bytes: number;
  createdAt: string;
  createdBy: string;
}

export interface MediaStore {
  put(id: string, bytes: Buffer): Promise<void>;
  get(id: string): Promise<Buffer | undefined>;
  remove(id: string): Promise<void>;
}

export function memoryMediaStore(): MediaStore {
  const m = new Map<string, Buffer>();
  return {
    async put(id, bytes) {
      m.set(id, bytes);
    },
    async get(id) {
      return m.get(id);
    },
    async remove(id) {
      m.delete(id);
    },
  };
}

export function fileMediaStore(dir: string): MediaStore {
  mkdirSync(dir, { recursive: true });
  const path = (id: string) => join(dir, `${id}.img`);
  return {
    put: (id, bytes) => writeFile(path(id), bytes),
    get: (id) => readFile(path(id)).catch(() => undefined),
    remove: (id) => unlink(path(id)).catch(() => undefined),
  };
}

export function upstashMediaStore(config: UpstashConfig, fetchImpl: typeof fetch = fetch): MediaStore {
  const prefix = `${config.key ?? 'vgo-rewards:data'}:media:`;
  async function command(args: string[]): Promise<unknown> {
    const res = await fetchImpl(config.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
    if (!res.ok || body.error) throw new Error(`Upstash ${res.status}: ${body.error ?? 'request failed'}`);
    return body.result;
  }
  return {
    async put(id, bytes) {
      await command(['SET', prefix + id, bytes.toString('base64')]);
    },
    async get(id) {
      const v = await command(['GET', prefix + id]);
      return typeof v === 'string' ? Buffer.from(v, 'base64') : undefined;
    },
    async remove(id) {
      await command(['DEL', prefix + id]);
    },
  };
}

/** Reads the type and pixel size from the file itself, so a renamed or broken file is refused. */
export function imageInfo(b: Buffer): { type: MediaInfo['type']; width: number; height: number } | undefined {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { type: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = b.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { type: 'image/webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === 'VP8 ') return { type: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { type: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return undefined;
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1]!;
      const len = b.readUInt16BE(i + 2);
      // Start-of-frame markers carry the size.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { type: 'image/jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return undefined;
}

/** Checks an upload sent as a data URL and returns its bytes and details. */
export function readUpload(dataUrl: unknown, name: unknown, by: string, now: Date): { info: MediaInfo; bytes: Buffer } {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''));
  if (!m) throw new ConsoleError('Upload a JPG, PNG or WebP image.');
  const bytes = Buffer.from(m[2]!, 'base64');
  if (bytes.length > MAX_ART_BYTES) throw new ConsoleError('That image is too large. Try a smaller file.');
  const found = imageInfo(bytes);
  if (!found) throw new ConsoleError('That file is not a readable image.');
  if (found.width !== ART_WIDTH || found.height !== ART_HEIGHT)
    throw new ConsoleError(`Reward art must be ${ART_WIDTH}×${ART_HEIGHT}. Upload it from the offer screen, which sizes it for you.`);
  const clean = String(name ?? '').replace(/[^\w .()-]/g, '').trim().slice(0, 80) || 'artwork';
  return {
    bytes,
    info: { id: randomUUID().replace(/-/g, '').slice(0, 16), name: clean, ...found, bytes: bytes.length, createdAt: now.toISOString(), createdBy: by },
  };
}

export const mediaUrl = (id: string | undefined) => (id ? `/media/${id}` : undefined);
