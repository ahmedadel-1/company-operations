/**
 * Browser uploads PUT the bytes straight to object storage with a pre-signed URL, so the storage
 * origin (`STORAGE_PUBLIC_ORIGIN`, the origin of the API's `S3_PUBLIC_ENDPOINT`) must be allowed in
 * `connect-src`. Only a bare http(s) origin is accepted; anything else is ignored.
 */
export function storagePublicOrigin(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') {
    return null;
  }
  if (!URL.canParse(value.trim())) {
    return null;
  }
  const url = new URL(value.trim());
  return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
}
