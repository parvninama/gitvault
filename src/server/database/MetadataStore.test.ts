import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compressionRatio, MetadataStore } from './MetadataStore.ts';

const rec = (name: string, original: number, parw: number) => ({
  virtualPath: `photos/${name}`, name, repoId: 'repo-1', backendPath: `photos/${name}.parw`, status: 'active' as const,
  mimeType: 'image/jpeg', originalSize: original, parwSize: parw, originalSha256: 'a'.repeat(64),
  parwSha256: 'b'.repeat(64), uploadCommitSha: 'c'.repeat(40),
});

test('files: insert, archive, restore and summary', () => {
  const db = new MetadataStore(':memory:');
  db.insertFile(rec('IMG_001.jpg', 5200, 4700));
  db.insertFile(rec('IMG_002.jpg', 7100, 7000));
  assert.throws(() => db.insertFile(rec('IMG_001.jpg', 1, 1)), 'virtual path is unique');

  db.markArchived('photos/IMG_002.jpg', { pointerCommitSha: 'p'.repeat(40), archivedFromCommitSha: 'c'.repeat(40), pointerBytes: 280 });
  const s = db.summary();
  assert.deepEqual([s.activeFiles, s.archivedFiles, s.activeOriginalBytes, s.archivedOriginalBytes], [1, 1, 5200, 7100]);
  assert.equal(s.totalParwBytes, 11700);
  assert.equal(db.listFiles('archived')[0].archivedFromCommitSha, 'c'.repeat(40));
  assert.throws(() => db.markArchived('photos/IMG_002.jpg', { pointerCommitSha: 'x', archivedFromCommitSha: 'y', pointerBytes: 1 }));

  db.markRestored('photos/IMG_002.jpg', false);
  assert.equal(db.getFile('photos/IMG_002.jpg')!.status, 'archived');
  db.markRestored('photos/IMG_002.jpg', true);
  const back = db.getFile('photos/IMG_002.jpg')!;
  assert.equal(back.status, 'active');
  assert.equal(back.pointerCommitSha, null);
  assert.ok(back.restoredAt);
});

test('repositories upsert and compression ratio', () => {
  const db = new MetadataStore(':memory:');
  const r = { repoId: 'repo-1', owner: 'me', repository: 'mycloud-01', logicalVolume: 'default',
    approximateCurrentSize: 1, approximateHistoricalSize: 2, status: 'active' as const };
  db.upsertRepository(r);
  db.upsertRepository({ ...r, approximateHistoricalSize: 99, status: 'full' });
  assert.deepEqual(db.listRepositories(), [{ ...r, approximateHistoricalSize: 99, status: 'full' }]);
  assert.ok(Math.abs(compressionRatio(5200, 4700) - 0.0962) < 0.001);
  assert.equal(compressionRatio(0, 40), 0);
});
