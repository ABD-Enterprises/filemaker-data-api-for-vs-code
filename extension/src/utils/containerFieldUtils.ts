import type { FileMakerFieldMetadata } from '../types/fm';

/**
 * Check if a field metadata entry is a container field.
 * Container fields have result type 'container' in the Data API metadata.
 */
export function isContainerField(field: FileMakerFieldMetadata): boolean {
  const result = (field.result ?? '').toLowerCase();
  const type = (field.type ?? '').toLowerCase();
  return result === 'container' || type === 'container' || result.includes('container');
}

/**
 * Resolve a container field value to a full download URL.
 *
 * Container field values from the Data API are typically relative URLs like:
 *   `/Streaming_SSL/MainDB/abc123...`
 *
 * Or they may already be full URLs.
 */
export function resolveContainerUrl(serverUrl: string, containerValue: unknown): string | undefined {
  if (typeof containerValue !== 'string' || containerValue.length === 0) {
    return undefined;
  }

  // Already a full URL
  if (containerValue.startsWith('http://') || containerValue.startsWith('https://')) {
    return containerValue;
  }

  // Relative URL — prepend server
  const base = serverUrl.replace(/\/+$/, '');
  const path = containerValue.startsWith('/') ? containerValue : `/${containerValue}`;
  return `${base}${path}`;
}

/**
 * Guess if a container field value points to an image based on common extensions.
 */
export function isImageContainer(containerValue: string): boolean {
  const lower = containerValue.toLowerCase();
  return /\.(jpg|jpeg|png|gif|bmp|webp|svg|tiff?)(\?|$)/i.test(lower);
}
