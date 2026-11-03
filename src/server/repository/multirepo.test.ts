import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetadataStore } from '../database/MetadataStore.ts';
import { GitHubClient } from '../github/GitHubClient.ts';
import { sha256Hex } from '../parw/hash.ts';
import { StorageError } from '../storage/errors.ts';
import { StorageService, CapacityError } from '../storage/StorageService.ts';
import { RestoreError } from '../storage/VersionedStorageProvider.ts';
import { GitHubProviderFactory, LocalProviderFactory } from './factories.ts';
import { RepositoryManager } from './RepositoryManager.ts';

const KB = 1024;
function setup(o: { target?: number; maxRepos?: number; maxFile?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gv-svc-'));
  const store = new MetadataStore(':memory:');
  const repos = new RepositoryManager({
    store, factory: new LocalProviderFactory(join(dir, 'repos')), targetSize: o.target ?? 300 * KB, maxRepositories: o.maxRepos ?? 3,
  });
  const service = new StorageService({ store, repos, maxFileSize: o.maxFile ?? 90 * 1024 * 1024, restoreDir: join(dir, 'restored') });
  return { dir, store, repos, service };
}
const blob = (kb: number) => randomBytes(kb * KB); // incompressible: PARW ~= original

test('repository allocation: fill-first, spills to a new repo, respects the repository limit', async () => {
  const { service, repos } = setup({ target: 300 * KB, maxRepos: 2 });
  const a = await service.upload({ virtualPath: 'photos/a.jpg', data: blob(120) });
  const b = await service.upload({ virtualPath: 'photos/b.jpg', data: blob(120) });
  const c = await service.upload({ virtualPath: 'videos/c.mp4', data: blob(120) }); // would exceed 300 KB in repo-01
  assert.deepEqual([a.repoId, b.repoId, c.repoId], ['repo-01', 'repo-01', 'repo-02']);
  assert.equal(repos.list().length, 2);
  await service.upload({ virtualPath: 'd', data: blob(120) }); // repo-02 now at 240 KB
  await assert.rejects(service.upload({ virtualPath: 'e', data: blob(120) }), (e) => e instanceof CapacityError);
  assert.equal(repos.list().length, 2, 'never exceeds the configured repository limit');
  await assert.rejects(service.upload({ virtualPath: 'huge', data: blob(400) }), /exceeds the whole-repository target/);
});

test('archiving does NOT free repository capacity (history counts)', async () => {
  const { service, repos } = setup({ target: 300 * KB, maxRepos: 1 });
  await service.upload({ virtualPath: 'a.bin', data: blob(200) });
  const before = repos.list()[0];
  await service.archive('a.bin');
  const after = repos.list()[0];
  assert.ok(after.approximateCurrentSize < 1000, 'tree is now just a pointer');
  assert.ok(after.approximateHistoricalSize >= before.approximateHistoricalSize, 'history did not shrink');
  // A second 200 KB file must NOT fit even though the current tree is nearly empty.
  await assert.rejects(service.upload({ virtualPath: 'b.bin', data: blob(200) }), (e) => e instanceof CapacityError);
});

test('one logical volume: tree is independent of repositories; files are located transparently', async () => {
  const { service } = setup({ target: 300 * KB });
  await service.upload({ virtualPath: 'photos/vacation/IMG_001.jpg', data: blob(150) });
  await service.upload({ virtualPath: 'photos/college/IMG_002.jpg', data: blob(150) });
  await service.upload({ virtualPath: 'documents/cv.pdf', data: blob(10) });
  const tree = service.tree();
  assert.deepEqual(tree.children!.map((c) => c.name), ['documents', 'photos']);
  const photos = tree.children!.find((c) => c.name === 'photos')!;
  assert.deepEqual(photos.children!.map((c) => c.name), ['college', 'vacation']);
  const repoIds = new Set(service.list().map((f) => f.repoId));
  assert.ok(repoIds.size >= 2, 'files really are spread over several repositories');
  await assert.rejects(service.upload({ virtualPath: '/photos/vacation/IMG_001.jpg', data: blob(1) }), (e) => (e as StorageError).code === 'ALREADY_EXISTS');
});

test('archive then restore across repositories verifies against the DB checksum and writes the file', async () => {
  const { service, dir } = setup({ target: 200 * KB });
  const originals = [blob(150), blob(150)];
  await service.upload({ virtualPath: 'x/one.bin', data: originals[0] });
  const two = await service.upload({ virtualPath: 'x/two.bin', data: originals[1] });
  assert.equal(two.repoId, 'repo-02');

  const archived = await service.archive('x/two.bin');
  assert.equal(archived.status, 'archived');
  assert.ok(archived.currentRepoFootprint < 400 && archived.storedSize > 100 * KB);
  assert.equal(service.list('archived').length, 1);

  const steps: string[] = [];
  const { file, result } = await service.restore('x/two.bin', { restoreToTree: true, onStep: (s) => steps.push(s.step) });
  assert.equal(file.status, 'active');
  assert.ok(result.steps.every((s) => s.status === 'ok') && steps.length === 8);
  assert.equal(sha256Hex(readFileSync(join(dir, 'restored', 'x/two.bin'))), sha256Hex(originals[1]));
  await assert.rejects(service.restore('x/one.bin'), (e) => (e as StorageError).code === 'NOT_ARCHIVED');
});

test('restore fails loudly when the database checksum disagrees with the data', async () => {
  const { service, store, dir } = setup();
  await service.upload({ virtualPath: 'a.bin', data: blob(20) });
  await service.archive('a.bin');
  (store as unknown as { db: { exec(s: string): void } }).db.exec(`UPDATE files SET original_sha256='${'0'.repeat(64)}'`);
  await assert.rejects(service.restore('a.bin'), (e) => e instanceof RestoreError && e.step === 'verify-original-sha256');
  assert.equal(existsSync(join(dir, 'restored', 'a.bin')), false);
  assert.equal(service.list()[0].status, 'archived', 'status unchanged after failed restore');
});

test('oversize encoded files are refused before any repository is created', async () => {
  const { service, repos } = setup({ maxFile: 50 * KB });
  await assert.rejects(service.upload({ virtualPath: 'big.bin', data: blob(100) }), (e) => (e as StorageError).code === 'REQUIRES_CHUNKING');
  assert.equal(repos.list().length, 0);
});

test('dashboard separates current tree, retained history and compression', async () => {
  const { service } = setup({ target: 500 * KB });
  const compressible = Buffer.alloc(200 * KB, 1);
  await service.upload({ virtualPath: 'doc.txt', data: compressible });
  await service.upload({ virtualPath: 'raw.bin', data: blob(100) });
  await service.archive('raw.bin');
  const d = await service.dashboard();
  assert.equal(d.tree.files, 1);
  assert.equal(d.tree.logicalBytes, 200 * KB);
  assert.equal(d.historical.archivedFiles, 1);
  assert.equal(d.historical.archivedOriginalBytes, 100 * KB);
  assert.ok(d.historical.inferredRetainedBytes > 100 * KB, 'archived blob still counted');
  assert.ok(d.historical.measuredObjectBytes! >= 100 * KB);
  assert.ok(d.compression.ratio > 0.3 && d.compression.parwBytes < d.compression.originalBytes);
  assert.ok(d.tree.currentRepoBytes < d.historical.measuredObjectBytes!);
  assert.match(d.notes.join(' '), /does NOT remove the original blob/);
});

test('GitHub factory creates PRIVATE repos and adopts existing ones', async () => {
  const calls: { method: string; url: string; body: any }[] = [];
  let exists = false;
  const client = new GitHubClient({
    getToken: () => 't',
    fetch: async (url, init) => {
      calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (init?.method === 'POST') return exists ? new Response('{"message":"name already exists"}', { status: 422 }) : new Response('{}', { status: 201 });
      return new Response('{}', { status: 200 });
    },
  });
  const f = new GitHubProviderFactory({ client, owner: 'me' });
  assert.deepEqual(await f.createRepository('repo-02'), { owner: 'me', repository: 'mycloud-02' });
  assert.equal(calls[0].body.private, true);
  exists = true;
  assert.deepEqual(await f.createRepository('repo-02'), { owner: 'me', repository: 'mycloud-02' });
  assert.match(calls[2].url, /\/repos\/me\/mycloud-02$/, 'adopts instead of failing');
});
