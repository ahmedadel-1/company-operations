/**
 * Object storage port (ADR-0008). Keys are always server-generated (`org/<orgId>/...`); nothing
 * here ever accepts a client-supplied key. Pre-signed URLs are the only way clients touch objects.
 */
export interface StoragePort {
  /** Pre-signed PUT bound to `contentType`; the client must send exactly that `Content-Type`. */
  presignUpload(input: { key: string; contentType: string; expiresInSeconds: number }): Promise<string>;
  /** Pre-signed GET that forces download with the given (already sanitized) disposition. */
  presignDownload(input: {
    key: string;
    contentType: string;
    contentDisposition: string;
    expiresInSeconds: number;
  }): Promise<string>;
  /** Object size, or null when the object does not exist. */
  head(key: string): Promise<{ sizeBytes: number } | null>;
  /** Streams the object's bytes. */
  read(key: string): Promise<AsyncIterable<Uint8Array>>;
  delete(key: string): Promise<void>;
}

/**
 * Malware scanning hook (SECURITY §6: optional ClamAV). The default scanner does not scan and
 * reports NOT_SCANNED; a real scanner returning INFECTED makes the attachment REJECTED.
 */
export interface AttachmentScanner {
  scan(key: string): Promise<'NOT_SCANNED' | 'CLEAN' | 'INFECTED'>;
}

export const NO_SCAN: AttachmentScanner = { scan: () => Promise.resolve('NOT_SCANNED') };
