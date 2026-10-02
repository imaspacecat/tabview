import { DEFAULT_BINDINGS } from './keybindings';
import { create, element } from './dom';
import { installSettings } from './settings';
import { installRecovery } from './recovery-dialog';
import { installKeyboard } from './keyboard';
import { createTabRenderer } from './tab-renderer';
import './style.css';
import { request, subscribe } from './client';
import { groupResults, searchTabs, selectable, selectRange } from './model';
import { installDragSelection } from './selection';
import { DEFAULT_PREFERENCES } from './types';
import type { CloseResult, CloseTarget, Filters, GroupMode, Preferences, SearchResult, Snapshot, TabRecord } from './types';

const search = element<HTMLInputElement>('search');
const results = element<HTMLDivElement>('results');
const groupSelect = element<HTMLSelectElement>('group');
const windowSelect = element<HTMLSelectElement>('window');
const ageSelect = element<HTMLSelectElement>('age');
const layoutSelect = element<HTMLSelectElement>('layout');
const sortSelect = element<HTMLSelectElement>('sort');
let activeDomain: string | undefined;
let scopedMatches: SearchResult[] = [];
const pinned = element<HTMLInputElement>('include-pinned');
const audible = element<HTMLInputElement>('include-audible');
const closeDialog = element<HTMLDialogElement>('close-dialog');
let tabs: TabRecord[] = [];
let preferences: Preferences = structuredClone(DEFAULT_PREFERENCES);
const selected = new Map<number, CloseTarget>();
let visible: TabRecord[] = [];
let anchor: number | undefined;
let focusedId: number | undefined;
let preview: CloseTarget[] = [];
let previewOptions = { includePinned: false, includeAudible: false };
let containers = false;
let currentWindow = 0;
let busy = false;
let hasMouseMoved = false;
const collapsed = new Set<string>();

function filters(): Filters {
  return { query: search.value, windowId: windowSelect.value === 'all' ? 'all' : Number(windowSelect.value), age: ageSelect.value as Filters['age'], includePinned: pinned.checked, includeAudible: audible.checked };
}

function status(message: string): void {
  const output = element('status');
  output.textContent = message;
  output.hidden = !message;
}

function clearSelection(): void { selected.clear(); anchor = undefined; }

function selectedChanged(): void {
  element('bulk').hidden = selected.size === 0;
  element('selected-count').textContent = `${selected.size} selected`;
  results.querySelectorAll<HTMLInputElement>('input[data-tab-id]').forEach(input => { input.checked = selected.has(Number(input.dataset.tabId)); });
  results.querySelectorAll<HTMLElement>('.tab-row').forEach(row => { row.classList.toggle('selected', selected.has(Number(row.dataset.id))); });
  results.querySelectorAll<HTMLInputElement>('input[data-group]').forEach(input => {
    const ids = (input.dataset.ids ?? '').split(',').filter(Boolean).map(Number);
    const count = ids.filter(id => selected.has(id)).length;
    input.checked = ids.length > 0 && count === ids.length;
    input.indeterminate = count > 0 && count < ids.length;
  });
  results.querySelectorAll<HTMLElement>('.domain-card').forEach(card => { card.classList.toggle('selected', (card.dataset.ids ?? '').split(',').some(id => selected.has(Number(id)))); });
  element<HTMLButtonElement>('close-selected').disabled = busy;
}

function selectTabs(candidates: TabRecord[], checked = true): void {
  const options = filters();
  for (const tab of candidates) {
    if (!selectable(tab, options)) continue;
    if (checked) selected.set(tab.id, { id: tab.id, key: tab.key, url: tab.url });
    else selected.delete(tab.id);
  }
  selectedChanged();
}

function toggle(tab: TabRecord, checked: boolean, range = false): void {
  const ids = range ? selectRange(visible.filter(tab => selectable(tab, filters())).map(tab => tab.id), anchor, tab.id) : [tab.id];
  anchor = tab.id;
  selectTabs(ids.map(id => tabs.find(tab => tab.id === id)).filter(tab => tab !== undefined), checked);
}

function focusRow(id: number | undefined, scroll = false): void {
  focusedId = id;
  results.querySelectorAll<HTMLElement>('.tab-row').forEach(row => {
    const active = Number(row.dataset.id) === id;
    row.classList.toggle('focused', active);
    row.querySelector<HTMLButtonElement>('.tab-open')!.tabIndex = active ? 0 : -1;
    if (active && scroll) row.scrollIntoView({ block: 'nearest' });
  });
}

const { row, groupCheckbox, domainFolder } = createTabRenderer({
  filters, group: () => groupSelect.value as GroupMode, selected: id => selected.has(id),
  toggle, selectTabs, activate, focus: focusRow,
  hover: id => { if (hasMouseMoved) focusRow(id); },
  openDomain: name => { activeDomain = name; render(); results.focus({ preventScroll: true }); },
});

