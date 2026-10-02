import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { tab } from './helpers';
import type { RecoveryBatch, Request, RestoreResult, Snapshot, TabRecord } from '../src/types';

async function dashboard(snapshot: Snapshot, batches: RecoveryBatch[] = [], restore: () => Promise<RestoreResult> = async () => ({ reopened: 0, failed: 0 })) {
  const html = await readFile('dist/index.html', 'utf8');
  const file = (await readdir('dist/assets')).find(file => file.endsWith('.js'))!;
  const script = await readFile(`dist/assets/${file}`, 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'moz-extension://test/index.html', pretendToBeVisual: true });
  const { window } = dom;
  const messages: Request[] = [];
  let shortcut = 'Ctrl+Alt+Y';
  let notify: () => void = () => {};
  Object.assign(window, { structuredClone, browser: {
    windows: { getCurrent: async () => ({ id: 1 }) },
    commands: {
      getAll: async () => [{ name: 'open-dashboard', shortcut }],
      update: async (value: { shortcut: string }) => { if (value.shortcut === 'invalid') throw new Error('Invalid shortcut'); shortcut = value.shortcut; },
      reset: async () => { shortcut = 'Ctrl+Alt+Y'; },
    },
    runtime: {
      getURL: (path: string) => `moz-extension://test/${path}`,
      connect: () => ({ onMessage: { addListener: (fn: () => void) => { notify = fn; } }, onDisconnect: { addListener: () => {} }, disconnect: () => {} }),
      sendMessage: async (message: Request) => {
        messages.push(structuredClone(message));
        let value: unknown;
        if (message.type === 'snapshot') value = structuredClone(snapshot);
        if (message.type === 'close') value = { closed: message.targets.length, skipped: 0, failed: 0, interrupted: false };
        if (message.type === 'preferences') snapshot.preferences = message.preferences;
        if (message.type === 'recovery') value = structuredClone(batches);
        if (message.type === 'restore') value = await restore();
        if (message.type === 'delete-batch') {
          const index = batches.findIndex(batch => batch.id === message.id);
          if (index !== -1) batches.splice(index, 1);
        }
        return { ok: true, value };
      },
    },
  } });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  window.eval(script);
  const settle = () => new Promise(resolve => setTimeout(resolve, 30));
  await settle();
  return { dom, window, messages, notify: () => notify(), settle, shortcut: () => shortcut };
}

