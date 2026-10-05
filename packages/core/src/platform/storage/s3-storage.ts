import { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { StoragePort } from './storage-port.js';

export interface S3StorageConfig {
  readonly endpoint?: string | undefined;
  /** Browser-reachable endpoint used only for pre-signed URLs (defaults to `endpoint`). */
  readonly publicEndpoint?: string | undefined;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
}

/**
 * S3 adapter (AWS SDK v3; SeaweedFS in development). Settings from the Phase 1A storage spike
 * (docs/storage-spike.md): `requestChecksumCalculation: WHEN_REQUIRED` (otherwise pre-signed PUTs
 * embed an empty-body checksum and fail) and `content-type` as a signed header on uploads.
 */
export class S3Storage implements StoragePort {
  private readonly client: S3Client;
  private readonly presigner: S3Client;

  constructor(private readonly config: S3StorageConfig) {
    this.client = this.createClient(config.endpoint);
    this.presigner =
      config.publicEndpoint === undefined || config.publicEndpoint === config.endpoint
        ? this.client
        : this.createClient(config.publicEndpoint);
  }

  async presignUpload(input: { key: string; contentType: string; expiresInSeconds: number }): Promise<string> {
    return getSignedUrl(
      this.presigner,
      new PutObjectCommand({ Bucket: this.config.bucket, Key: input.key, ContentType: input.contentType }),
      { expiresIn: input.expiresInSeconds, signableHeaders: new Set(['content-type']) },
    );
  }

  async presignDownload(input: {
    key: string;
    contentType: string;
    contentDisposition: string;
    expiresInSeconds: number;
  }): Promise<string> {
    return getSignedUrl(
      this.presigner,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: input.key,
        ResponseContentType: input.contentType,
        ResponseContentDisposition: input.contentDisposition,
      }),
      { expiresIn: input.expiresInSeconds },
    );
  }

  async head(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }));
      return { sizeBytes: result.ContentLength ?? 0 };
    } catch (error) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async read(key: string): Promise<AsyncIterable<Uint8Array>> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
    const body = result.Body;
    if (!(body instanceof Readable)) {
      throw new Error('Storage returned no readable body.');
    }
    return body;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }

  destroy(): void {
    this.client.destroy();
    if (this.presigner !== this.client) {
      this.presigner.destroy();
    }
  }

  private createClient(endpoint: string | undefined): S3Client {
    return new S3Client({
      region: this.config.region,
      forcePathStyle: this.config.forcePathStyle,
      credentials: { accessKeyId: this.config.accessKeyId, secretAccessKey: this.config.secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      ...(endpoint === undefined ? {} : { endpoint }),
    });
  }
}
