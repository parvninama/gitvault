import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeParw } from '../parw/format.ts';
import { sha256Hex } from '../parw/hash.ts';
import { LocalStorageProvider } from './LocalStorageProvider.ts';
import { LocalVersionedBackend } from './LocalVersionedBackend.ts';
import { RestoreError, VersionedStorageProvider } from './VersionedStorageProvider.ts';
import { StorageError } from './errors.ts';
import { createPointer, pointerPathFor } from './pointer.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'gitvault-'));
// Semi-compressible "photo": random blocks repeated, so zstd does something but not everything.
const photo = () => Buffer.concat([randomBytes(200_000), Buffer.alloc(300_000, 7)]);

test('upload lists an active file and refuses silent overwrite', async () => {
  const p = new LocalStorageProvider(tmp());
  const parw = encodeParw({ data: photo(), filename: 'IMG_1234.jpg' });
  const up = await p.uploadFile({ virtualPath: '/photos/IMG_1234.jpg', parw });
  assert.equal(up.backendPath, 'photos/IMG_1234.jpg.parw');
  assert.equal(up.parwSha256, sha256Hex(parw));
  const files = await p.listFiles();
  assert.deepEqual(files.map((f) => [f.virtualPath, f.status, f.treeBytes]), [['photos/IMG_1234.jpg', 'active', parw.length]]);
  await assert.rejects(p.uploadFile({ virtualPath: 'photos/IMG_1234.jpg', parw }), (e) => (e as StorageError).code === 'ALREADY_EXISTS');
});

test('files above the target size are refused with REQUIRES_CHUNKING', async () => {
  const p = new LocalStorageProvider(tmp(), { maxFileSize: 1000 });
  const parw = encodeParw({ data: randomBytes(5000), filename: 'big.bin' });
  await assert.rejects(p.uploadFile({ virtualPath: 'big.bin', parw }), (e) => (e as StorageError).code === 'REQUIRES_CHUNKING');
  assert.equal((await p.listFiles()).length, 0);
});

test('archive replaces the file with a pointer but history keeps the blob', async () => {
  const p = new LocalStorageProvider(tmp());
  const parw = encodeParw({ data: randomBytes(300_000), filename: 'raw.bin' }); // incompressible => parw ~ 300 KB
  const up = await p.uploadFile({ virtualPath: 'docs/raw.bin', parw });
  const before = await p.getUsage();
  assert.equal(before.currentTreeBytes, parw.length);

  const a = await p.archiveFile('docs/raw.bin');
  assert.equal(a.pointer.commitSha, up.commitSha);
  assert.equal(a.pointer.sha256, up.parwSha256);
  assert.equal(a.pointer.size, parw.length);
  assert.equal(a.pointer.originalPath, 'docs/raw.bin.parw');

  const files = await p.listFiles();
  assert.deepEqual(files.map((f) => [f.status, f.treeBytes]), [['archived', a.pointerBytes]]);
  await assert.rejects(p.downloadFile('docs/raw.bin'), (e) => (e as StorageError).code === 'NOT_FOUND');
  await assert.rejects(p.archiveFile('docs/raw.bin'), (e) => (e as StorageError).code === 'ALREADY_ARCHIVED');

  const after = await p.getUsage();
  assert.equal(after.currentTreeBytes, a.pointerBytes, 'current tree is only the pointer');
  assert.equal(after.historicalObjectBytes, parw.length + a.pointerBytes, 'archiving frees NOTHING in history');
  assert.equal(after.retainedOnlyInHistoryBytes, parw.length);
  assert.equal(after.commits, 2);
  assert.equal(after.binaryObjects, 2);
});

test('E2E: original -> PARW -> store -> archive -> historical retrieval -> decode -> identical', async () => {
  const dir = tmp();
  const p = new LocalStorageProvider(join(dir, 'repo'));
  const original = photo();
  const parw = encodeParw({ data: original, filename: 'IMG_9.jpg' });
  await p.uploadFile({ virtualPath: 'photos/IMG_9.jpg', parw });
  await p.archiveFile('photos/IMG_9.jpg');

  const seen: string[] = [];
  const out = join(dir, 'out', 'IMG_9.jpg');
  const r = await p.restoreFile('photos/IMG_9.jpg', {
    outputPath: out, restoreToTree: true, expectedOriginalSha256: sha256Hex(original), onStep: (s) => seen.push(s.step),
  });
  assert.equal(sha256Hex(original), sha256Hex(r.data));
  assert.equal(sha256Hex(readFileSync(out)), sha256Hex(original));
  assert.deepEqual(seen, ['read-pointer', 'locate-commit', 'fetch-historical', 'verify-parw-sha256', 'decode-parw',
    'verify-original-sha256', 'write-local', 'restore-to-tree']);
  assert.ok(r.steps.every((s) => s.status === 'ok'));
  // Back in the current tree as an active file, pointer gone.
  assert.deepEqual((await p.listFiles()).map((f) => f.status), ['active']);
  assert.ok((await p.downloadFile('photos/IMG_9.jpg')).equals(parw));
});

test('restore aborts with the exact failing step when stored bytes are corrupted', async () => {
  const dir = tmp();
  const root = join(dir, 'repo');
  const p = new LocalStorageProvider(root);
  const parw = encodeParw({ data: randomBytes(50_000), filename: 'a.bin' });
  const up = await p.uploadFile({ virtualPath: 'a.bin', parw });
  await p.archiveFile('a.bin');
  // Corrupt the historical object in place (objects are named by their SHA-256).
  const bad = Buffer.from(parw); bad[bad.length - 1] ^= 1;
  writeFileSync(join(root, 'objects', up.parwSha256), bad);

  const out = join(dir, 'should-not-exist');
  await assert.rejects(p.restoreFile('a.bin', { outputPath: out, restoreToTree: true }), (e) => {
    assert.ok(e instanceof RestoreError);
    assert.equal(e.step, 'verify-parw-sha256');
    assert.deepEqual(e.steps.map((s) => s.status), ['ok', 'ok', 'ok', 'failed']);
    return true;
  });
  assert.throws(() => readFileSync(out), 'nothing may be written after a failed check');
  assert.deepEqual((await p.listFiles()).map((f) => f.status), ['archived'], 'tree untouched on failure');
});

test('restore reports a pointer whose hash lies, a missing commit and a missing pointer', async () => {
  const backend = new LocalVersionedBackend(tmp());
  const p = new VersionedStorageProvider(backend);
  const parw = encodeParw({ data: randomBytes(2000), filename: 'a.bin' });
  const up = await p.uploadFile({ virtualPath: 'a.bin', parw });

  const stepOf = async (v: string) => p.restoreFile(v).then(() => 'none', (e) => (e as RestoreError).step);
  assert.equal(await stepOf('a.bin'), 'read-pointer'); // not archived

  const forge = (over: Partial<{ commitSha: string; sha256: string }>) => createPointer({
    originalPath: 'a.bin.parw', commitSha: up.commitSha, sha256: up.parwSha256, size: parw.length, ...over,
  }).bytes;

  await backend.commit([{ path: pointerPathFor('a.bin.parw'), data: forge({ sha256: 'c'.repeat(64) }) }], 'forge hash');
  assert.equal(await stepOf('a.bin'), 'verify-parw-sha256');

  await backend.commit([{ path: pointerPathFor('a.bin.parw'), data: forge({ commitSha: 'd'.repeat(40) }) }], 'forge commit');
  assert.equal(await stepOf('a.bin'), 'locate-commit');
});
