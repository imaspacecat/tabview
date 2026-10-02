import { validateBindings } from './keybindings';
import { RecoveryService } from './recovery';
import { DEFAULT_PREFERENCES } from './types';
import type { Preferences, RecoveryBatch, Request, Response, Snapshot, TabRecord } from './types';

const METADATA = 'tabview.metadata.v1';
const RECOVERY = 'tabview.recovery.v1';
const PREFERENCES = 'tabview.preferences.v1';
const dashboardUrl = browser.runtime.getURL('index.html');
interface Metadata { key: string; openedAt?: number }
const metadata = new Map<number, Promise<Metadata>>();

function isManaged(tab: browser.tabs.Tab): tab is browser.tabs.Tab & { id: number; windowId: number } {
  return tab.id !== undefined && tab.windowId !== undefined && !tab.incognito && !tab.url?.startsWith(dashboardUrl);
}

async function getMetadata(id: number, created = false): Promise<Metadata> {
  const known = metadata.get(id);
  if (known) return known;
  const promise = (async () => {
    let saved: Metadata | undefined;
    try { saved = await browser.sessions.getTabValue(id, METADATA) as Metadata | undefined; } catch {}
    const value: Metadata = saved?.key ? saved : { key: crypto.randomUUID(), ...(created ? { openedAt: Date.now() } : {}) };
    try { await browser.sessions.setTabValue(id, METADATA, value); } catch {}
    return value;
  })().catch(error => { metadata.delete(id); throw error; });
  metadata.set(id, promise);
  return promise;
}

async function record(tab: browser.tabs.Tab): Promise<TabRecord> {
  if (!isManaged(tab)) throw new Error('This tab is outside the dashboard scope.');
  const value = await getMetadata(tab.id);
  return {
    id: tab.id, key: value.key, windowId: tab.windowId, index: tab.index,
    title: tab.title ?? tab.url ?? 'Untitled', url: tab.url ?? '',
    openedAt: value.openedAt, lastAccessed: tab.lastAccessed,
    pinned: tab.pinned, audible: tab.audible ?? false, hidden: tab.hidden ?? false,
    discarded: tab.discarded ?? false, cookieStoreId: tab.cookieStoreId, favIconUrl: tab.favIconUrl,
  };
}

async function listTabs(): Promise<TabRecord[]> {
  const tabs = (await browser.tabs.query({})).filter(isManaged);
  const records = await Promise.allSettled(tabs.map(record));
  return records.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
}

const recovery = new RecoveryService({
  list: listTabs,
  get: async id => record(await browser.tabs.get(id)),
  remove: id => browser.tabs.remove(id),
  load: async () => (await browser.storage.local.get(RECOVERY))[RECOVERY] ?? [] as RecoveryBatch[],
  save: batches => browser.storage.local.set({ [RECOVERY]: batches }),
  reopen: async (tab, fallbackWindowId) => {
    let windowId = fallbackWindowId;
    try { await browser.windows.get(tab.windowId); windowId = tab.windowId; } catch {}
    const container = tab.cookieStoreId && tab.cookieStoreId !== 'firefox-default' ? tab.cookieStoreId : undefined;
    if (container && !await browser.permissions.contains({ permissions: ['cookies'] })) {
      throw new Error('Container permission is needed to reopen this tab in its original container.');
    }
    const lazy = /^https?:/i.test(tab.url) && !tab.pinned;
    const created = await browser.tabs.create({
      windowId, url: tab.url, active: false, pinned: tab.pinned,
      ...(container ? { cookieStoreId: container } : {}),
      ...(lazy ? { discarded: true, title: tab.title } : {}),
    });
    if (created.id === undefined) throw new Error('The browser did not return a tab ID.');
    return created.id;
  },
});

