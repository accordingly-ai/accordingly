import type { DriveFile } from './types';

const MAX_TEXT_CHARS = 50_000;
const MAX_PDF_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_MAX_EDGE = 2048;

export interface ExtractionResult {
  text: string;
  truncated: boolean;
}

function truncate(text: string): ExtractionResult {
  if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_TEXT_CHARS), truncated: true };
}

async function driveFetch(path: string, token: string): Promise<Response> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Drive ${res.status}: ${body.slice(0, 200)}`);
  }
  return res;
}

export async function exportGoogleDoc(id: string, token: string): Promise<ExtractionResult> {
  const res = await driveFetch(
    `files/${encodeURIComponent(id)}/export?mimeType=text/plain`,
    token,
  );
  return truncate(await res.text());
}

export async function exportGoogleSheet(id: string, token: string): Promise<ExtractionResult> {
  const res = await driveFetch(
    `files/${encodeURIComponent(id)}/export?mimeType=text/csv`,
    token,
  );
  return truncate(await res.text());
}

export async function downloadText(id: string, token: string): Promise<ExtractionResult> {
  const res = await driveFetch(`files/${encodeURIComponent(id)}?alt=media`, token);
  return truncate(await res.text());
}

async function downloadBytes(id: string, token: string): Promise<ArrayBuffer> {
  const res = await driveFetch(`files/${encodeURIComponent(id)}?alt=media`, token);
  return await res.arrayBuffer();
}

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  return bufferToBase64(buf);
}

async function maybeResizeImage(buf: ArrayBuffer, mimeType: string): Promise<{ data: string; mimeType: string }> {
  try {
    const blob = new Blob([buf], { type: mimeType });
    const bitmap = await createImageBitmap(blob);
    const longEdge = Math.max(bitmap.width, bitmap.height);
    if (longEdge <= IMAGE_MAX_EDGE) {
      bitmap.close();
      return { data: bufferToBase64(buf), mimeType };
    }
    const scale = IMAGE_MAX_EDGE / longEdge;
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return { data: bufferToBase64(buf), mimeType };
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const outBlob: Blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('image resize failed'))),
        'image/jpeg',
        0.9,
      );
    });
    return { data: await blobToBase64(outBlob), mimeType: 'image/jpeg' };
  } catch {
    return { data: bufferToBase64(buf), mimeType };
  }
}

async function postExtract({
  data,
  mimeType,
  filename,
}: {
  data: string;
  mimeType: string;
  filename: string;
}): Promise<ExtractionResult> {
  const res = await fetch('/api/extract-document', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data, mimeType, filename }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      detail = j.error?.message ?? '';
    } catch {
      detail = await res.text().catch(() => '');
    }
    throw new Error(detail || `extract-document failed (${res.status})`);
  }
  const { text } = (await res.json()) as { text: string };
  return truncate(text ?? '');
}

export async function extractViaModel(
  file: DriveFile,
  token: string,
): Promise<ExtractionResult> {
  const buf = await downloadBytes(file.id, token);
  const isPdf = file.mimeType === 'application/pdf';
  const isImage = file.mimeType.startsWith('image/');
  if (isPdf && buf.byteLength > MAX_PDF_BYTES) {
    throw new Error(`PDF too large (${(buf.byteLength / 1e6).toFixed(1)} MB, max 32 MB)`);
  }
  if (isImage && buf.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Image too large (${(buf.byteLength / 1e6).toFixed(1)} MB, max 10 MB)`);
  }

  let data: string;
  let mimeType = file.mimeType;
  if (isImage) {
    const resized = await maybeResizeImage(buf, file.mimeType);
    data = resized.data;
    mimeType = resized.mimeType;
  } else {
    data = bufferToBase64(buf);
  }

  return postExtract({ data, mimeType, filename: file.name });
}

const EXTENSION_MIME: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  text: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  heif: 'image/heif',
};

export function mimeFromExtension(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return undefined;
  const ext = name.slice(dot + 1).toLowerCase();
  return EXTENSION_MIME[ext];
}

export interface DroppedExtraction extends ExtractionResult {
  name: string;
  mimeType: string;
}

export async function extractDroppedFile(file: File): Promise<DroppedExtraction> {
  const mimeType = file.type || mimeFromExtension(file.name);
  if (!mimeType) {
    throw new Error(`Unsupported type: ${file.name}`);
  }

  const isText =
    mimeType === 'text/plain' ||
    mimeType === 'text/markdown' ||
    mimeType === 'text/csv' ||
    mimeType === 'application/json';
  const isPdf = mimeType === 'application/pdf';
  const isImage = mimeType.startsWith('image/');

  if (isText) {
    const raw = await file.text();
    const { text, truncated } = truncate(raw);
    return { name: file.name, mimeType, text, truncated };
  }

  if (isPdf) {
    if (file.size > MAX_PDF_BYTES) {
      throw new Error(`PDF too large (${(file.size / 1e6).toFixed(1)} MB, max 32 MB)`);
    }
    const buf = await file.arrayBuffer();
    const { text, truncated } = await postExtract({
      data: bufferToBase64(buf),
      mimeType,
      filename: file.name,
    });
    return { name: file.name, mimeType, text, truncated };
  }

  if (isImage) {
    if (file.size > MAX_IMAGE_BYTES) {
      throw new Error(`Image too large (${(file.size / 1e6).toFixed(1)} MB, max 10 MB)`);
    }
    const buf = await file.arrayBuffer();
    const resized = await maybeResizeImage(buf, mimeType);
    const { text, truncated } = await postExtract({
      data: resized.data,
      mimeType: resized.mimeType,
      filename: file.name,
    });
    return { name: file.name, mimeType: resized.mimeType, text, truncated };
  }

  throw new Error(`Unsupported type: ${mimeType}`);
}

export async function extractFile(file: DriveFile, token: string): Promise<ExtractionResult> {
  const m = file.mimeType;
  if (m === 'application/vnd.google-apps.document') return exportGoogleDoc(file.id, token);
  if (m === 'application/vnd.google-apps.spreadsheet') return exportGoogleSheet(file.id, token);
  if (m === 'text/plain' || m === 'text/markdown' || m === 'text/csv' || m === 'application/json') {
    return downloadText(file.id, token);
  }
  if (m === 'application/pdf' || m.startsWith('image/')) {
    return extractViaModel(file, token);
  }
  throw new Error(`Unsupported mimeType: ${m}`);
}
