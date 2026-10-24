import * as path from 'path';

import * as vscode from 'vscode';

import { FMClientError } from '../services/errors';
import type { ContainerUploadFile } from '../types/fm';

export const DEFAULT_CONTAINER_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
const MAX_CONTAINER_UPLOAD_MAX_BYTES = 2_147_483_647;

const CONTENT_TYPES_BY_EXTENSION: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.txt': 'text/plain',
  '.webp': 'image/webp'
};

export function normalizeContainerUploadMaxBytes(configured: unknown): number {
  if (typeof configured !== 'number' || !Number.isFinite(configured)) {
    return DEFAULT_CONTAINER_UPLOAD_MAX_BYTES;
  }

  return clamp(Math.round(configured), 1, MAX_CONTAINER_UPLOAD_MAX_BYTES);
}

export async function readContainerUploadFile(
  uri: vscode.Uri,
  maxBytes: number
): Promise<ContainerUploadFile> {
  const normalizedMaxBytes = normalizeContainerUploadMaxBytes(maxBytes);
  const stat = await vscode.workspace.fs.stat(uri);

  if (stat.size > normalizedMaxBytes) {
    throw createContainerUploadTooLargeError(stat.size, normalizedMaxBytes);
  }

  const content = await vscode.workspace.fs.readFile(uri);
  if (content.byteLength > normalizedMaxBytes) {
    throw createContainerUploadTooLargeError(content.byteLength, normalizedMaxBytes);
  }

  const fileName = resolveFileName(uri);

  return {
    fileName,
    content,
    contentType: detectContainerUploadContentType(fileName)
  };
}

export function detectContainerUploadContentType(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  return CONTENT_TYPES_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

export function createContainerUploadTooLargeError(
  actualBytes: number,
  maxBytes: number
): FMClientError {
  return new FMClientError(
    `Container upload is ${formatBytes(actualBytes)}, which exceeds the configured limit of ${formatBytes(maxBytes)}.`,
    {
      code: 'CONTAINER_UPLOAD_TOO_LARGE',
      details: {
        actualBytes,
        maxBytes
      }
    }
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${formatNumber(kib)} KB`;
  }

  const mib = kib / 1024;
  if (mib < 1024) {
    return `${formatNumber(mib)} MB`;
  }

  return `${formatNumber(mib / 1024)} GB`;
}

function resolveFileName(uri: vscode.Uri): string {
  const candidate = uri.fsPath || uri.path || 'upload';
  const fileName = path.basename(candidate);
  return fileName.trim() || 'upload';
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
