import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecoveryService, type RecoveryGateway } from '../src/recovery';
import type { RecoveryBatch, TabRecord } from '../src/types';
import { tab } from './helpers';

function harness(tabs: TabRecord[]) {
  const live = new Map(tabs.map(tab => [tab.id, tab]));
  let stored: RecoveryBatch[] = [];
  let saveCount = 0;
  let failSave = 0;
  let failRemove = 0;
  let failReopen = false;
  const removed: number[] = [];
  const reopened: number[] = [];
  const gateway: RecoveryGateway = {
    list: async () => [...live.values()],
    get: async id => { const tab = live.get(id); if (!tab) throw new Error('No tab'); return { ...tab }; },
    remove: async id => {
      assert.ok(stored.some(batch => batch.entries.some(entry => entry.tab.id === id && entry.status === 'pending')), 'journal must precede close');
      if (id === failRemove) throw new Error('Browser refused to close');
      removed.push(id); live.delete(id);
    },
    reopen: async tab => { if (failReopen) throw new Error('Container unavailable'); reopened.push(tab.id); return 100 + tab.id; },
    load: async () => structuredClone(stored),
    save: async batches => {
      if (++saveCount === failSave) throw new Error('Disk full');
      stored = structuredClone(batches);
    },
  };
  return {
    service: new RecoveryService(gateway), gateway, live, removed, reopened,
    stored: () => stored,
    failSaveAt: (count: number) => { failSave = count; },
    failRemoveAt: (id: number) => { failRemove = id; },
    failReopening: () => { failReopen = true; },
  };
}
const targets = (tabs: TabRecord[]) => tabs.map(({ id, key, url }) => ({ id, key, url }));

test('initial recovery write failure keeps every tab open', async () => {
  const h = harness([tab(1), tab(2)]); h.failSaveAt(1);
  await assert.rejects(h.service.close(targets([...h.live.values()]), false, false), /Disk full/);
  assert.deepEqual(h.removed, []);
});

test('close skips pinned/audio, changed URLs, stale IDs, and duplicates', async () => {
  const records = [tab(1), tab(2, { pinned: true }), tab(3, { audible: true }), tab(4)];
  const h = harness(records);
  const preview = targets(records);
  h.live.set(4, tab(4, { url: 'https://changed.example' }));
  preview.push(preview[0], { id: 9, key: 'stale', url: 'https://example.com' });
  assert.deepEqual(await h.service.close(preview, false, false), { closed: 1, skipped: 4, failed: 0, interrupted: false });
  assert.deepEqual(h.removed, [1]);
  assert.equal(h.stored()[0].entries[0].status, 'closed');
});

test('identity keys protect against tab ID reuse', async () => {
  const h = harness([tab(1, { key: 'new-key' })]);
  assert.equal((await h.service.close(targets([tab(1)]), true, true)).skipped, 1);
  assert.equal(h.stored().length, 0);
});

test('live change after preflight keeps tab open', async () => {
  const h = harness([tab(1)]);
  const save = h.gateway.save;
  h.gateway.save = async batches => { await save(batches); h.live.set(1, tab(1, { audible: true })); };
  const result = await h.service.close(targets([tab(1)]), false, false);
  assert.equal(result.skipped, 1);
  assert.deepEqual(h.removed, []);
});

test('partial browser failure is recorded without losing other tabs', async () => {
  const h = harness([tab(1), tab(2), tab(3)]); h.failRemoveAt(2);
  assert.deepEqual(await h.service.close(targets([...h.live.values()]), false, false), { closed: 2, skipped: 0, failed: 1, interrupted: false });
  assert.deepEqual(h.stored()[0].entries.map(entry => entry.status), ['closed', 'failed', 'closed']);
  await h.service.restore(h.stored()[0].id, 1);
  assert.deepEqual(h.reopened, [1, 3]);
  await h.service.restore(h.stored()[0].id, 1);
  assert.deepEqual(h.reopened, [1, 3], 'repeating restore must not duplicate reopened tabs');
});

test('progress write failure stops closing and reconciliation flags ambiguous outcomes', async () => {
  const h = harness([tab(1), tab(2)]); h.failSaveAt(2);
  assert.equal((await h.service.close(targets([...h.live.values()]), false, false)).interrupted, true);
  assert.deepEqual(h.removed, [1]);
  await h.service.reconcile();
  assert.deepEqual(h.stored()[0].entries.map(entry => entry.status), ['uncertain', 'failed']);
});

test('interrupted reopen is not silently retried', async () => {
  const h = harness([tab(1), tab(2)]);
  await h.service.close(targets([...h.live.values()]), false, false);
  h.failSaveAt(5);
  await assert.rejects(h.service.restore(h.stored()[0].id, 1), /Disk full/);
  await h.service.reconcile();
  assert.equal(h.stored()[0].entries[0].status, 'reopen-uncertain');
  await h.service.restore(h.stored()[0].id, 1);
  assert.deepEqual(h.reopened, [1, 2]);
});

test('failed reopening retains retryable entries and their error details', async () => {
  const h = harness([tab(1)]);
  await h.service.close(targets([...h.live.values()]), false, false);
  h.failReopening();
  assert.deepEqual(await h.service.restore(h.stored()[0].id, 1), { reopened: 0, failed: 1 });
  assert.equal(h.stored()[0].entries[0].status, 'closed');
  assert.match(h.stored()[0].entries[0].error!, /Container unavailable/);
});

test('journal retains only 20 batches and supports deletion', async () => {
  const h = harness([]);
  for (let id = 1; id <= 21; id++) { h.live.set(id, tab(id)); await h.service.close(targets([tab(id)]), false, false); }
  assert.equal(h.stored().length, 20);
  assert.equal(h.stored()[19].entries[0].tab.id, 2);
  await h.service.delete(h.stored()[0].id);
  assert.equal(h.stored().length, 19);
});
