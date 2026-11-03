import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '../../server/parw/hash.ts';
import { startTestServer } from '../../server/testing/harness.ts';
import * as api from './client.ts';
import type { RestoreEvent } from './types.ts';
import { applyEvent, initialSteps } from './restoreProgress.ts';
import { fmtBytes, fmtSavings } from './format.ts';

let t: Awaited<ReturnType<typeof startTestServer>>;
before(async () => { t = await startTestServer({ target: 400 * 1024, maxRepos: 3, maxFile: 600 * 1024 }); api.configureApi({ baseUrl: t.baseUrl }); });
after(() => t.close());

const photo = Buffer.concat([randomBytes(60_000), Buffer.alloc(100_000, 9)]); // partly compressible
const KB = 1024;

test('COMPLETE LOCAL WORKFLOW over HTTP: preview -> upload -> list -> archive -> archived list -> restore -> verify', async () => {
  // preview: nothing is written
  const pv = await api.previewUpload('photos/IMG_001.jpg', photo);
  assert.equal(pv.status, 'ready');
  assert.ok(pv.parwSize! < photo.length && pv.compressionRatio! > 0.3);
  assert.match(pv.targetRepository!, /new repository will be created/);
  assert.equal((await api.listFiles()).length, 0);

  // upload (File/Blob body goes straight in as the raw body; progress callback fires)
  const progress: number[] = [];
  const up = await api.uploadFile('photos/IMG_001.jpg', photo, { onProgress: (l, tot) => progress.push(l / tot) });
  assert.equal(progress.at(-1), 1);
  assert.equal(up.status, 'active');
  assert.equal(up.sha256, sha256Hex(photo));
  assert.equal(up.currentRepoFootprint, up.storedSize);

  // list + tree
  assert.deepEqual((await api.listFiles()).map((f) => f.virtualPath), ['photos/IMG_001.jpg']);
  const tree = await api.getTree();
  assert.equal(tree.children![0].name, 'photos');

  // download returns the byte-identical original
  const dl = await fetch(api.downloadUrl('photos/IMG_001.jpg'));
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition')!, /IMG_001\.jpg/);
  assert.equal(sha256Hex(Buffer.from(await dl.arrayBuffer())), sha256Hex(photo));

  // archive
  const arch = await api.archiveFile('photos/IMG_001.jpg');
  assert.equal(arch.status, 'archived');
  assert.ok(arch.currentRepoFootprint < 400, 'only a pointer remains in the tree');
  assert.ok(arch.archivedFromCommitSha);
  assert.equal((await api.listFiles('archived')).length, 1);
  assert.equal((await api.listFiles('active')).length, 0);
  assert.equal((await fetch(api.downloadUrl('photos/IMG_001.jpg'))).status, 404, 'archived files cannot be downloaded');

  // the dashboard must not claim the archive freed anything
  const dash = await api.getDashboard();
  assert.equal(dash.historical.archivedFiles, 1);
  assert.ok(dash.historical.inferredRetainedBytes >= up.storedSize);
  assert.ok(dash.tree.currentRepoBytes < 1000);
  assert.match(dash.notes.join(' '), /does NOT remove/);

  // restore: streaming events, in order, with a running state before each success
  const events: RestoreEvent[] = [];
  let steps = initialSteps({ restoreToTree: true });
  const out = await api.restoreFile('photos/IMG_001.jpg', { restoreToTree: true }, (e) => { events.push(e); steps = applyEvent(steps, e); });
  assert.ok(out.ok);
  assert.equal(events[0].type, 'start');
  assert.equal(events.at(-1)!.type, 'done');
  assert.equal(events.filter((e) => e.type === 'start').length, 8);
  assert.deepEqual(steps.map((s) => s.state), Array(8).fill('success'));

  // reconstructed file on disk is byte-identical
  const restored = join(t.dir, 'restored', 'photos/IMG_001.jpg');
  assert.ok(existsSync(restored));
  assert.equal(sha256Hex(readFileSync(restored)), sha256Hex(photo));
  assert.equal((await api.listFiles('active'))[0].status, 'active');
  assert.equal((await api.listFiles('archived')).length, 0);
});