test('dashboard supports search, selection, preview isolation, and normal Tab navigation', async () => {
  const snapshot: Snapshot = { tabs: [tab(1, { title: 'Firefox docs', lastAccessed: 20 }), tab(2, { title: 'Firefox issue', lastAccessed: 10 }), tab(3, { pinned: true })], preferences: { group: 'none', topics: [], layout: 'list' }, containers: false };
  const { dom, window, messages, notify, settle } = await dashboard(snapshot);
  const document = window.document;
  const search = document.querySelector<HTMLInputElement>('#search')!;
  assert.equal(document.activeElement, search);
  assert.equal(document.querySelectorAll('.tab-row').length, 3);
  assert.equal(document.querySelector<HTMLInputElement>('input[data-tab-id="3"]')!.disabled, true);
  const checkbox = document.querySelector<HTMLInputElement>('input[data-tab-id="1"]')!;
  checkbox.focus();
  const space = new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
  checkbox.dispatchEvent(space);
  assert.equal(space.defaultPrevented, false, 'checkboxes keep native keyboard behavior');
  search.focus();
  const tabKey = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  search.dispatchEvent(tabKey);
  assert.equal(tabKey.defaultPrevented, false);
  search.value = 'Firefox'; search.dispatchEvent(new window.Event('input'));
  assert.equal(document.querySelectorAll('.tab-row').length, 2);
  assert.ok(document.querySelector('mark'));
  document.querySelector<HTMLButtonElement>('#select-all')!.click();
  assert.equal(document.querySelector('#selected-count')!.textContent, '2 selected');
  search.value = 'docs'; search.dispatchEvent(new window.Event('input'));
  assert.equal(document.querySelector<HTMLElement>('#bulk')!.hidden, true, 'filter changes clear selection');
  search.value = 'Firefox'; search.dispatchEvent(new window.Event('input'));
  document.querySelector<HTMLButtonElement>('#select-all')!.click();
  document.querySelector<HTMLButtonElement>('#close-selected')!.click();
  assert.equal(document.querySelectorAll('#close-list li').length, 2);
  snapshot.tabs.push(tab(4, { title: 'Firefox new tab', lastAccessed: 30 }));
  notify(); await settle();
  assert.equal(document.querySelectorAll('.tab-row').length, 3);
  document.querySelector<HTMLButtonElement>('#confirm-close')!.click(); await settle();
  const close = messages.find(message => message.type === 'close');
  assert.ok(close?.type === 'close');
  assert.deepEqual(close.targets.map(target => target.id), [1, 2]);
  assert.equal(document.querySelector<HTMLDialogElement>('#close-dialog')!.open, false);

  search.value = ''; search.dispatchEvent(new window.Event('input'));
  search.focus();
  search.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  search.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle();
  assert.ok(messages.some(message => message.type === 'activate' && message.id === 2));
  snapshot.tabs = Array.from({ length: 1000 }, (_, id) => tab(id, { title: `Project ${id}` })) as TabRecord[];
  notify(); await settle();
  assert.equal(document.querySelectorAll('.tab-row').length, 1000);
  search.value = 'Project 999'; search.dispatchEvent(new window.Event('input'));
  assert.ok(document.querySelectorAll('.tab-row').length < 1000);
  dom.window.close();
});

test('recovery dialog locks during reopening, refreshes tabs, and supports deleting records', async () => {
  const snapshot: Snapshot = { tabs: [], preferences: { group: 'none', topics: [] }, containers: false };
  const batches: RecoveryBatch[] = [{ id: 'batch-1', createdAt: 1, entries: [
    { tab: tab(1), status: 'closed' },
    { tab: tab(2), status: 'reopen-uncertain', error: 'Reopening was interrupted.' },
  ] }];
  let finish!: (result: RestoreResult) => void;
  const restored = new Promise<RestoreResult>(resolve => { finish = resolve; });
  const { dom, window, messages, settle } = await dashboard(snapshot, batches, () => restored);
  try {
    const document = window.document;
    document.querySelector<HTMLButtonElement>('#recovery-open')!.click(); await settle();
    const dialog = document.querySelector<HTMLDialogElement>('#recovery-dialog')!;
    assert.equal(dialog.open, true);
    assert.match(document.querySelector('#recovery-list')!.textContent!, /Reopening was interrupted/);
    const reopen = document.querySelector<HTMLButtonElement>('.recovery-batch button')!;
    assert.equal(reopen.textContent, 'Reopen 1 tabs');
    reopen.click(); reopen.click();
    assert.equal(messages.filter(message => message.type === 'restore').length, 1);
    assert.ok([...document.querySelectorAll<HTMLButtonElement>('.recovery-batch button')].every(button => button.disabled));
    const cancel = new window.Event('cancel', { cancelable: true });
    dialog.dispatchEvent(cancel);
    assert.equal(cancel.defaultPrevented, true);

    batches[0].entries[0].status = 'reopened';
    snapshot.tabs.push(tab(3));
    finish({ reopened: 1, failed: 0 }); await settle();
    assert.equal(document.querySelector('#recovery-status')!.textContent, '1 reopened · 0 failed. View tabs for details.');
    assert.equal(document.querySelectorAll('.tab-row').length, 1, 'reopening refreshes the dashboard');
    assert.equal(document.querySelector<HTMLButtonElement>('.recovery-batch button')!.disabled, true);
    const nextCancel = new window.Event('cancel', { cancelable: true });
    dialog.dispatchEvent(nextCancel);
    assert.equal(nextCancel.defaultPrevented, false, 'the operation lock is released');
    const restoreMessage = messages.find(message => message.type === 'restore');
    assert.deepEqual(restoreMessage, { type: 'restore', id: 'batch-1', windowId: 1 });
    document.querySelector<HTMLButtonElement>('.recovery-batch button:last-child')!.click(); await settle();
    assert.equal(document.querySelectorAll('.recovery-batch').length, 0);
    assert.match(document.querySelector('#recovery-list')!.textContent!, /No recovery batches/);
  } finally { dom.window.close(); }
});

