import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decodeParw, encodeParw, ParwError, readParwMetadata, PARW_FIXED_HEADER_BYTES } from './format.ts';
import { sha256Hex } from './hash.ts';

const text = Buffer.from('hello parw\n'.repeat(5000));

test('round-trips IMG_1234.txt byte-for-byte', () => {
  const parw = encodeParw({ data: text, filename: 'IMG_1234.txt' });
  const { data, metadata } = decodeParw(parw);
  assert.equal(sha256Hex(data), sha256Hex(text));
  assert.ok(data.equals(text));
  assert.equal(metadata.filename, 'IMG_1234.txt');
  assert.equal(metadata.extension, '.txt');
  assert.equal(metadata.mimeType, 'text/plain');
  assert.equal(metadata.compression, 'zstd');
  assert.equal(metadata.originalSize, text.length);
  assert.ok(parw.length < text.length / 10);
});

test('stores incompressible data raw and still round-trips', () => {
  const rnd = randomBytes(100_000);
  const parw = encodeParw({ data: rnd, filename: 'noise.bin' });
  const { data, metadata } = decodeParw(parw);
  assert.equal(metadata.compression, 'none');
  assert.ok(data.equals(rnd));
});

test('handles empty files', () => {
  const { data } = decodeParw(encodeParw({ data: Buffer.alloc(0), filename: 'empty' }));
  assert.equal(data.length, 0);
});

test('metadata is readable without decoding', () => {
  const parw = encodeParw({ data: text, filename: 'a.txt' });
  const { metadata, payloadOffset } = readParwMetadata(parw);
  assert.equal(metadata.sha256, sha256Hex(text));
  assert.equal(parw.length - payloadOffset, metadata.compressedSize);
});

test('detects corrupted raw payload via SHA-256', () => {
  const parw = encodeParw({ data: randomBytes(5000), filename: 'x.bin' });
  parw[parw.length - 1] ^= 0xff;
  assert.throws(() => decodeParw(parw), (e) => e instanceof ParwError && e.code === 'CHECKSUM_MISMATCH');
});

test('detects corrupted zstd payload', () => {
  const parw = encodeParw({ data: text, filename: 'x.txt' });
  parw[parw.length - 3] ^= 0xff;
  assert.throws(
    () => decodeParw(parw),
    (e) => e instanceof ParwError && ['DECOMPRESSION_FAILED', 'CHECKSUM_MISMATCH', 'SIZE_MISMATCH'].includes(e.code),
  );
});

test('detects a tampered checksum in metadata', () => {
  const parw = encodeParw({ data: text, filename: 'x.txt' });
  const metaLen = parw.readUInt32BE(6);
  const meta = JSON.parse(parw.subarray(PARW_FIXED_HEADER_BYTES, PARW_FIXED_HEADER_BYTES + metaLen).toString());
  meta.sha256 = '0'.repeat(64);
  const metaBuf = Buffer.from(JSON.stringify(meta));
  const header = Buffer.from(parw.subarray(0, PARW_FIXED_HEADER_BYTES));
  header.writeUInt32BE(metaBuf.length, 6);
  const forged = Buffer.concat([header, metaBuf, parw.subarray(PARW_FIXED_HEADER_BYTES + metaLen)]);
  assert.throws(() => decodeParw(forged), (e) => e instanceof ParwError && e.code === 'CHECKSUM_MISMATCH');
});

test('rejects bad magic, bad version, truncation', () => {
  const parw = encodeParw({ data: text, filename: 'x.txt' });
  const badMagic = Buffer.from(parw); badMagic[0] = 0x58;
  assert.throws(() => decodeParw(badMagic), (e) => (e as ParwError).code === 'BAD_MAGIC');
  const badVersion = Buffer.from(parw); badVersion.writeUInt16BE(99, 4);
  assert.throws(() => decodeParw(badVersion), (e) => (e as ParwError).code === 'UNSUPPORTED_VERSION');
  assert.throws(() => decodeParw(parw.subarray(0, 5)), (e) => (e as ParwError).code === 'TRUNCATED');
  assert.throws(() => decodeParw(parw.subarray(0, parw.length - 10)), (e) => (e as ParwError).code === 'PAYLOAD_LENGTH_MISMATCH');
  assert.throws(() => decodeParw(Buffer.concat([parw, Buffer.from([1])])), (e) => (e as ParwError).code === 'PAYLOAD_LENGTH_MISMATCH');
});
