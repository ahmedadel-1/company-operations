# Storage spike: SeaweedFS S3 compatibility (Phase 1A)

Date run: 2026-10-02 · Endpoint: `chrislusf/seaweedfs:4.48@sha256:4e61d15f…` (`weed mini`, dev Compose) ·
Client: `@aws-sdk/client-s3` 3.1145.0 + `@aws-sdk/s3-request-presigner` 3.1145.0 · Node 24.21.0.

Purpose: verify, before attachments depend on it (ADR-0008), that the development S3-compatible endpoint
supports every operation the future `StoragePort` S3 adapter needs. The test uses only the vendor-neutral
AWS SDK and the `S3_*` variables; nothing in it is SeaweedFS-specific, so the same suite can be pointed at
any production candidate by changing `.env`.

Reproduce:

```bash
pnpm infra:up
pnpm --filter @company-ops/core test:integration   # packages/core/test/storage/seaweedfs-s3-compat.int.test.ts
```

## Results

| Operation | Result |
|---|---|
| Use dev bucket (`HeadBucket`; `weed mini` creates `S3_BUCKET` at start-up) | Pass |
| `CreateBucket` / `HeadBucket` / `DeleteBucket` on a temporary bucket | Pass |
| `PutObject` with `Content-Type` and user metadata | Pass |
| `HeadObject`: content type, length, ETag, metadata | Pass |
| `GetObject`: body (UTF-8 incl. Arabic), content type, metadata | Pass |
| `DeleteObject`, then `HeadObject` returns 404 | Pass |
| Pre-signed PUT, then upload with `fetch` (content type bound into the signature) | Pass (with the two adapter settings below) |
| Pre-signed PUT with a different `Content-Type` than signed | Rejected: 403 `SignatureDoesNotMatch` (desired) |
| Pre-signed GET, download with `fetch`, `response-content-disposition` / `response-content-type` overrides | Pass (binary bytes intact) |
| Expiry: pre-signed GET and PUT with `expiresIn: 1`, used after 2.5 s | Rejected: 403 (desired) |
| Tampered signature / unsigned GET on a private object | Rejected: 403 (desired) |

All 9 test cases pass (`Tests 9 passed`).

## Findings the StoragePort adapter (ROADMAP P1-14) must apply

These are AWS SDK v3 behaviours, not SeaweedFS quirks; they apply to every S3-compatible provider.

1. **`requestChecksumCalculation: 'WHEN_REQUIRED'` on the `S3Client`.** With the SDK default
   (`WHEN_SUPPORTED`), pre-signed PUT URLs embed `x-amz-checksum-crc32` computed over the *empty* request
   body. SeaweedFS (like AWS S3) validates it and every real upload fails with `400 BadDigest`. The test
   keeps a case asserting this default failure so the setting is not removed by accident.
2. **Pre-sign uploads with `signableHeaders: new Set(['content-type'])`.** By default the presigner signs
   only `host`, so any `Content-Type` would be accepted. Signing it binds the upload intent's declared MIME
   type; SeaweedFS enforces it (403 on mismatch). Magic-byte sniffing on confirm (`file-type`) remains
   required because the declared type is client-chosen.

Direct (non-pre-signed) `PutObject` works with either checksum setting.

## Not covered here

Multipart uploads (attachments are size-limited single PUTs in V1), bucket policies/CORS for browser
uploads (verified with the web upload flow in P1-14), object versioning, and production providers.