test('recovery dialog releases its lock and leaves reopening available after a failure', async () => {
  const snapshot: Snapshot = { tabs: [], preferences: { group: 'none', topics: [] }, containers: false };
  const batches: RecoveryBatch[] = [{ id: 'batch-1', createdAt: 1, entries: [{ tab: tab(1), status: 'closed' }] }];
  const { dom, window, settle } = await dashboard(snapshot, batches, async () => { throw new Error('Storage unavailable'); });
  try {
    const document = window.document;
    document.querySelector<HTMLButtonElement>('#recovery-open')!.click(); await settle();
    document.querySelector<HTMLButtonElement>('.recovery-batch button')!.click(); await settle();
    assert.match(document.querySelector('#recovery-status')!.textContent!, /Storage unavailable/);
    assert.ok([...document.querySelectorAll<HTMLButtonElement>('.recovery-batch button')].every(button => !button.disabled));
    const cancel = new window.Event('cancel', { cancelable: true });
    document.querySelector('#recovery-dialog')!.dispatchEvent(cancel);
    assert.equal(cancel.defaultPrevented, false);
  } finally { dom.window.close(); }
});

test('settings can change, disable, reset, and display the browser shortcut', async () => {
  const snapshot: Snapshot = { tabs: [], preferences: { group: 'none', topics: [] }, containers: false };
  const { dom, window, settle, shortcut } = await dashboard(snapshot);
  const document = window.document;
  document.querySelector<HTMLButtonElement>('#settings-open')!.click(); await settle();
  const input = document.querySelector<HTMLInputElement>('#shortcut')!;
  assert.equal(input.value, 'Ctrl+Alt+Y');
  input.value = 'Ctrl+Shift+U'; document.querySelector<HTMLButtonElement>('#shortcut-update')!.click(); await settle();
  assert.equal(shortcut(), 'Ctrl+Shift+U');
  assert.equal(input.value, 'Ctrl+Shift+U');
  input.value = 'invalid'; document.querySelector<HTMLButtonElement>('#shortcut-update')!.click(); await settle();
  assert.match(document.querySelector('#shortcut-status')!.textContent!, /Invalid shortcut/);
  assert.equal(shortcut(), 'Ctrl+Shift+U');
  input.value = ''; document.querySelector<HTMLButtonElement>('#shortcut-update')!.click(); await settle();
  assert.equal(shortcut(), '');
  document.querySelector<HTMLButtonElement>('#shortcut-reset')!.click(); await settle();
  assert.equal(shortcut(), 'Ctrl+Alt+Y');
  dom.window.close();
});

