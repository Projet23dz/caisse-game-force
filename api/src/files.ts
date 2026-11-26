import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Response } from 'express';
import multer from 'multer';
import { AppError } from './errors';

export function uploader(maxMb: number) {
  return multer({ storage: multer.memoryStorage(), limits: { fileSize: maxMb * 1024 * 1024, files: 1 } });
}

export type Kind = 'png' | 'jpg' | 'svg' | 'pdf' | 'webp';
const MIME: Record<Kind, string> = { png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml', pdf: 'application/pdf', webp: 'image/webp' };

/** Détecte le vrai type d'un fichier par ses premiers octets (jamais par son nom). */
export function sniff(buf: Buffer): Kind | null {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  const head = buf.subarray(0, 2048).toString('utf8').trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  return null;
}

export function assertSafeSvg(buf: Buffer) {
  const s = buf.toString('utf8').toLowerCase();
  if (/<script|<foreignobject|\bon[a-z]+\s*=|javascript:|<iframe|<embed|<object|xlink:href\s*=\s*["']?(?!#)/.test(s)) {
    throw new AppError(422, 'UNSAFE_SVG', 'SVG refusé : il contient du code ou des liens externes');
  }
}

export interface Stored { key: string; kind: Kind; mime: string; size: number; sha256: string }

export async function store(dataDir: string, folder: string, buf: Buffer, allowed: Kind[], prefix = ''): Promise<Stored> {
  const kind = sniff(buf);
  if (!kind || !allowed.includes(kind)) {
    throw new AppError(415, 'UNSUPPORTED_FILE', `Type de fichier non accepté (autorisés : ${allowed.join(', ')})`);
  }
  if (kind === 'svg') assertSafeSvg(buf);
  const key = path.posix.join(folder, `${prefix}${Date.now()}-${randomUUID().slice(0, 8)}.${kind}`);
  const full = resolveKey(dataDir, key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, buf, { flag: 'wx' });
  return { key, kind, mime: MIME[kind], size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
}

/** Résout une clé de stockage en chemin absolu, sans jamais sortir du dossier de données. */
export function resolveKey(dataDir: string, key: string): string {
  const root = path.resolve(dataDir);
  const full = path.resolve(root, key);
  if (!full.startsWith(root + path.sep)) throw new AppError(400, 'BAD_PATH', 'Chemin invalide');
  return full;
}

export async function sendStored(res: Response, dataDir: string, key: string, downloadName?: string) {
  const full = resolveKey(dataDir, key);
  const kind = (path.extname(full).slice(1) as Kind);
  const buf = await fs.readFile(full).catch(() => { throw new AppError(404, 'NOT_FOUND', 'Fichier introuvable'); });
  res.setHeader('Content-Type', MIME[kind] ?? 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.setHeader('Cache-Control', 'private, max-age=300');
  if (downloadName) res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
  res.end(buf);
}

export async function listFiles(dataDir: string, folder: string, prefix: string): Promise<string[]> {
  const dir = resolveKey(dataDir, folder + '/x').replace(/[\\/]x$/, '');
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  return names.filter((n) => n.startsWith(prefix)).sort().reverse().map((n) => path.posix.join(folder, n));
}
