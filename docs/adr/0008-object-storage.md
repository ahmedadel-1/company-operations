# ADR-0008: S3-compatible object storage abstraction; development storage choice

Date: 2026-10-02 · Status: Accepted (revised during the Phase 0 remediation pass)

## Context
The spec requires an S3-compatible abstraction; development uses MinIO; production may use AWS S3, MinIO or another compatible provider; large binaries never go into PostgreSQL.

Facts verified on 2026-10-02 from official sources:
- The official MinIO repository README (github.com/minio/minio) states: "The MinIO community edition is now distributed as source code only. We will no longer provide pre-compiled binary releases for the community version", and that legacy binaries "will not receive updates". The newest GitHub release is `RELEASE.2025-10-15T17-29-55Z` (2025-10-16).
- No pullable `minio/minio` image tag could be verified via the Docker Hub API, and the Quay API returned errors for `minio/minio`. A **prebuilt, maintained MinIO community image could not be verified.**
- SeaweedFS (S3-compatible, Apache-2.0) has a current official release `4.48` (2026-09-28) and an official image `chrislusf/seaweedfs:4.48` (Docker Hub, digest `sha256:4e61d15f…72d`).

## Decision
1. Application code depends only on a `StoragePort` (create upload intent, presign GET, head, delete) implemented by one `S3StorageAdapter` built on `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, with configurable endpoint, region, credentials and path-style addressing. **No MinIO-specific (or other vendor-specific) API is used.**
2. **Development/CI default**: SeaweedFS `4.48` S3 gateway (`chrislusf/seaweedfs:4.48`, digest-pinned). Phase 1 item P1-14 validates the exact operations used (presigned PUT with content-type/length, HEAD, presigned GET, DELETE); if any fails, the fallback is a locally built MinIO image from the pinned source release (per the MinIO README "Build a Docker image" instructions).
3. **MinIO remains permitted** for local development when a team builds it from source.
4. **Production** storage is a deployment choice among maintained S3-compatible services (e.g. AWS S3, other managed S3-compatible services, or a supported self-hosted product). Operators are responsible for selecting a maintained, patched implementation.

## Consequences
- The architecture is provider-neutral; switching storage is configuration only.
- This deviates from the spec's "Development: MinIO" default because no maintained prebuilt MinIO image could be verified; the spec's underlying requirement (S3-compatible dev storage) is preserved.
