import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chunkName, decodeChunk, encodeChunk, reassembleChunks, splitIntoChunks } from './chunking.ts';
import { sha256Hex } from '../parw/hash.ts';

test('splits, serialises, shuffles and reassembles', () => {
  const data = randomBytes(10_500);
  const chunks = splitIntoChunks(data, { fileId: 'file-1', chunkSize: 4096 });
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((c) => c.header.sequence), [0, 1, 2]);
  assert.ok(chunks.every((c) => c.header.total === 3 && c.header.fileId === 'file-1'));
  assert.equal(chunkName('video.parw', 2), 'video.parw.002');

  const roundTripped = chunks.map((c) => decodeChunk(encodeChunk(c))).reverse();
  const whole = reassembleChunks(roundTripped);
  assert.equal(sha256Hex(whole), sha256Hex(data));
});

test('detects missing, duplicate, corrupt and foreign chunks', () => {
  const data = randomBytes(9000);
  const chunks = splitIntoChunks(data, { fileId: 'f', chunkSize: 3000 });
  assert.throws(() => reassembleChunks([chunks[0], chunks[2]]), /Missing chunk\(s\): 1/);
  assert.throws(() => reassembleChunks([chunks[0], chunks[0], chunks[1], chunks[2]]), /Duplicate/);

  const enc = encodeChunk(chunks[1]);
  enc[enc.length - 1] ^= 1;
  assert.throws(() => decodeChunk(enc), /failed SHA-256/);

  const other = splitIntoChunks(randomBytes(9000), { fileId: 'g', chunkSize: 3000 });
  assert.throws(() => reassembleChunks([chunks[0], other[1], chunks[2]]), /different files/);
});

test('handles empty input and rejects absurd chunk counts', () => {
  const c = splitIntoChunks(Buffer.alloc(0), { fileId: 'e', chunkSize: 10 });
  assert.equal(c.length, 1);
  assert.equal(reassembleChunks(c).length, 0);
  assert.throws(() => splitIntoChunks(Buffer.alloc(5000), { fileId: 'x', chunkSize: 1 }), /max 1000/);
});
