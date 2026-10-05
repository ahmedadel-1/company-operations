import { createHash } from 'node:crypto';

import { fileTypeFromBuffer } from 'file-type';

/** Default organization allow-list (SECURITY §6). ZIP is not enabled. */
export const DEFAULT_ALLOWED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

export const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const OOXML_TYPES: ReadonlySet<string> = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const TEXT_TYPES: ReadonlySet<string> = new Set(['text/plain', 'text/csv']);

/** Bytes kept from the start of the object for magic-byte detection. */
export const SNIFF_BYTES = 64 * 1024;

/**
 * Display-only file name (the storage key never uses it): strips directories, control and
 * reserved characters, leading dots and trailing dots/spaces, normalizes to NFC and caps the
 * length at 255 characters while keeping the extension.
 */
export function sanitizeFilename(raw: string): string {
  const base = raw.normalize('NFC').split(/[/\\]/).at(-1) ?? '';
  let name = base
    .replace(/[\p{Cc}\p{Cf}<>:"|?*]/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  if (name.length > 255) {
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    name = name.slice(0, 255 - extension.length) + extension;
  }
  return name === '' ? 'file' : name;
}

/** `attachment` disposition with an ASCII fallback and the RFC 5987 UTF-8 name. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export interface InspectedContent {
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly head: Buffer;
}

/** Streams the object once: SHA-256 over all bytes, the first {@link SNIFF_BYTES} kept for sniffing. */
export async function inspectContent(
  stream: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<InspectedContent | null> {
  const hash = createHash('sha256');
  const head: Buffer[] = [];
  let headLength = 0;
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      return null;
    }
    hash.update(chunk);
    if (headLength < SNIFF_BYTES) {
      const slice = Buffer.from(chunk.subarray(0, SNIFF_BYTES - headLength));
      head.push(slice);
      headLength += slice.byteLength;
    }
  }
  return { sizeBytes: size, checksumSha256: hash.digest('hex'), head: Buffer.concat(head) };
}

export type SniffResult =
  { readonly ok: true; readonly contentType: string } | { readonly ok: false; readonly reason: string };

/**
 * Verifies the stored bytes against the declared type: the sniffed type must equal the declared
 * one (OOXML may sniff as its ZIP container); plain text and CSV have no magic bytes and must be
 * valid UTF-8 without NUL bytes. Anything the allow-list does not contain is rejected.
 */
export async function verifyContentType(
  head: Buffer,
  declared: string,
  allowed: readonly string[],
): Promise<SniffResult> {
  if (!allowed.includes(declared)) {
    return { ok: false, reason: 'type_not_allowed' };
  }
  const detected = await fileTypeFromBuffer(head);
  if (detected === undefined) {
    if (TEXT_TYPES.has(declared) && isPlainUtf8Text(head)) {
      return { ok: true, contentType: declared };
    }
    return { ok: false, reason: 'unrecognized_content' };
  }
  if (detected.mime === declared) {
    return { ok: true, contentType: declared };
  }
  if (OOXML_TYPES.has(declared) && detected.mime === 'application/zip') {
    return { ok: true, contentType: declared };
  }
  return { ok: false, reason: 'content_type_mismatch' };
}

function isPlainUtf8Text(bytes: Buffer): boolean {
  if (bytes.includes(0)) {
    return false;
  }
  // A multi-byte sequence may be cut at the sniff boundary; ignore up to 3 trailing bytes.
  for (let trim = 0; trim <= 3 && trim <= bytes.length; trim += 1) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytes.length - trim));
      return true;
    } catch {
      if (bytes.length < SNIFF_BYTES) {
        return false;
      }
    }
  }
  return false;
}
