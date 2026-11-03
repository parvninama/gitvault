import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPointer, parsePointer, pointerPathFor } from './pointer.ts';

const good = { originalPath: 'photos/IMG_1234.jpg.parw', commitSha: 'a'.repeat(40), sha256: 'b'.repeat(64), size: 5827291 };

test('creates and parses a pointer', () => {
  const { pointer, bytes } = createPointer(good);
  assert.deepEqual(parsePointer(bytes), pointer);
  assert.equal(pointer.format, 'parw-pointer');
  assert.ok(bytes.length < 400, 'pointer must stay tiny');
  assert.equal(pointerPathFor(good.originalPath), 'photos/IMG_1234.jpg.parw.pointer');
});

test('rejects malformed or hostile pointers', () => {
  const mk = (o: object) => Buffer.from(JSON.stringify({ format: 'parw-pointer', version: 1, ...good, ...o }));
  assert.throws(() => parsePointer(Buffer.from('nope')));
  assert.throws(() => parsePointer(mk({ format: 'other' })));
  assert.throws(() => parsePointer(mk({ version: 2 })));
  assert.throws(() => parsePointer(mk({ originalPath: '../../etc/passwd.parw' })));
  assert.throws(() => parsePointer(mk({ originalPath: '/abs.parw' })));
  assert.throws(() => parsePointer(mk({ originalPath: 'a.txt' })));
  assert.throws(() => parsePointer(mk({ sha256: 'xyz' })));
  assert.throws(() => parsePointer(mk({ commitSha: 'not-hex' })));
  assert.throws(() => parsePointer(mk({ size: -1 })));
  assert.throws(() => createPointer({ ...good, size: 1.5 }));
});
