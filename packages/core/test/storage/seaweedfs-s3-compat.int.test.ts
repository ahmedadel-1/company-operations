/**
 * Phase 1A storage spike (ADR-0008): proves that the S3-compatible endpoint configured by the
 * S3_* variables (SeaweedFS in development) supports every operation the attachment service will
 * rely on, using only the approved AWS SDK v3 packages. Requires a running endpoint:
 *   pnpm infra:up && pnpm --filter @company-ops/core test:integration
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadWorkspaceEnvFile, parseEnv, storageEnvSchema } from '@company-ops/config';

loadWorkspaceEnvFile(import.meta.dirname);
const env = parseEnv('storage', storageEnvSchema, process.env);

function createClient(requestChecksumCalculation: 'WHEN_SUPPORTED' | 'WHEN_REQUIRED'): S3Client {
  return new S3Client({
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
    requestChecksumCalculation,
    ...(env.S3_ENDPOINT === undefined ? {} : { endpoint: env.S3_ENDPOINT }),
  });
}

// Settings the StoragePort S3 adapter must use (findings recorded in docs/storage-spike.md):
// - requestChecksumCalculation WHEN_REQUIRED: with the SDK default, pre-signed PUT URLs embed a CRC32
//   of the empty request body, so every real upload fails with BadDigest.
// - signableHeaders content-type: binds the upload intent's MIME type into the signature.
const client = createClient('WHEN_REQUIRED');
const presignUpload = { signableHeaders: new Set(['content-type']) };

const bucket = env.S3_BUCKET;
const prefix = `spike/${randomUUID()}`;
const createdKeys = new Set<string>();

function key(name: string): string {
  const value = `${prefix}/${name}`;
  createdKeys.add(value);
  return value;
}

async function statusOf(promise: Promise<unknown>): Promise<number | undefined> {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof S3ServiceException) {
      return error.$metadata.httpStatusCode;
    }
    throw error;
  }
}

beforeAll(async () => {
  // Use the dev bucket; create it if the endpoint did not provision it at start-up.
  const status = await statusOf(client.send(new HeadBucketCommand({ Bucket: bucket })));
  if (status === 404) {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
});

afterAll(async () => {
  await Promise.allSettled(
    [...createdKeys].map((k) => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: k }))),
  );
  client.destroy();
});

describe('S3 compatibility of the configured endpoint', () => {
  it('bucket: the dev bucket exists and is usable', async () => {
    await expect(client.send(new HeadBucketCommand({ Bucket: bucket }))).resolves.toBeDefined();
  });

  it('bucket: CreateBucket and DeleteBucket work', async () => {
    const temporary = `spike-${randomUUID().slice(0, 8)}`;
    await client.send(new CreateBucketCommand({ Bucket: temporary }));
    await expect(client.send(new HeadBucketCommand({ Bucket: temporary }))).resolves.toBeDefined();
    await client.send(new DeleteBucketCommand({ Bucket: temporary }));
    expect(await statusOf(client.send(new HeadBucketCommand({ Bucket: temporary })))).toBe(404);
  });

  it('PUT, GET, HEAD and DELETE round-trip content, content type and metadata', async () => {
    const objectKey = key('direct.txt');
    const body = 'hello attachments \u2014 \u0645\u0631\u062d\u0628\u0627';

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Body: body,
        ContentType: 'text/plain; charset=utf-8',
        Metadata: { 'owner-type': 'spike', 'upload-id': 'abc123' },
      }),
    );

    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
    expect(head.ContentType).toBe('text/plain; charset=utf-8');
    expect(head.ContentLength).toBe(Buffer.byteLength(body));
    expect(head.Metadata).toEqual({ 'owner-type': 'spike', 'upload-id': 'abc123' });
    expect(head.ETag).toBeTruthy();

    const get = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
    expect(get.ContentType).toBe('text/plain; charset=utf-8');
    expect(get.Metadata).toEqual({ 'owner-type': 'spike', 'upload-id': 'abc123' });
    expect(await get.Body?.transformToString('utf-8')).toBe(body);

    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
    expect(await statusOf(client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey })))).toBe(404);
  });

  it('pre-signed PUT: upload succeeds with the signed content type', async () => {
    const objectKey = key('presigned-upload.pdf');
    const payload = Buffer.from('%PDF-1.7 spike payload');
    const url = await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: bucket, Key: objectKey, ContentType: 'application/pdf' }),
      { expiresIn: 300, ...presignUpload },
    );
    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');

    const response = await fetch(url, { method: 'PUT', body: payload, headers: { 'content-type': 'application/pdf' } });
    expect(response.status).toBe(200);

    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
    expect(head.ContentType).toBe('application/pdf');
    expect(head.ContentLength).toBe(payload.byteLength);
  });

  it('pre-signed PUT: a different content type than the signed one is rejected', async () => {
    const objectKey = key('presigned-mismatch.pdf');
    const url = await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: bucket, Key: objectKey, ContentType: 'application/pdf' }),
      { expiresIn: 300, ...presignUpload },
    );

    const response = await fetch(url, { method: 'PUT', body: 'x', headers: { 'content-type': 'text/html' } });
    expect(response.status).toBe(403);
    expect(await statusOf(client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey })))).toBe(404);
  });

  it('pre-signed PUT with the SDK default checksum setting fails (why the adapter sets WHEN_REQUIRED)', async () => {
    const defaultClient = createClient('WHEN_SUPPORTED');
    try {
      const objectKey = key('presigned-default-checksum.pdf');
      const url = await getSignedUrl(
        defaultClient,
        new PutObjectCommand({ Bucket: bucket, Key: objectKey, ContentType: 'application/pdf' }),
        { expiresIn: 300 },
      );
      expect(new URL(url).searchParams.has('x-amz-checksum-crc32')).toBe(true);

      const response = await fetch(url, {
        method: 'PUT',
        body: '%PDF-1.7 x',
        headers: { 'content-type': 'application/pdf' },
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('BadDigest');
    } finally {
      defaultClient.destroy();
    }
  });

  it('pre-signed GET: download returns the bytes and honours response overrides', async () => {
    const objectKey = key('presigned-download.bin');
    const payload = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: payload, ContentType: 'application/octet-stream' }),
    );

    const url = await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        ResponseContentDisposition: 'attachment; filename="report.bin"',
        ResponseContentType: 'application/octet-stream',
      }),
      { expiresIn: 300 },
    );

    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="report.bin"');
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(Buffer.from(await response.arrayBuffer()).equals(payload)).toBe(true);
  });

  it('pre-signed URLs stop working after they expire', async () => {
    const objectKey = key('expiring.txt');
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: 'short-lived', ContentType: 'text/plain' }),
    );

    const getUrl = await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: objectKey }), {
      expiresIn: 1,
    });
    const putUrl = await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: bucket, Key: key('expired-upload.txt'), ContentType: 'text/plain' }),
      { expiresIn: 1, ...presignUpload },
    );
    await sleep(2_500);

    expect((await fetch(getUrl)).status).toBe(403);
    const put = await fetch(putUrl, { method: 'PUT', body: 'late', headers: { 'content-type': 'text/plain' } });
    expect(put.status).toBe(403);
  });

  it('rejects tampered signatures and unsigned access', async () => {
    const objectKey = key('private.txt');
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: 'private', ContentType: 'text/plain' }),
    );

    const url = new URL(
      await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: objectKey }), { expiresIn: 300 }),
    );
    const signature = url.searchParams.get('X-Amz-Signature') ?? '';
    url.searchParams.set('X-Amz-Signature', `${signature.slice(0, -4)}0000`);
    expect((await fetch(url)).status).toBe(403);

    const unsigned = new URL(url.pathname, url.origin);
    expect((await fetch(unsigned)).status).toBe(403);
  });
});
