import { sha256Hex } from '../parw/hash.ts';

/**
 * EXPERIMENTAL. Chunk file layout: "PARC" | u32 headerLen | header JSON | payload.
 * Chunk names: <base>.000, <base>.001, ...
 */
const CHUNK_MAGIC = Buffer.from('PARC', 'ascii');
const MAX_CHUNKS = 1000; // names use 3 digits

export interface ChunkHeader {
  fileId: string;
  sequence: number;
  total: number;
  /** SHA-256 of this chunk's payload. */
  sha256: string;
  /** SHA-256 and size of the complete (reassembled) PARW file. */
  wholeSha256: string;
  wholeSize: number;
}
export interface Chunk {
  header: ChunkHeader;
  payload: Buffer;
}

export function chunkName(base: string, sequence: number): string {
  return `${base}.${String(sequence).padStart(3, '0')}`;
}

export function splitIntoChunks(data: Buffer, opts: { fileId: string; chunkSize: number }): Chunk[] {
  if (!Number.isInteger(opts.chunkSize) || opts.chunkSize <= 0) throw new Error('chunkSize must be a positive integer');
  const total = Math.max(1, Math.ceil(data.length / opts.chunkSize));
  if (total > MAX_CHUNKS) throw new Error(`Would need ${total} chunks (max ${MAX_CHUNKS}); increase chunkSize`);
  const wholeSha256 = sha256Hex(data);
  const chunks: Chunk[] = [];
  for (let i = 0; i < total; i++) {
    const payload = data.subarray(i * opts.chunkSize, (i + 1) * opts.chunkSize);
    chunks.push({
      header: { fileId: opts.fileId, sequence: i, total, sha256: sha256Hex(payload), wholeSha256, wholeSize: data.length },
      payload: Buffer.from(payload),
    });
  }
  return chunks;
}

export function encodeChunk(chunk: Chunk): Buffer {
  const h = Buffer.from(JSON.stringify(chunk.header), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(h.length);
  return Buffer.concat([CHUNK_MAGIC, len, h, chunk.payload]);
}

export function decodeChunk(input: Uint8Array): Chunk {
  const buf = Buffer.from(input);
  if (buf.length < 8 || !buf.subarray(0, 4).equals(CHUNK_MAGIC)) throw new Error('Not a PARC chunk');
  const hLen = buf.readUInt32BE(4);
  if (hLen > 4096 || buf.length < 8 + hLen) throw new Error('Chunk header truncated or oversized');
  const header = JSON.parse(buf.subarray(8, 8 + hLen).toString('utf8')) as ChunkHeader;
  const payload = buf.subarray(8 + hLen);
  if (sha256Hex(payload) !== header.sha256) {
    throw new Error(`Chunk ${header.sequence}/${header.total} failed SHA-256 verification`);
  }
  return { header, payload: Buffer.from(payload) };
}

/** Reassemble in any input order; verifies every chunk, completeness, consistency and the whole-file hash. */
export function reassembleChunks(chunks: Chunk[]): Buffer {
  if (chunks.length === 0) throw new Error('No chunks supplied');
  const first = chunks[0].header;
  const bySeq = new Map<number, Chunk>();
  for (const c of chunks) {
    const h = c.header;
    if (h.fileId !== first.fileId || h.total !== first.total || h.wholeSha256 !== first.wholeSha256) {
      throw new Error('Chunks belong to different files');
    }
    if (sha256Hex(c.payload) !== h.sha256) throw new Error(`Chunk ${h.sequence} failed SHA-256 verification`);
    if (bySeq.has(h.sequence)) throw new Error(`Duplicate chunk ${h.sequence}`);
    bySeq.set(h.sequence, c);
  }
  const missing: number[] = [];
  for (let i = 0; i < first.total; i++) if (!bySeq.has(i)) missing.push(i);
  if (missing.length) throw new Error(`Missing chunk(s): ${missing.join(', ')}`);
  const whole = Buffer.concat(Array.from({ length: first.total }, (_, i) => bySeq.get(i)!.payload));
  if (whole.length !== first.wholeSize) throw new Error('Reassembled size mismatch');
  if (sha256Hex(whole) !== first.wholeSha256) throw new Error('Reassembled file failed SHA-256 verification');
  return whole;
}
