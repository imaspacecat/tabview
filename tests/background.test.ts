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
      windows: { getAll: async () => [{ id: 1, type: 'normal', incognito: false }], get: async (id: number) => ({ id, type: 'normal', incognito: false }), update: async () => ({}) },
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

test('native grouping validates scope, moves across windows, unpins, names new groups, and reports naming failures', async () => {
  const script = await readFile('dist/background.js', 'utf8');
  const url = 'moz-extension://test/index.html';
  const live = new Map<number, browser.tabs.Tab & { groupId?: number }>();
  const groups = new Map([[10, { id: 10, title: 'Work', color: 'blue', windowId: 2 }]]);
  const calls: { tabIds: number[]; groupId?: number; createProperties?: { windowId: number } }[] = [];
  const onMessage = event();
  const session = new Map<number, unknown>();
  let namingFails = false;
  for (let id = 1; id <= 4; id++) live.set(id, { id, windowId: id === 2 ? 2 : 1, index: id, title: `Tab ${id}`, url: id === 4 ? url : `https://example.com/${id}`, pinned: id === 2, active: false, highlighted: false, incognito: id === 3 });
  const api = {
    tabs: {
      query: async () => [...live.values()],
      get: async (id: number) => { const tab = live.get(id); if (!tab) throw new Error('Missing tab'); return { ...tab }; },
      group: async (options: typeof calls[number]) => {
        calls.push(structuredClone(options));
        const groupId = options.groupId ?? 20;
        if (!options.groupId) groups.set(groupId, { id: groupId, title: '', color: 'grey', windowId: options.createProperties!.windowId });
        for (const id of options.tabIds) Object.assign(live.get(id)!, { groupId, pinned: false, windowId: groups.get(groupId)!.windowId });
        return groupId;
      },
      onCreated: event(), onRemoved: event(), onUpdated: event(), onActivated: event(), onMoved: event(), onAttached: event(), onDetached: event(),
    },
    tabGroups: {
      query: async () => [...groups.values()],
      get: async (id: number) => { const group = groups.get(id); if (!group) throw new Error('Missing group'); return { ...group }; },
      update: async (id: number, properties: { title: string }) => { if (namingFails) throw new Error('Cannot name group'); Object.assign(groups.get(id)!, properties); return groups.get(id)!; },
      onCreated: event(), onUpdated: event(), onRemoved: event(), onMoved: event(),
    },
    sessions: { getTabValue: async (id: number) => session.get(id), setTabValue: async (id: number, _key: string, value: unknown) => { session.set(id, value); } },
    storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: event() },
    permissions: { contains: async () => false, onAdded: event(), onRemoved: event() },
    windows: {
      getAll: async () => [{ id: 1, type: 'normal', incognito: false }, { id: 2, type: 'normal', incognito: false }],
      get: async (id: number) => { if (![1, 2, 3].includes(id)) throw new Error('Missing window'); return { id, type: 'normal', incognito: id === 3 }; },
    },
    runtime: { id: 'extension', getURL: () => url, onMessage, onConnect: event() },
    action: { onClicked: event() }, commands: { onCommand: event() },
  };
  vm.runInNewContext(script, { browser: api, crypto, console, setTimeout: () => 0, clearTimeout: () => {} });
  async function rpc<T>(message: Request): Promise<T> {
    const [result] = onMessage.emit(message, { id: api.runtime.id, url });
    const response = await result as Response<T>;
    if (!response.ok) throw new Error(response.error);
    return structuredClone(response.value);
  }
  const snapshot = await rpc<Snapshot>({ type: 'snapshot' });
  assert.equal(snapshot.groupingAvailable, true);
  assert.equal(snapshot.browserGroups![0].title, 'Work');
  const targets = snapshot.tabs.map(({ id, key, url }) => ({ id, key, url }));
  const request: Request = { type: 'group-tabs', targets, destination: { groupId: 10 } };
  live.get(1)!.url = 'https://changed.test';
  await assert.rejects(rpc(request), /Selected tabs changed/);
  assert.equal(calls.length, 0);
  live.get(1)!.url = targets[0].url;
  for (const id of [3, 4]) await assert.rejects(rpc({ ...request, targets: [{ id, key: 'bad', url: live.get(id)!.url! }] }), /outside the dashboard scope/);
  await assert.rejects(rpc({ ...request, destination: { groupId: 999 } }), /Missing group/);
  await assert.rejects(rpc({ ...request, destination: { name: 'Work', windowId: 3 } }), /regular browser window/);
  await assert.rejects(rpc({ ...request, destination: { name: ' ', windowId: 1 } }), /enter a new group name/);
  assert.equal(calls.length, 0);
  const result = await rpc<{ grouped: number }>(request);
  assert.equal(result.grouped, 2);
  assert.equal(live.get(1)!.windowId, 2);
  assert.equal(live.get(2)!.pinned, false);
  assert.equal((await rpc<Snapshot>({ type: 'snapshot' })).tabs[0].groupId, 10);
  await rpc({ ...request, destination: { name: ' Research ', windowId: 1 } });
  assert.equal(groups.get(20)!.title, 'Research');
  assert.deepEqual(calls.at(-1)!.createProperties, { windowId: 1 });
  namingFails = true;
  const partial = await rpc<{ warning: string }>({ ...request, destination: { name: 'Other', windowId: 2 } });
  assert.match(partial.warning, /grouped.*could not be named/);
  const originalQuery = api.tabGroups.query;
  api.tabGroups.query = async () => { throw new Error('Grouping disabled'); };
  const unavailable = await rpc<Snapshot>({ type: 'snapshot' });
  assert.equal(unavailable.groupingAvailable, false);
  assert.equal(unavailable.tabs.length, 2, 'unavailable group queries do not break tab listing');
  api.tabGroups.query = originalQuery;
  const originalGroup = api.tabs.group;
  Object.assign(api.tabs, { group: undefined });
  assert.equal((await rpc<Snapshot>({ type: 'snapshot' })).groupingAvailable, false);
  await assert.rejects(rpc(request), /unavailable/);
  Object.assign(api.tabs, { group: originalGroup });
  live.delete(1);
  await assert.rejects(rpc(request), /Missing tab/);
});
