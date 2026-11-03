import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { extname } from 'node:path';
import { sha256Hex } from './hash.ts';

/**
 * PARW v1 layout (all integers big-endian):
 *   0..3   magic "PARW"
 *   4..5   format version (u16)
 *   6..9   metadata length N (u32)
 *   10..   metadata (UTF-8 JSON, N bytes)
 *   ...    payload (metadata.compressedSize bytes; zstd frame or raw bytes)
 */
export const PARW_MAGIC = Buffer.from('PARW', 'ascii');
export const PARW_VERSION = 1;
export const PARW_FIXED_HEADER_BYTES = 10;
const MAX_METADATA_BYTES = 64 * 1024;

export type ParwCompression = 'zstd' | 'none';

export interface ParwMetadata {
  filename: string;
  extension: string;
  mimeType: string;
  originalSize: number;
  compression: ParwCompression;
  /** SHA-256 (hex) of the ORIGINAL, uncompressed bytes. */
  sha256: string;
  compressedSize: number;
}

export type ParwErrorCode =
  | 'BAD_MAGIC'
  | 'UNSUPPORTED_VERSION'
  | 'TRUNCATED'
  | 'BAD_METADATA'
  | 'PAYLOAD_LENGTH_MISMATCH'
  | 'UNSUPPORTED_COMPRESSION'
  | 'DECOMPRESSION_FAILED'
  | 'SIZE_MISMATCH'
  | 'CHECKSUM_MISMATCH';

export class ParwError extends Error {
  code: ParwErrorCode;
  constructor(code: ParwErrorCode, message: string) {
    super(message);
    this.name = 'ParwError';
    this.code = code;
  }
}

const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  '.csv': 'text/csv', '.html': 'text/html', '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg',
  '.zip': 'application/zip',
};

export function guessMimeType(filename: string): string {
  return MIME_BY_EXT[extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

export interface EncodeInput {
  data: Uint8Array;
  filename: string;
  mimeType?: string;
  /** zstd level; default 3. */
  compressionLevel?: number;
}

export function encodeParw(input: EncodeInput): Buffer {
  const data = Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength);
  const level = input.compressionLevel ?? 3;
  const zstd = zstdCompressSync(data, { params: { [constants.ZSTD_c_compressionLevel]: level } });

  // Correctness over ratio: store raw if zstd does not help (already-compressed media).
  const useZstd = zstd.length < data.length;
  const payload = useZstd ? zstd : data;

  const metadata: ParwMetadata = {
    filename: input.filename,
    extension: extname(input.filename),
    mimeType: input.mimeType ?? guessMimeType(input.filename),
    originalSize: data.length,
    compression: useZstd ? 'zstd' : 'none',
    sha256: sha256Hex(data),
    compressedSize: payload.length,
  };
  const metaBuf = Buffer.from(JSON.stringify(metadata), 'utf8');

  const header = Buffer.alloc(PARW_FIXED_HEADER_BYTES);
  PARW_MAGIC.copy(header, 0);
  header.writeUInt16BE(PARW_VERSION, 4);
  header.writeUInt32BE(metaBuf.length, 6);
  return Buffer.concat([header, metaBuf, payload]);
}

function parseMetadata(raw: unknown): ParwMetadata {
  const bad = (why: string) => new ParwError('BAD_METADATA', `Invalid PARW metadata: ${why}`);
  if (typeof raw !== 'object' || raw === null) throw bad('not an object');
  const m = raw as Record<string, unknown>;
  const str = (k: string) => {
    if (typeof m[k] !== 'string') throw bad(`${k} must be a string`);
    return m[k] as string;
  };
  const int = (k: string) => {
    const v = m[k];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw bad(`${k} must be a non-negative integer`);
    return v;
  };
  const sha256 = str('sha256');
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw bad('sha256 must be 64 lowercase hex chars');
  const compression = str('compression');
  if (compression !== 'zstd' && compression !== 'none') {
    throw new ParwError('UNSUPPORTED_COMPRESSION', `Unsupported compression "${compression}"`);
  }
  return {
    filename: str('filename'), extension: str('extension'), mimeType: str('mimeType'),
    originalSize: int('originalSize'), compression, sha256, compressedSize: int('compressedSize'),
  };
}

/** Parse the header + metadata only (no decompression, no checksum verification). */
export function readParwMetadata(input: Uint8Array): { metadata: ParwMetadata; payloadOffset: number } {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buf.length < PARW_FIXED_HEADER_BYTES) throw new ParwError('TRUNCATED', 'Input shorter than PARW header');
  if (!buf.subarray(0, 4).equals(PARW_MAGIC)) throw new ParwError('BAD_MAGIC', 'Missing PARW magic bytes');
  const version = buf.readUInt16BE(4);
  if (version !== PARW_VERSION) throw new ParwError('UNSUPPORTED_VERSION', `Unsupported PARW version ${version}`);
  const metaLen = buf.readUInt32BE(6);
  if (metaLen > MAX_METADATA_BYTES) throw new ParwError('BAD_METADATA', `Metadata length ${metaLen} exceeds limit`);
  const payloadOffset = PARW_FIXED_HEADER_BYTES + metaLen;
  if (buf.length < payloadOffset) throw new ParwError('TRUNCATED', 'Input ends inside metadata');
  let raw: unknown;
  try {
    raw = JSON.parse(buf.subarray(PARW_FIXED_HEADER_BYTES, payloadOffset).toString('utf8'));
  } catch {
    throw new ParwError('BAD_METADATA', 'Metadata is not valid JSON');
  }
  return { metadata: parseMetadata(raw), payloadOffset };
}

export interface DecodeResult {
  data: Buffer;
  metadata: ParwMetadata;
}

/** Decode and fully verify. Throws ParwError on ANY inconsistency. */
export function decodeParw(input: Uint8Array): DecodeResult {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const { metadata, payloadOffset } = readParwMetadata(buf);
  const payload = buf.subarray(payloadOffset);
  if (payload.length !== metadata.compressedSize) {
    throw new ParwError(
      'PAYLOAD_LENGTH_MISMATCH',
      `Payload is ${payload.length} bytes but metadata declares ${metadata.compressedSize}`,
    );
  }

  let data: Buffer;
  if (metadata.compression === 'none') {
    data = Buffer.from(payload);
  } else {
    try {
      // maxOutputLength bounds memory if a malicious header lies about the size.
      data = zstdDecompressSync(payload, { maxOutputLength: Math.max(metadata.originalSize, 1) });
    } catch (e) {
      throw new ParwError('DECOMPRESSION_FAILED', `zstd decompression failed: ${(e as Error).message}`);
    }
  }

  if (data.length !== metadata.originalSize) {
    throw new ParwError('SIZE_MISMATCH', `Decoded ${data.length} bytes, metadata declares ${metadata.originalSize}`);
  }
  const actual = sha256Hex(data);
  if (actual !== metadata.sha256) {
    throw new ParwError('CHECKSUM_MISMATCH', `SHA-256 mismatch: expected ${metadata.sha256}, got ${actual}`);
  }
  return { data, metadata };
}
