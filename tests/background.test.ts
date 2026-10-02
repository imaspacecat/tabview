import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import type { Request, Response, Snapshot, TabRecord } from '../src/types';

function event() {
  const listeners: ((...args: any[]) => any)[] = [];
  return { addListener: (listener: (...args: any[]) => any) => listeners.push(listener), emit: (...args: any[]) => listeners.map(listener => listener(...args)) };
}

test('background reconciles browser state, survives a fresh process, and guards tab scope', async () => {
  const script = await readFile('dist/background.js', 'utf8');
  const url = 'moz-extension://test/index.html';
  const live = new Map<number, browser.tabs.Tab>();
  const sessionValues = new Map<number, unknown>();
  const storage: Record<string, unknown> = {};
  let cookies = false;
  let nextId = 10;
  function raw(id: number, changes: Partial<browser.tabs.Tab> = {}): browser.tabs.Tab {
    return { id, windowId: 1, index: id, title: `Tab ${id}`, url: `https://example.com/${id}`, active: false, highlighted: false, pinned: false, incognito: false, ...changes };
  }
  live.set(1, raw(1));
  live.set(2, raw(2));
  live.set(3, raw(3, { incognito: true }));
  live.set(4, raw(4, { url }));
  sessionValues.set(2, { key: 'restored-key', openedAt: 12345 });
  function boot() {
    const onMessage = event();
    const onCreated = event();
    const onRemoved = event();
    const onUpdated = event();
    const api = {
      tabs: {
        query: async () => [...live.values()].map(tab => ({ ...tab })),
        get: async (id: number) => { const tab = live.get(id); if (!tab) throw new Error('Tab not found'); return { ...tab }; },
        remove: async (id: number) => { live.delete(id); sessionValues.delete(id); onRemoved.emit(id); },
        update: async (id: number) => live.get(id),
        create: async (properties: browser.tabs._CreateCreateProperties) => {
          const created = raw(nextId++, properties);
          live.set(created.id!, created); onCreated.emit(created); return created;
        },
        onCreated, onRemoved, onUpdated, onActivated: event(), onMoved: event(), onAttached: event(), onDetached: event(),
      },
      sessions: { getTabValue: async (id: number) => sessionValues.get(id), setTabValue: async (id: number, _key: string, value: unknown) => { sessionValues.set(id, structuredClone(value)); } },
      storage: {
        local: { get: async (key: string) => ({ [key]: structuredClone(storage[key]) }), set: async (values: Record<string, unknown>) => { Object.assign(storage, structuredClone(values)); } },
        onChanged: event(),
      },
      permissions: { contains: async () => cookies, onAdded: event(), onRemoved: event() },
      windows: { get: async (id: number) => ({ id }), update: async () => ({}) },
      runtime: { id: 'tabview@spacecat.local', getURL: () => url, onMessage, onConnect: event() },
      action: { onClicked: event() }, commands: { onCommand: event() },
    };
    vm.runInNewContext(script, { browser: api, crypto, console, setTimeout: () => 0, clearTimeout: () => {} });
    return {
      api,
      async rpc<T>(message: Request): Promise<T> {
        const [result] = onMessage.emit(message, { id: api.runtime.id, url });
        const response = await result as Response<T>;
        if (!response.ok) throw new Error(response.error);
        return structuredClone(response.value);
      },
    };
  }
  let background = boot();
  const first = await background.rpc<Snapshot>({ type: 'snapshot' });
  assert.deepEqual(first.tabs.map(tab => tab.id), [1, 2]);
  assert.equal(first.tabs[0].openedAt, undefined, 'existing tabs must not get invented creation dates');
  assert.equal(first.tabs[1].openedAt, 12345);
  live.set(5, raw(5, { hidden: true, discarded: true }));
  background.api.tabs.onCreated.emit(live.get(5));
  const snapshot = await background.rpc<Snapshot>({ type: 'snapshot' });
  assert.ok(snapshot.tabs.find(tab => tab.id === 5)!.openedAt);
  assert.equal(snapshot.tabs.find(tab => tab.id === 5)!.hidden, true);
  const target = snapshot.tabs.find(tab => tab.id === 5)!;
  await background.rpc({ type: 'close', targets: [target], includePinned: false, includeAudible: false });
  assert.equal(live.has(5), false);
  await background.rpc({ type: 'close', targets: [{ id: 4, key: 'anything', url }], includePinned: true, includeAudible: true });
  assert.equal(live.has(4), true, 'dashboard cannot close itself');
  await assert.rejects(background.rpc({ type: 'activate', id: 3 }), /no longer available/);
  const firstKey = first.tabs[0].key;
  live.delete(1); live.delete(2);
  live.set(6, raw(6)); live.set(7, raw(7));
  sessionValues.set(6, sessionValues.get(1)); sessionValues.set(7, sessionValues.get(2));
  sessionValues.delete(1); sessionValues.delete(2);
  background = boot();
  const resumed = await background.rpc<Snapshot>({ type: 'snapshot' });
  assert.equal(resumed.tabs.find(tab => tab.id === 6)!.key, firstKey);
  assert.equal(resumed.tabs.find(tab => tab.id === 7)!.openedAt, 12345);
  cookies = true;
  live.set(8, raw(8, { cookieStoreId: 'firefox-container-1' }));
  background.api.tabs.onCreated.emit(live.get(8));
  const containerTab = (await background.rpc<Snapshot>({ type: 'snapshot' })).tabs.find(tab => tab.id === 8)!;
  await background.rpc({ type: 'close', targets: [containerTab], includePinned: false, includeAudible: false });
  cookies = false;
  const batches = await background.rpc<{ id: string }[]>({ type: 'recovery' });
  const result = await background.rpc<{ reopened: number; failed: number }>({ type: 'restore', id: batches[0].id, windowId: 1 });
  assert.equal(result.failed, 1);
  assert.equal(result.reopened, 0);
});