test('grid drag selection adds across gestures, protects tabs, cancels, and defers live rendering', async () => {
  const icon = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E';
  const snapshot: Snapshot = { tabs: Array.from({ length: 6 }, (_, i) => tab(i + 1, { pinned: i === 2, favIconUrl: i === 0 ? icon : undefined })), preferences: { group: 'none', topics: [] }, containers: false };
  const { dom, window, messages, notify, settle } = await dashboard(snapshot);
  const document = window.document;
  assert.equal(document.querySelector<HTMLElement>('#results')!.dataset.layout, 'grid');
  assert.equal(document.querySelectorAll('.tab-icon').length, 6);
  const caretKey = new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
  document.querySelector<HTMLInputElement>('#search')!.dispatchEvent(caretKey);
  assert.equal(caretKey.defaultPrevented, false, 'horizontal arrows in search must move the caret');
  assert.equal(document.querySelector<HTMLImageElement>('.tab-icon')!.src, icon);
  document.querySelector<HTMLImageElement>('.tab-icon')!.dispatchEvent(new window.Event('error'));
  assert.equal(document.querySelector<HTMLImageElement>('.tab-icon')!.src, 'moz-extension://test/tab.svg');
  const geometry = () => document.querySelectorAll<HTMLElement>('.tab-row').forEach((row, index) => {
    const x = 20 + (index % 3) * 120;
    const y = 150 + Math.floor(index / 3) * 60;
    row.getBoundingClientRect = () => ({ x, y, left: x, top: y, right: x + 100, bottom: y + 40, width: 100, height: 40, toJSON: () => ({}) });
  });
  geometry();
  function pointer(target: Element | Document, type: string, x: number, y: number, ctrl = false) {
    const event = new window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true, ctrlKey: ctrl });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    target.dispatchEvent(event);
  }
  const checked = () => [...document.querySelectorAll<HTMLInputElement>('input[data-tab-id]:checked')].map(input => Number(input.dataset.tabId));
  const first = document.querySelector<HTMLButtonElement>('.tab-open')!;
  document.querySelector<HTMLInputElement>('input[data-tab-id="6"]')!.click();
  pointer(first, 'pointerdown', 25, 155);
  pointer(document, 'pointermove', 235, 245);
  assert.deepEqual(checked(), [1, 2, 4, 5, 6]);
  assert.equal(document.querySelector<HTMLElement>('.selection-box')!.hidden, false);
  pointer(document, 'pointerup', 235, 245);
  first.click();
  await settle();
  assert.equal(messages.filter(message => message.type === 'activate').length, 0, 'drag must not open a tab');
  pointer(document.querySelector('.tab-row[data-id="6"]')!, 'pointerdown', 265, 215);
  pointer(document, 'pointermove', 355, 245);
  pointer(document, 'pointerup', 355, 245);
  assert.deepEqual(checked(), [1, 2, 4, 5, 6]);
  await settle();
  pointer(first, 'pointerdown', 25, 155);
  pointer(document, 'pointermove', 115, 185);
  assert.deepEqual(checked(), [1, 2, 4, 5, 6]);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.deepEqual(checked(), [], 'Escape cancels the drag and deselects its baseline too');
  assert.equal(document.querySelector<HTMLElement>('.selection-box')!.hidden, true);
  await settle();
  pointer(first, 'pointerdown', 25, 155);
  pointer(document, 'pointermove', 235, 245);
  snapshot.tabs.push(tab(7)); notify(); await settle();
  assert.equal(document.querySelectorAll('.tab-row').length, 6, 'live updates must not move rows under a drag');
  pointer(document, 'pointerup', 235, 245); await settle();
  assert.equal(document.querySelectorAll('.tab-row').length, 7);
  assert.deepEqual(checked(), [1, 2, 4, 5], 'new tabs must not enter the completed drag');
  const layout = document.querySelector<HTMLSelectElement>('#layout')!;
  layout.value = 'list'; layout.dispatchEvent(new window.Event('change')); await settle();
  assert.equal(snapshot.preferences.layout, 'list');
  assert.equal(document.querySelector<HTMLElement>('#results')!.dataset.layout, 'list');
  dom.window.close();
});


