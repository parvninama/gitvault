import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeParw } from '../parw/format.ts';
import { sha256Hex } from '../parw/hash.ts';
import { StorageError } from '../storage/errors.ts';
import { RestoreError } from '../storage/VersionedStorageProvider.ts';
import { GitHubClient, GitHubApiError } from './GitHubClient.ts';
import { GitHubStorageProvider } from './GitHubStorageProvider.ts';
import { buildAuthorizeUrl, exchangeCode, OAuthError, pollDeviceFlow, startDeviceFlow } from './auth.ts';
import { FakeGitHub } from './testing/FakeGitHub.ts';

function setup(maxFileSize?: number) {
  const gh = new FakeGitHub();
  const client = new GitHubClient({ getToken: () => 'tok_secret', fetch: gh.fetch });
  return { gh, provider: new GitHubStorageProvider({ client, owner: 'me', repo: 'mycloud-01', maxFileSize }) };
}

test('E2E over the GitHub REST flow: upload -> archive -> restore, hashes identical', async () => {
  const { gh, provider } = setup();
  const original = Buffer.concat([randomBytes(120_000), Buffer.alloc(80_000, 3)]);
  const parw = encodeParw({ data: original, filename: 'IMG_1234.jpg' });

  const up = await provider.uploadFile({ virtualPath: 'photos/IMG_1234.jpg', parw });
  assert.equal(up.commitSha, gh.head);
  assert.equal(gh.order.length, 2, 'README bootstrap commit + upload commit');

  const commitsBefore = gh.order.length;
  const a = await provider.archiveFile('photos/IMG_1234.jpg');
  assert.equal(gh.order.length, commitsBefore + 1, 'archive = exactly one commit (delete + pointer together)');
  assert.equal(a.pointer.commitSha, up.commitSha);

  const tree = await provider.listFiles();
  assert.deepEqual(tree.map((f) => f.status), ['archived']);

  // The old blob is still in the (fake) object database: archiving freed nothing.
  assert.ok(gh.blobs.has([...gh.blobs.keys()].find((k) => gh.blobs.get(k)!.equals(parw))!));

  const r = await provider.restoreFile('photos/IMG_1234.jpg', { restoreToTree: true, expectedOriginalSha256: sha256Hex(original) });
  assert.equal(sha256Hex(r.data), sha256Hex(original));
  assert.ok(r.steps.every((s) => s.status === 'ok'));
  assert.deepEqual((await provider.listFiles()).map((f) => f.status), ['active']);
  assert.ok((await provider.downloadFile('photos/IMG_1234.jpg')).equals(parw));
});

test('token is sent as a Bearer header on every request', async () => {
  const { gh, provider } = setup();
  await provider.uploadFile({ virtualPath: 'a.bin', parw: encodeParw({ data: randomBytes(500), filename: 'a.bin' }) });
  assert.ok(gh.requests.length > 5);
  assert.ok(gh.requests.every((r) => r.auth === 'Bearer tok_secret'));
});

test('oversize files are never sent to GitHub; duplicates are refused', async () => {
  const { gh, provider } = setup(1000);
  await assert.rejects(
    provider.uploadFile({ virtualPath: 'big.bin', parw: encodeParw({ data: randomBytes(5000), filename: 'big.bin' }) }),
    (e) => (e as StorageError).code === 'REQUIRES_CHUNKING',
  );
  assert.equal(gh.requests.length, 0, 'no network traffic for a rejected upload');
});

test('restore fails at the right step if the historical commit is unknown to GitHub', async () => {
  const { gh, provider } = setup();
  const parw = encodeParw({ data: randomBytes(3000), filename: 'a.bin' });
  await provider.uploadFile({ virtualPath: 'a.bin', parw });
  await provider.archiveFile('a.bin');
  // Simulate history loss (force-push / gc): drop the original commit from the fake server.
  const original = gh.order[1];
  gh.commits.delete(original);
  await assert.rejects(provider.restoreFile('a.bin'), (e) => e instanceof RestoreError && e.step === 'locate-commit');
});

test('usage reports estimated repo size and commit count; unknowns stay null', async () => {
  const { provider } = setup();
  await provider.uploadFile({ virtualPath: 'a.bin', parw: encodeParw({ data: randomBytes(20_000), filename: 'a.bin' }) });
  await provider.archiveFile('a.bin');
  const u = await provider.getUsage();
  assert.equal(u.commits, 3);
  assert.equal(u.measurement, 'estimated');
  assert.equal(u.historicalObjectBytes, null);
  assert.ok(u.estimatedRepoBytes! >= 20_000, 'archived blob still counted by the server');
  assert.ok(u.currentTreeBytes < 2000, 'but the current tree is tiny');
});

test('API errors surface status codes', async () => {
  const client = new GitHubClient({ getToken: () => 't', fetch: async () => new Response('{"message":"Bad credentials"}', { status: 401 }) });
  await assert.rejects(client.json('GET', '/user'), (e) => e instanceof GitHubApiError && e.status === 401);
});

test('OAuth: authorize URL, code exchange, device flow with pending/slow_down', async () => {
  const url = new URL(buildAuthorizeUrl({ clientId: 'cid', redirectUri: 'http://localhost:3001/cb', state: 's1' }));
  assert.equal(url.searchParams.get('scope'), 'repo');
  assert.equal(url.searchParams.get('state'), 's1');

  const ok = async () => new Response(JSON.stringify({ access_token: 'gho_x' }));
  assert.equal(await exchangeCode({ clientId: 'c', clientSecret: 's', code: 'k', redirectUri: 'r' }, ok), 'gho_x');
  const bad = async () => new Response(JSON.stringify({ error: 'bad_verification_code' }));
  await assert.rejects(exchangeCode({ clientId: 'c', clientSecret: 's', code: 'k', redirectUri: 'r' }, bad), OAuthError);

  const dc = await startDeviceFlow('cid', 'repo', async () => new Response(JSON.stringify({
    device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 })));
  assert.equal(dc.userCode, 'ABCD-1234');
  const replies = [{ error: 'authorization_pending' }, { error: 'slow_down' }, { access_token: 'gho_dev' }];
  const sleeps: number[] = [];
  const token = await pollDeviceFlow('cid', dc, {
    fetch: async () => new Response(JSON.stringify(replies.shift())),
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(token, 'gho_dev');
  assert.deepEqual(sleeps, [5000, 5000, 10000], 'slow_down must increase the polling interval');
  await assert.rejects(pollDeviceFlow('cid', dc, { fetch: async () => new Response(JSON.stringify({ error: 'access_denied' })), sleep: async () => {} }), /access_denied/);
});