function render(): void {
  const options = filters();
  const matches = searchTabs(tabs, options);
  if (sortSelect.value !== 'recent') matches.sort((a, b) => (Number(a.item.discarded) - Number(b.item.discarded)) * (sortSelect.value === 'loaded' ? 1 : -1));
  let groups = groupResults(matches, groupSelect.value as GroupMode, preferences.topics);
  const domainMode = groupSelect.value === 'domain';
  if (!domainMode || !groups.some(group => group.name === activeDomain)) activeDomain = undefined;
  const overview = domainMode && activeDomain === undefined;
  if (activeDomain !== undefined) groups = groups.filter(group => group.name === activeDomain);
  scopedMatches = activeDomain === undefined ? matches : groups.flatMap(group => group.results);
  const fragment = document.createDocumentFragment();
  results.dataset.layout = layoutSelect.value;
  visible = [];
  if (overview) {
    const folders = create('div', { className: 'domain-folders' });
    groups.sort((a, b) => b.results.length - a.results.length || a.name.localeCompare(b.name));
    groups.forEach(group => folders.append(domainFolder(group)));
    fragment.append(folders);
  } else if (domainMode) {
    fragment.append(create('button', { className: 'domain-back', onclick: () => { activeDomain = undefined; render(); results.querySelector<HTMLButtonElement>('.domain-open')?.focus({ preventScroll: true }); } }, '← All domains'));
  }
  for (const group of overview ? [] : groups) {
    if (!group.results.length) continue;
    const section = document.createElement('section');
    if (groupSelect.value !== 'none') {
      section.append(create('div', { className: 'group-heading' }, groupCheckbox(group),
        create('button', { ariaExpanded: String(!collapsed.has(group.name)), onclick: () => { if (collapsed.has(group.name)) collapsed.delete(group.name); else collapsed.add(group.name); render(); } }, `${collapsed.has(group.name) ? '▸' : '▾'} ${group.name}`),
        create('span', {}, String(group.results.length))));
    }
    if (!collapsed.has(group.name) || groupSelect.value === 'none') {
      const entries = create('div', { className: 'tab-entries' });
      for (const result of group.results) { visible.push(result.item); entries.append(row(result)); }
      section.append(entries);
    }
    fragment.append(section);
  }
  if (!matches.length) {
    fragment.append(create('p', { className: 'empty' }, tabs.length ? 'No matching tabs.' : 'No tabs available.'));
  }
  results.replaceChildren(fragment);
  results.setAttribute('aria-busy', 'false');
  const keys = { ...DEFAULT_BINDINGS, ...preferences.keybindings };
  element('keyboard-help').textContent = `Drag adds to selection · ${keys.clearSelection || 'Unbound'} deselects · ${keys.closeSelected || 'Unbound'} closes selected · Keyboard shortcuts in Settings`;
  element('count').textContent = overview ? `${groups.length} domains · ${matches.length} tabs` : activeDomain !== undefined ? `${scopedMatches.length} tabs · ${activeDomain}` : `${matches.length} of ${tabs.length} tabs`;
  element<HTMLButtonElement>('select-all').disabled = !scopedMatches.some(result => selectable(result.item, options));
  if (!visible.some(tab => tab.id === focusedId)) focusedId = visible[0]?.id;
  focusRow(focusedId);
  selectedChanged();
}

function windowOptions(): void {
  const previous = windowSelect.value;
  const ids = [...new Set(tabs.map(tab => tab.windowId))].sort((a, b) => a - b);
  windowSelect.replaceChildren(new Option('All windows', 'all'));
  ids.forEach((id, index) => windowSelect.add(new Option(`Window ${index + 1}${id === currentWindow ? ' (this window)' : ''}`, String(id))));
  windowSelect.value = ids.includes(Number(previous)) ? previous : 'all';
  if (windowSelect.value !== previous) clearSelection();
}

let refreshing = false;
let refreshAgain = false;
async function refresh(): Promise<void> {
  if (dragSelection.pending() || refreshing) { refreshAgain = true; return; }
  refreshing = true;
  try {
    do {
      refreshAgain = false;
      const snapshot = await request<Snapshot>({ type: 'snapshot' });
      if (dragSelection.pending()) { refreshAgain = true; return; }
      tabs = snapshot.tabs;
      preferences = snapshot.preferences;
      containers = snapshot.containers;
      sortSelect.value = preferences.sort ?? 'recent';
      layoutSelect.value = preferences.layout ?? 'grid';
      if (groupSelect.value !== preferences.group) { groupSelect.value = preferences.group; clearSelection(); collapsed.clear(); }
      for (const [id, target] of selected) {
        const tab = tabs.find(tab => tab.id === id);
        if (!tab || tab.key !== target.key || tab.url !== target.url || !selectable(tab, filters())) selected.delete(id);
      }
      windowOptions();
      const active = document.activeElement as HTMLElement | null;
      const activeRow = active?.closest<HTMLElement>('.tab-row');
      const activeId = activeRow?.dataset.id;
      const wasCheckbox = active instanceof HTMLInputElement;
      render();
      if (activeId) results.querySelector<HTMLElement>(`.tab-row[data-id="${activeId}"] ${wasCheckbox ? 'input' : '.tab-open'}`)?.focus({ preventScroll: true });
    } while (refreshAgain);
  } catch (error) { status(error instanceof Error ? error.message : String(error)); results.setAttribute('aria-busy', 'false'); }
  finally { refreshing = false; }
}