test('domain folders preserve cross-domain selections and scope select-all to the open folder', async () => {
  const snapshot: Snapshot = { tabs: [tab(1, { favIconUrl: 'https://example.com/favicon.ico' }), tab(2, { pinned: true }), tab(3, { url: 'https://other.test/a' }), tab(4, { url: 'https://other.test/b', discarded: true })], preferences: { group: 'domain', topics: [] }, containers: false };
  const { dom, window } = await dashboard(snapshot);
  const document = window.document;
  assert.equal(document.querySelectorAll('.domain-card').length, 2);
  assert.equal(document.querySelectorAll('.tab-row').length, 0);
  const example = [...document.querySelectorAll<HTMLElement>('.domain-card')].find(card => card.textContent?.includes('example.com'))!;
  assert.equal(example.querySelector<HTMLImageElement>('.tab-icon')!.src, 'https://example.com/favicon.ico');
  assert.equal(document.querySelectorAll('.domain-card .tab-icon').length, 2);
  assert.equal(example.querySelector('.domain-state')!.textContent, '2 loaded · 0 unloaded');
  assert.ok([...document.querySelectorAll('.domain-state')].some(state => state.textContent === '1 loaded · 1 unloaded'));
  const missing = [...document.querySelectorAll<HTMLImageElement>('.domain-card .tab-icon')].find(icon => icon.src.endsWith('tab.svg'))!;
  assert.ok(missing);
  example.querySelector<HTMLInputElement>('input')!.click();
  assert.equal(document.querySelector('#selected-count')!.textContent, '1 selected');
  [...document.querySelectorAll<HTMLButtonElement>('.domain-open')].find(button => button.textContent?.includes('other.test'))!.click();
  assert.equal(document.querySelectorAll('.tab-row').length, 2);
  document.querySelector<HTMLButtonElement>('#select-all')!.click();
  assert.equal(document.querySelector('#selected-count')!.textContent, '3 selected');
  document.querySelector<HTMLButtonElement>('.domain-back')!.click();
  assert.equal(document.querySelectorAll('.domain-card.selected').length, 2);
  assert.equal(document.querySelectorAll('input[data-group]:checked').length, 2);
  dom.window.close();
});

test('Backspace closes selected tabs outside editable controls and ignores repeat or modifiers', async () => {
  const snapshot: Snapshot = { tabs: [tab(1), tab(2, { pinned: true })], preferences: { group: 'none', topics: [] }, containers: false };
  const { dom, window, messages, settle } = await dashboard(snapshot);
  const document = window.document;
  document.querySelector<HTMLButtonElement>('#select-all')!.click();
  const key = (options = {}) => { const event = new window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true, ...options }); document.activeElement!.dispatchEvent(event); return event; };
  assert.equal(key().defaultPrevented, false, 'search must still edit normally');
  document.querySelector<HTMLElement>('#results')!.focus();
  assert.equal(key({ repeat: true }).defaultPrevented, false);
  assert.equal(key({ ctrlKey: true }).defaultPrevented, false);
  assert.equal(messages.some(message => message.type === 'close'), false);
  assert.equal(key().defaultPrevented, true);
  await settle();
  const closes = messages.filter(message => message.type === 'close');
  assert.equal(closes.length, 1);
  assert.ok(closes[0].type === 'close');
  assert.deepEqual(closes[0].targets.map(target => target.id), [1]);
  assert.equal(document.querySelector<HTMLDialogElement>('#close-dialog')!.open, false);
  dom.window.close();
});

test('loaded state sorting persists, keeps search highlights, and offers diagnostics', async () => {
  const snapshot: Snapshot = { tabs: [tab(1, { discarded: true, lastAccessed: 50 }), tab(2, { lastAccessed: 20 }), tab(3, { discarded: true, lastAccessed: 10 })], preferences: { group: 'none', topics: [] }, containers: false };
  const { dom, window, messages, settle } = await dashboard(snapshot);
  const document = window.document;
  const ids = () => [...document.querySelectorAll<HTMLElement>('.tab-row')].map(row => Number(row.dataset.id));
  const sort = document.querySelector<HTMLSelectElement>('#sort')!;
  sort.value = 'loaded'; sort.dispatchEvent(new window.Event('change')); await settle();
  assert.deepEqual(ids(), [2, 1, 3]); assert.equal(snapshot.preferences.sort, 'loaded');
  sort.value = 'unloaded'; sort.dispatchEvent(new window.Event('change')); await settle();
  assert.deepEqual(ids(), [1, 3, 2]);
  const search = document.querySelector<HTMLInputElement>('#search')!;
  search.value = 'Tab'; search.dispatchEvent(new window.Event('input'));
  assert.ok(document.querySelector('mark'));
  assert.match(document.querySelector('.badges')!.textContent!, /Unloaded/);
  document.querySelector<HTMLButtonElement>('#settings-open')!.click();
  document.querySelector<HTMLButtonElement>('#memory-diagnostics')!.click(); await settle();
  const address = document.querySelector<HTMLInputElement>('#memory-address')!;
  assert.equal(address.value, 'about:processes');
  assert.equal(document.activeElement, address);
  assert.equal(address.selectionStart, 0);
  assert.equal(address.selectionEnd, address.value.length);
  dom.window.close();
});


