import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubClient } from '../github/GitHubClient.ts';
import { GitHubStorageProvider } from '../github/GitHubStorageProvider.ts';
import { FakeGitHub } from '../github/testing/FakeGitHub.ts';
import { LocalStorageProvider } from '../storage/LocalStorageProvider.ts';
import { formatReport, runExperiment } from './gitHistoryExperiment.ts';

test('experiment on local backend: all verified, history retained, report is honest', async () => {
  const p = new LocalStorageProvider(mkdtempSync(join(tmpdir(), 'gv-')));
  const r = await runExperiment(p, { sizes: [100_000, 300_000], runId: 't' });
  assert.ok(r.files.every((f) => f.verified && !f.error));
  const f = r.files[1];
  const up = f.snapshots.afterUpload.usage, ar = f.snapshots.afterArchive.usage;
  assert.ok(up.currentTreeBytes - ar.currentTreeBytes > f.parwSize - 1000, 'tree drops by ~the PARW size (pointer is tiny)');
  assert.ok(ar.historicalObjectBytes! >= up.historicalObjectBytes!, 'history never shrinks');
  // restoring into the tree re-adds identical bytes => deduplicated, no new historical bytes beyond the pointer-free blob
  assert.equal(f.snapshots.afterRestoreToTree.usage.binaryObjects, ar.binaryObjects);
  const report = formatReport(r, { backend: 'local' });
  assert.match(report, /did NOT reduce the repository footprint/);
  assert.match(report, /LOCAL SIMULATION/);
  assert.match(report, /PASS/);
});

test('experiment over the GitHub provider (fake server) shows no reclaim either', async () => {
  const gh = new FakeGitHub();
  const p = new GitHubStorageProvider({ client: new GitHubClient({ getToken: () => 't', fetch: gh.fetch }), owner: 'me', repo: 'mycloud-01' });
  const r = await runExperiment(p, { sizes: [200_000, 400_000], runId: 'g' });
  assert.ok(r.files.every((f) => f.verified));
  const report = formatReport(r, { backend: 'github' });
  assert.match(report, /did NOT reduce/);
  assert.match(report, /n\/a/); // historical bytes unknown through the REST API
  assert.ok(gh.uniqueBlobBytes() >= 600_000);
});
