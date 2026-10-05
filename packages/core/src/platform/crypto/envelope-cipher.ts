import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM envelopes for secrets at rest (SECURITY §7): random 96-bit IV, caller-supplied
 * additional authenticated data binding the ciphertext to its context, and a key id for rotation.
 * Format: `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url segments).
 */
export interface EncryptionKey {
  readonly id: string;
  /** 32 bytes. */
  readonly key: Buffer;
}

/** A key as configured: id plus 32 bytes in base64. */
export interface EncodedKey {
  readonly id: string;
  readonly key: string;
}

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class EnvelopeCipher {
  private readonly current: EncryptionKey;
  private readonly keys: ReadonlyMap<string, Buffer>;

  constructor(current: EncryptionKey, previous: readonly EncryptionKey[] = []) {
    for (const candidate of [current, ...previous]) {
      if (candidate.key.length !== 32) {
        throw new Error(`Encryption key "${candidate.id}" must be 32 bytes.`);
      }
      if (!/^[a-z0-9-]{1,32}$/.test(candidate.id)) {
        throw new Error('Encryption key ids must match [a-z0-9-]{1,32}.');
      }
    }
    this.current = current;
    this.keys = new Map([current, ...previous].map((k) => [k.id, k.key]));
  }

  static fromBase64(id: string, base64Key: string, previous: readonly EncodedKey[] = []): EnvelopeCipher {
    return new EnvelopeCipher(
      { id, key: Buffer.from(base64Key, 'base64') },
      previous.map((k) => ({ id: k.id, key: Buffer.from(k.key, 'base64') })),
    );
  }

  /** Key id new envelopes are written with. */
  get currentKeyId(): string {
    return this.current.id;
  }

  /** Key id an envelope was written with, or null when it is not an envelope. */
  static keyIdOf(envelope: string): string | null {
    const parts = envelope.split('.');
    return parts.length === 5 && parts[0] === VERSION && parts[1] !== undefined ? parts[1] : null;
  }

  /** True when the envelope should be re-encrypted under the current key. */
  needsRotation(envelope: string): boolean {
    return EnvelopeCipher.keyIdOf(envelope) !== this.current.id;
  }

  encrypt(plaintext: string, aad: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.current.key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      this.current.id,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  /** Throws when the envelope is malformed, the key is unknown, or authentication fails. */
  decrypt(envelope: string, aad: string): string {
    const parts = envelope.split('.');
    const [version, keyId, iv, tag, ciphertext] = parts;
    if (
      parts.length !== 5 ||
      version !== VERSION ||
      keyId === undefined ||
      iv === undefined ||
      tag === undefined ||
      ciphertext === undefined
    ) {
      throw new Error('Malformed encryption envelope.');
    }
    const key = this.keys.get(keyId);
    if (key === undefined) {
      throw new Error('Unknown encryption key id.');
    }
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  }
}