async function activate(id: number): Promise<void> {
  try { await request({ type: 'activate', id }); } catch (error) { status(String(error)); await refresh(); }
}

const dragSelection = installDragSelection(results, {
  selected: () => new Set(selected.keys()),
  eligible: id => { const tab = tabs.find(tab => tab.id === id); return !busy && !!tab && selectable(tab, filters()); },
  apply: ids => {
    selected.clear();
    selectTabs(tabs.filter(tab => ids.has(tab.id)));
  },
  finished: dragged => { if (dragged) results.focus({ preventScroll: true }); if (refreshAgain) void refresh(); },
});

function changedFilter(): void { dragSelection.cancel(); clearSelection(); activeDomain = undefined; collapsed.clear(); render(); }
search.addEventListener('input', changedFilter);
for (const control of [windowSelect, ageSelect, pinned, audible]) control.addEventListener('change', changedFilter);
for (const [key, control] of Object.entries({ group: groupSelect, layout: layoutSelect, sort: sortSelect })) {
  control.addEventListener('change', async () => {
    if (key === 'group') changedFilter();
    else dragSelection.cancel();
    preferences = { ...preferences, [key]: control.value };
    if (key !== 'group') render();
    try { await request({ type: 'preferences', preferences }); } catch (error) { status(String(error)); }
  });
}
element('select-all').addEventListener('click', () => selectTabs(scopedMatches.map(result => result.item)));
element('clear-selection').addEventListener('click', () => { clearSelection(); selectedChanged(); });

element('close-selected').addEventListener('click', () => {
  preview = [...selected.values()].map(target => ({ ...target }));
  previewOptions = { includePinned: pinned.checked, includeAudible: audible.checked };
  const list = element('close-list'); list.replaceChildren();
  for (const target of preview) {
    const tab = tabs.find(tab => tab.id === target.id);
    list.append(create('li', { title: target.url }, tab?.title ?? target.url));
  }
  element('close-description').textContent = `${preview.length} tab${preview.length === 1 ? '' : 's'} will be closed. Tabs that navigate or become protected before closing will be skipped.`;
  closeDialog.showModal();
});
async function closeTargets(targets: CloseTarget[], options: typeof previewOptions): Promise<void> {
  if (busy) return;
  busy = true;
  closeDialog.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = true; });
  try {
    const result = await request<CloseResult>({ type: 'close', targets, ...options });
    clearSelection(); closeDialog.close();
    status(`${result.closed} closed · ${result.skipped} skipped · ${result.failed} failed.${result.interrupted ? ' Recovery storage failed; closing stopped. Check Recovery for interrupted entries.' : ''}`);
  } catch (error) { status(`Closing stopped: ${error instanceof Error ? error.message : String(error)}`); closeDialog.close(); }
  finally { busy = false; closeDialog.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = false; }); await refresh(); results.focus({ preventScroll: true }); }
}
element('confirm-close').addEventListener('click', () => { void closeTargets(preview, previewOptions); });

document.querySelectorAll<HTMLButtonElement>('[data-dismiss]').forEach(button => button.addEventListener('click', () => button.closest('dialog')?.close()));
closeDialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
installSettings({
  preferences: () => preferences, containers: () => containers,
  setContainers: enabled => { containers = enabled; },
  saved: updated => { preferences = updated; clearSelection(); collapsed.clear(); render(); },
});
installRecovery({
  busy: () => busy, setBusy: value => { busy = value; },
  windowId: () => currentWindow, refresh,
});
installKeyboard(search, results, {
  state: () => ({
    bindings: preferences.keybindings, visible, focusedId, grid: layoutSelect.value === 'grid',
    canClose: !busy && !dragSelection.pending() && selected.size > 0,
  }),
  pointerMoved: moved => { hasMouseMoved = moved; },
  clearSelection: () => { dragSelection.cancel(); clearSelection(); selectedChanged(); },
  closeSelected: () => { void closeTargets([...selected.values()].map(target => ({ ...target })), { includePinned: pinned.checked, includeAudible: audible.checked }); },
  focus: focusRow, activate,
  toggleSelection: (id, range) => {
    const tab = visible.find(tab => tab.id === id);
    if (tab && selectable(tab, filters())) toggle(tab, !selected.has(tab.id), range);
  },
  clearSearch: () => { search.value = ''; changedFilter(); },
});

async function init(): Promise<void> {
  if (typeof browser === 'undefined') {
    status('Load the built extension in Firefox or Zen to view your tabs. See README for installation.');
    results.setAttribute('aria-busy', 'false'); element('count').textContent = 'Browser extension required';
    element<HTMLButtonElement>('select-all').disabled = true; return;
  }
  try { currentWindow = (await browser.windows.getCurrent()).id ?? 0; } catch {}
  const unsubscribe = subscribe(() => { void refresh(); });
  window.addEventListener('pagehide', unsubscribe, { once: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  await refresh(); search.focus();
}
void init();
