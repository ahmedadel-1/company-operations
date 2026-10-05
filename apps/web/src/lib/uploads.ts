import type { paths } from '@company-ops/api-client';

import { api, ApiError, request } from './api';

type OwnerType =
  paths['/api/v1/attachments/upload-intents']['post']['requestBody']['content']['application/json']['ownerType'];

export interface UploadCallbacks {
  readonly onProgress: (percent: number) => void;
  readonly onVerifying: () => void;
}

/** PUTs the bytes to the pre-signed URL with exactly the headers the API listed, reporting progress. */
function putWithProgress(
  url: string,
  headers: Readonly<Record<string, string>>,
  file: File,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [name, value] of Object.entries(headers)) {
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new ApiError(xhr.status, 'UPLOAD_FAILED', `storage answered ${String(xhr.status)}`, null, []));
      }
    };
    xhr.onerror = () => {
      reject(new ApiError(0, 'UPLOAD_FAILED', 'storage unreachable', null, []));
    };
    xhr.send(file);
  });
}

/**
 * The attachment flow (ARCHITECTURE §8): upload intent, direct PUT to object storage, completion.
 * Resolves with the attachment id when the server verified the content, or null when it rejected it.
 */
export async function uploadAttachment(
  ownerType: OwnerType,
  ownerId: string,
  file: File,
  callbacks: UploadCallbacks,
): Promise<string | null> {
  const intent = (
    await request(() =>
      api.POST('/api/v1/attachments/upload-intents', {
        body: { ownerType, ownerId, filename: file.name, contentType: file.type, sizeBytes: file.size },
      }),
    )
  ).data;
  await putWithProgress(intent.upload.url, intent.upload.headers, file, callbacks.onProgress);
  callbacks.onVerifying();
  const completed = (
    await request(() =>
      api.POST('/api/v1/attachments/{id}/complete', { params: { path: { id: intent.attachment.id } } }),
    )
  ).data;
  return completed.status === 'AVAILABLE' ? completed.id : null;
}
