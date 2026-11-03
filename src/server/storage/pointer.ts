import { normalizePath } from '../util/paths.ts';

export const POINTER_SUFFIX = '.pointer';

export interface ParwPointer {
  format: 'parw-pointer';
  version: 1;
  /** Path of the original .parw file inside the repository. */
  originalPath: string;
  /** Commit in which the original .parw file still existed. */
  commitSha: string;
  /** SHA-256 (hex) of the ORIGINAL .parw file bytes (not the decoded file). */
  sha256: string;
  /** Size in bytes of the .parw file. */
  size: number;
}

export function pointerPathFor(parwPath: string): string {
  return parwPath + POINTER_SUFFIX;
}

export function createPointer(args: { originalPath: string; commitSha: string; sha256: string; size: number }): {
  pointer: ParwPointer;
  bytes: Buffer;
} {
  const pointer: ParwPointer = {
    format: 'parw-pointer',
    version: 1,
    originalPath: args.originalPath,
    commitSha: args.commitSha,
    sha256: args.sha256,
    size: args.size,
  };
  validate(pointer); // never write something we could not read back
  return { pointer, bytes: Buffer.from(JSON.stringify(pointer, null, 2) + '\n', 'utf8') };
}

function validate(p: unknown): asserts p is ParwPointer {
  if (typeof p !== 'object' || p === null) throw new Error('Pointer is not an object');
  const o = p as Record<string, unknown>;
  if (o.format !== 'parw-pointer') throw new Error('Not a parw-pointer');
  if (o.version !== 1) throw new Error(`Unsupported pointer version ${String(o.version)}`);
  if (typeof o.originalPath !== 'string') throw new Error('originalPath must be a string');
  // Reject traversal / absolute paths: this value is later used to fetch from the repo.
  if (normalizePath(o.originalPath) !== o.originalPath) throw new Error('originalPath is not normalised');
  if (!o.originalPath.endsWith('.parw')) throw new Error('originalPath must end in .parw');
  if (typeof o.commitSha !== 'string' || !/^[0-9a-f]{7,64}$/.test(o.commitSha)) throw new Error('commitSha invalid');
  if (typeof o.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(o.sha256)) throw new Error('sha256 invalid');
  if (typeof o.size !== 'number' || !Number.isSafeInteger(o.size) || o.size < 0) throw new Error('size invalid');
}

export function parsePointer(bytes: Uint8Array): ParwPointer {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new Error('Pointer is not valid JSON');
  }
  validate(raw);
  return raw;
}