test('restore failure stops at the failing step and reports the exact reason', async () => {
  await api.uploadFile('docs/a.bin', randomBytes(20 * KB));
  await api.archiveFile('docs/a.bin');
  (t.store as unknown as { db: { exec(s: string): void } }).db.exec(`UPDATE files SET original_sha256='${'0'.repeat(64)}' WHERE virtual_path='docs/a.bin'`);
  let steps = initialSteps({ restoreToTree: false });
  const out = await api.restoreFile('docs/a.bin', {}, (e) => { steps = applyEvent(steps, e); });
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.failedStep, 'verify-original-sha256');
    assert.match(out.message, /database expects 0{64}/);
  }
  assert.deepEqual(steps.map((s) => s.state), ['success', 'success', 'success', 'success', 'success', 'failed', 'aborted', 'skipped']);
  assert.equal(existsSync(join(t.dir, 'restored', 'docs/a.bin')), false, 'nothing written after a failed verification');
  assert.equal((await api.listFiles('archived')).length, 1, 'still archived');
});

test('multi-repo: files spill into a second repository, hidden behind one tree', async () => {
  await api.uploadFile('videos/v1.bin', randomBytes(200 * KB));
  await api.uploadFile('videos/v2.bin', randomBytes(200 * KB));
  const repos = await api.getRepositories();
  assert.ok(repos.length >= 2);
  assert.ok(repos.every((r) => r.targetSize === 400 * KB));
  assert.equal(repos.reduce((n, r) => n + r.files, 0), (await api.listFiles()).length); // archived files count too
  const names = (await api.getTree()).children!.map((c) => c.name);
  assert.deepEqual(names, ['docs', 'photos', 'videos']);
});

test('upload errors surface as typed ApiErrors; previews explain why', async () => {
  await assert.rejects(api.uploadFile('photos/IMG_001.jpg', photo), (e) => e instanceof api.ApiError && e.status === 409 && e.code === 'ALREADY_EXISTS');
  await assert.rejects(api.uploadFile('../escape', photo), (e) => e instanceof api.ApiError && e.status === 400);
  await assert.rejects(api.archiveFile('nope'), (e) => e instanceof api.ApiError && e.status === 404);
  assert.equal((await api.previewUpload('photos/IMG_001.jpg', photo)).status, 'exists');
  assert.equal((await api.previewUpload('big.bin', randomBytes(700 * KB))).status, 'requires-chunking');
  await assert.rejects(api.uploadFile('big.bin', randomBytes(700 * KB)), (e) => e instanceof api.ApiError && e.status === 413);
});

test('settings expose limits but never secrets', async () => {
  const s = await api.getSettings();
  assert.equal(s.backend, 'local');
  assert.equal(s.experimentalBackend, false);
  assert.equal(s.parwCompression.algorithm, 'zstd');
  assert.deepEqual(s.experimentLimits, { maxFiles: 4, maxSizeMiB: 50 });
  assert.equal(JSON.stringify(s).includes('secret'), false);
  assert.deepEqual(Object.keys(s.github).sort(), ['connected', 'login', 'oauthConfigured', 'scope']);
  assert.equal((await api.getAuthStatus()).connected, true);
});

test('experiment runs sandboxed in local mode and does not touch the volume', async () => {
  const before = await api.listFiles();
  const r = await api.runExperiment({ sizesMiB: [0.1, 0.25] });
  assert.equal(r.sandboxed, true);
  assert.ok(r.result.files.every((f) => f.verified));
  assert.match(r.report, /did NOT reduce the repository footprint/);
  assert.deepEqual(await api.listFiles(), before);
  await assert.rejects(api.runExperiment({ sizesMiB: [51] }), (e) => e instanceof api.ApiError && e.status === 400);
  await assert.rejects(api.runExperiment({ sizesMiB: [1, 1, 1, 1, 1] }), (e) => e instanceof api.ApiError && e.status === 400);
});

test('CSRF guard rejects cross-origin state changes', async () => {
  const res = await fetch(`${t.baseUrl}/api/files/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{"path":"x"}' });
  assert.equal(res.status, 403);
});

test('formatters and step reducer', () => {
  assert.equal(fmtBytes(5.2 * 1024 * 1024), '5.20 MiB');
  assert.equal(fmtSavings(0.21), '21.0% smaller');
  assert.equal(fmtSavings(0), 'no savings');
  assert.equal(fmtSavings(-0.1), '10.0% larger');
  const s = initialSteps({ restoreToTree: false });
  assert.equal(s[7].state, 'skipped');
  assert.equal(applyEvent(s, { type: 'start', step: 'read-pointer' })[0].state, 'running');
});