test('Escape deselects from search and domain folders without clearing the query', async () => {
  const snapshot: Snapshot = { tabs: [tab(1), tab(2)], preferences: { group: 'domain', topics: [] }, containers: false };
  const { dom, window } = await dashboard(snapshot);
  const document = window.document;
  const search = document.querySelector<HTMLInputElement>('#search')!;
  search.value = 'Tab'; search.dispatchEvent(new window.Event('input'));
  document.querySelector<HTMLButtonElement>('#select-all')!.click();
  search.focus();
  search.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(search.value, 'Tab');
  assert.equal(document.querySelector<HTMLElement>('#bulk')!.hidden, true);
  document.querySelector<HTMLInputElement>('.domain-card input')!.click();
  const folder = document.querySelector<HTMLButtonElement>('.domain-open')!;
  folder.focus(); folder.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(document.querySelectorAll('.domain-card.selected').length, 0);
  dom.window.close();
});

test('dashboard shortcuts can be remapped, disabled, reset, and persisted without native activation', async () => {
  const snapshot: Snapshot = { tabs: [tab(1)], preferences: { group: 'none', topics: [] }, containers: false };
  const { dom, window, messages, settle } = await dashboard(snapshot);
  const document = window.document;
  const click = (id: string) => document.querySelector<HTMLButtonElement>(`#${id}`)!.click();
  const set = (action: string, value: string) => { document.querySelector<HTMLInputElement>(`input[data-action="${action}"]`)!.value = value; };
  click('settings-open');
  set('closeSelected', 'Delete'); set('clearSelection', 'Ctrl+K'); set('openTab', 'Ctrl+O');
  click('save-settings'); await settle();
  assert.equal(snapshot.preferences.keybindings?.closeSelected, 'Delete');
  const key = (value: string, ctrlKey = false) => {
    const event = new window.KeyboardEvent('keydown', { key: value, ctrlKey, bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(event); return event;
  };
  click('select-all'); document.querySelector<HTMLElement>('#results')!.focus();
  key('Escape'); assert.equal(document.querySelector('#selected-count')!.textContent, '1 selected');
  key('k', true); assert.equal(document.querySelector<HTMLElement>('#bulk')!.hidden, true);
  click('select-all'); document.querySelector<HTMLButtonElement>('.tab-open')!.focus();
  assert.equal(key('Enter').defaultPrevented, true);
  assert.equal(key('Backspace').defaultPrevented, false);
  assert.equal(messages.some(message => message.type === 'activate' || message.type === 'close'), false);
  key('o', true); await settle(); assert.ok(messages.some(message => message.type === 'activate'));
  key('Delete'); await settle(); assert.equal(messages.filter(message => message.type === 'close').length, 1);
  click('settings-open');
  assert.equal(document.querySelector<HTMLInputElement>('input[data-action="closeSelected"]')!.value, 'Delete');
  set('clearSelection', 'Delete'); click('save-settings'); await settle();
  assert.equal(document.querySelector<HTMLDialogElement>('#settings-dialog')!.open, true);
  assert.match(document.querySelector('#settings-status')!.textContent!, /more than once/);
  set('clearSelection', ''); set('openTab', ''); click('save-settings'); await settle();
  assert.equal(snapshot.preferences.keybindings?.openTab, '');
  click('settings-open'); click('bindings-reset'); click('save-settings'); await settle();
  assert.equal(snapshot.preferences.keybindings?.closeSelected, 'Backspace');
  assert.equal(snapshot.preferences.keybindings?.clearSelection, 'Escape');
  dom.window.close();
});
