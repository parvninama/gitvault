// Browser end-to-end proof of the LOCAL workflow. Starts the real server, drives Chromium with Playwright.
// Run: npm run e2e   (needs `npm run client:build` first and `npx playwright install chromium`)
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const PORT = 3111, BASE = `http://127.0.0.1:${PORT}`;
const work = mkdtempSync(join(tmpdir(), 'gv-e2e-'));
const dataDir = join(work, 'data'), shots = process.env.SHOTS_DIR ?? join(work, 'shots');
mkdirSync(shots, { recursive: true });

// local test files
const files = {
  'notes.txt': Buffer.from('The quick brown fox. '.repeat(20000)),            // compressible
  'IMG_001.bin': Buffer.concat([randomBytes(300_000), Buffer.alloc(200_000, 5)]),  // partly compressible
  'tiny.dat': randomBytes(2000),
};
const srcDir = join(work, 'src-files'); mkdirSync(srcDir);
for (const [n, b] of Object.entries(files)) writeFileSync(join(srcDir, n), b);

const server = spawn('node', ['--disable-warning=ExperimentalWarning', 'src/server/index.ts'], {
  env: { ...process.env, PORT: String(PORT), DATABASE_PATH: join(dataDir, 'gitvault.sqlite'), STORAGE_BACKEND: 'local',
    TARGET_REPOSITORY_SIZE: String(2 * 1024 * 1024), MAX_REPOSITORIES: '3' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((res, rej) => {
  server.stdout.on('data', (d) => { process.stdout.write(`[server] ${d}`); if (String(d).includes('gitvault-poc on')) res(); });
  server.on('exit', (c) => rej(new Error('server exited ' + c)));
  setTimeout(() => rej(new Error('server start timeout')), 15000);
});

const step = (m) => console.log(`\n== ${m}`);
const browser = await chromium.launch();
const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const shot = (n) => page.screenshot({ path: join(shots, n + '.png'), fullPage: true });
let ok = false;

try {
  step('dashboard loads in local mode');
  await page.goto(BASE);
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  await page.getByText('Local mode: repositories are simulated').waitFor();

  step('upload: preview three files, then Upload All');
  await page.getByRole('link', { name: 'Upload', exact: true }).click();
  await page.getByTestId('file-input').setInputFiles(Object.keys(files).map((n) => join(srcDir, n)));
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=upload-row][data-state=ready]').length === 3);
  const txtRow = page.getByTestId('upload-row').filter({ hasText: 'notes.txt' });
  assert.match(await txtRow.innerText(), /smaller/, 'compressible file shows savings in preview');
  assert.match(await txtRow.innerText(), /new repository will be created/);
  await shot('1-upload-preview');
  await page.getByRole('button', { name: /Upload All/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=upload-row][data-state=done]').length === 3, null, { timeout: 20000 });
  await shot('2-upload-done');
  for (const [n, b] of Object.entries(files)) assert.ok(readFileSync(join(srcDir, n)).equals(b), 'local original untouched');

  step('files: virtual tree, details, download is byte-identical');
  await page.getByRole('link', { name: 'Files', exact: true }).click();
  await page.getByRole('heading', { name: 'Files' }).waitFor();
  await page.getByTestId('file-row').first().waitFor();
  assert.equal(await page.getByTestId('file-row').count(), 3);
  const row = (n) => page.locator(`[data-testid=file-row][data-path="uploads/${n}"]`);
  await row('IMG_001.bin').getByRole('button', { name: /IMG_001/ }).click();
  const details = await page.locator('tr.details').innerText();
  assert.ok(details.includes(sha(files['IMG_001.bin'])), 'checksum shown');
  assert.match(details, /local\/mycloud-0\d/, 'repository shown only in details');
  const [dl] = await Promise.all([page.waitForEvent('download'), row('notes.txt').getByText('Download').click()]);
  assert.equal(sha(readFileSync(await dl.path())), sha(files['notes.txt']));
  await shot('3-files');

  step('archive IMG_001.bin (with the warning dialog)');
  let dialogText = '';
  page.once('dialog', (d) => { dialogText = d.message(); d.accept(); });
  await row('IMG_001.bin').getByRole('button', { name: 'Archive' }).click();
  await row('IMG_001.bin').getByText('Archived').waitFor();
  assert.match(dialogText, /does not necessarily remove the historical Git object/);
  assert.equal(await row('IMG_001.bin').getByText('Download').count(), 0);
  await shot('4-archived-in-tree');

  step('archived page lists it; restore with live step display');
  await page.getByRole('link', { name: 'Archived', exact: true }).click();
  const card = page.getByTestId('archived-card').filter({ hasText: 'IMG_001.bin' });
  await card.waitFor();
  assert.match(await card.innerText(), /pointer only/);
  await card.getByRole('button', { name: 'Restore' }).click();
  await page.getByLabel(/Also put the file back/).check();
  await page.getByLabel(/Slow motion/).check();
  await page.getByRole('button', { name: 'Start restore' }).click();
  await page.waitForSelector('[data-state=running]', { timeout: 5000 });   // a step is visibly "Running"
  await shot('5-restore-running');
  await page.getByText('Restored and verified').waitFor({ timeout: 15000 });
  const states = await page.locator('.step').evaluateAll((els) => els.map((e) => e.getAttribute('data-state')));
  assert.deepEqual(states, Array(8).fill('success'));
  await shot('6-restore-done');
  const restored = join(dataDir, 'restored', 'uploads', 'IMG_001.bin');
  assert.equal(sha(readFileSync(restored)), sha(files['IMG_001.bin']), 'reconstructed file is byte-identical');

  step('restore failure: corrupt the DB checksum, expect a stop at the exact step');
  await page.getByRole('link', { name: 'Files', exact: true }).click();
  await row('tiny.dat').waitFor();
  page.once('dialog', (d) => d.accept());
  await row('tiny.dat').getByRole('button', { name: 'Archive' }).click();
  await row('tiny.dat').getByText('Archived').waitFor();
  const db = new DatabaseSync(join(dataDir, 'gitvault.sqlite'));
  db.exec(`UPDATE files SET original_sha256='${'0'.repeat(64)}' WHERE virtual_path='uploads/tiny.dat'`); db.close();
  await row('tiny.dat').getByRole('button', { name: 'Restore' }).click();
  await page.getByRole('button', { name: 'Start restore' }).click();
  await page.getByRole('alert').filter({ hasText: 'Restore aborted' }).waitFor();
  const failStates = await page.locator('.step').evaluateAll((els) => els.map((e) => e.getAttribute('data-state')));
  assert.deepEqual(failStates, ['success', 'success', 'success', 'success', 'success', 'failed', 'aborted', 'skipped']);
  assert.match(await page.getByTestId('restore-panel').innerText(), /database expects 0{64}/);
  assert.equal(existsSync(join(dataDir, 'restored', 'uploads', 'tiny.dat')), false);
  await shot('7-restore-failed');

  step('experiment page: sandboxed run, tree vs history clearly separated');
  await page.getByRole('link', { name: 'Storage Experiment' }).click();
  await page.getByText('does not necessarily remove the historical Git object').first().waitFor();
  await page.getByLabel('5 MiB').uncheck();
  await page.getByRole('button', { name: 'Run experiment' }).click();
  await page.getByTestId('experiment-results').waitFor({ timeout: 30000 });
  const exp = await page.getByTestId('experiment-results').innerText();
  assert.match(exp, /CURRENT TREE/); assert.match(exp, /HISTORICAL GIT DATA/); assert.match(exp, /identical/); assert.match(exp, /measured \(sim\)/);
  await shot('8-experiment');

  step('dashboard, repositories, settings');
  await page.getByRole('link', { name: 'Dashboard' }).click();
  await page.getByText('Historical Git data').waitFor();
  assert.match(await page.locator('.cards').innerText(), /measured \(local simulation\)/);
  await shot('9-dashboard');
  await page.getByRole('link', { name: 'Repositories' }).click();
  await page.getByTestId('repo-row').first().waitFor();
  await page.getByTestId('repo-row').first().getByRole('button').click();
  await page.getByText('Binary objects').waitFor();
  await shot('10-repositories');
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByText('Local (simulated repositories)').waitFor();
  const settingsText = await page.locator('main').innerText();
  assert.ok(!/gho_|client_secret|token\s*[:=]/i.test(settingsText));
  await shot('11-settings');

  assert.deepEqual(errors, [], 'no browser console/page errors');
  ok = true;
  console.log(`\nALL BROWSER CHECKS PASSED. Screenshots: ${shots}`);
} catch (e) {
  await shot('FAILURE').catch(() => {});
  console.error('\nE2E FAILED:', e.message, '\nbrowser errors:', errors);
} finally {
  await browser.close(); server.kill();
  if (ok && !process.env.KEEP) rmSync(work, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}