let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => {});
  return next;
}
browser.tabs.onCreated.addListener(tab => {
  if (isManaged(tab)) void getMetadata(tab.id, true).then(changed).catch(console.error);
  else changed();
});
browser.tabs.onRemoved.addListener(id => { metadata.delete(id); changed(); });
for (const event of [browser.tabs.onUpdated, browser.tabs.onActivated, browser.tabs.onMoved, browser.tabs.onAttached, browser.tabs.onDetached, browser.permissions.onAdded, browser.permissions.onRemoved]) event.addListener(changed);
browser.storage.onChanged.addListener((changes, area) => { if (area === 'local' && PREFERENCES in changes) changed(); });
const ports = new Set<browser.runtime.Port>();
let changeTimer: ReturnType<typeof setTimeout> | undefined;
function changed(): void {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    for (const port of ports) { try { port.postMessage({ type: 'changed' }); } catch { ports.delete(port); } }
  }, 100);
}
browser.runtime.onConnect.addListener(port => {
  if (port.name !== 'tabview') return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
});

const ready = (async () => {
  await listTabs();
  await recovery.reconcile();
})();
void ready.catch(console.error);

async function openDashboard(): Promise<void> {
  const tabs = await browser.tabs.query({});
  const existing = tabs.find(tab => !tab.incognito && tab.url === dashboardUrl);
  if (existing?.id !== undefined && existing.windowId !== undefined) {
    await browser.tabs.update(existing.id, { active: true });
    await browser.windows.update(existing.windowId, { focused: true });
  } else await browser.tabs.create({ url: dashboardUrl });
}
browser.action.onClicked.addListener(() => { void openDashboard().catch(console.error); });
browser.commands.onCommand.addListener(command => { if (command === 'open-dashboard') void openDashboard().catch(console.error); });

function validatePreferences(value: Preferences): Preferences {
  if (!['none', 'domain', 'opened', 'accessed', 'topic'].includes(value.group) || !Array.isArray(value.topics)) throw new Error('Invalid settings.');
  if (value.sort !== undefined && !['recent', 'loaded', 'unloaded'].includes(value.sort)) throw new Error('Invalid sort.');
  if (value.layout !== undefined && !['grid', 'list'].includes(value.layout)) throw new Error('Invalid layout.');
  if (value.topics.some(rule => typeof rule.name !== 'string' || !rule.name.trim() || !Array.isArray(rule.keywords) || !rule.keywords.length || rule.keywords.some(word => typeof word !== 'string' || !word.trim()))) throw new Error('Invalid topic rule.');
  return { ...value, keybindings: validateBindings(value.keybindings) };
}

async function handle(request: Request): Promise<unknown> {
  await ready;
  switch (request.type) {
    case 'snapshot': return {
      tabs: await listTabs(),
      preferences: (await browser.storage.local.get(PREFERENCES))[PREFERENCES] ?? DEFAULT_PREFERENCES,
      containers: await browser.permissions.contains({ permissions: ['cookies'] }),
    } satisfies Snapshot;
    case 'activate': {
      const tab = await browser.tabs.get(request.id);
      if (!isManaged(tab)) throw new Error('This tab is no longer available.');
      await browser.tabs.update(request.id, { active: true });
      await browser.windows.update(tab.windowId, { focused: true });
      return null;
    }
    case 'preferences': return serialize(async () => {
      await browser.storage.local.set({ [PREFERENCES]: validatePreferences(request.preferences) });
      return null;
    });
    case 'close': return serialize(() => recovery.close(request.targets, request.includePinned, request.includeAudible));
    case 'recovery': return serialize(() => recovery.reconcile().then(async () => (await browser.storage.local.get(RECOVERY))[RECOVERY] ?? []));
    case 'restore': return serialize(() => recovery.restore(request.id, request.windowId));
    case 'delete-batch': return serialize(() => recovery.delete(request.id));
    default: throw new Error('Unknown request.');
  }
}

browser.runtime.onMessage.addListener((request: Request, sender) => {
  if (sender.id !== browser.runtime.id || sender.url?.split('?')[0] !== dashboardUrl) return;
  return handle(request).then(value => ({ ok: true, value }) satisfies Response<unknown>, error => ({ ok: false, error: error instanceof Error ? error.message : String(error) }) satisfies Response<unknown>);
});
