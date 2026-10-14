import { request } from './client';
import { create, element } from './dom';
import { browserGroupLabel, groupColor } from './browser-groups';
import type { CloseTarget, GroupDestination, GroupResult, Snapshot, TabRecord } from './types';

interface GroupCallbacks {
  targets(): CloseTarget[];
  busy(): boolean;
  setBusy(value: boolean): void;
  windowId(): number;
  refresh(): Promise<void>;
  clearSelection(): void;
  status(message: string): void;
}

export function installGrouping(callbacks: GroupCallbacks): () => void {
  const dialog = element<HTMLDialogElement>('group-dialog');
  const form = element<HTMLFormElement>('group-form');
  const destination = element<HTMLSelectElement>('group-destination');
  const name = element<HTMLInputElement>('group-name');
  const windowSelect = element<HTMLSelectElement>('group-window');
  const output = element('group-status');
  const submit = element<HTMLButtonElement>('confirm-group');
  let targets: CloseTarget[] = [];
  let snapshot: Snapshot | undefined;
  let submitting = false;
  let generation = 0;

  function update(): void {
    const isNew = destination.value === 'new';
    element('new-group-fields').hidden = !isNew;
    name.required = isNew;
    const group = snapshot?.browserGroups?.find(group => String(group.id) === destination.value);
    const windowId = isNew ? Number(windowSelect.value) : group?.windowId;
    const tabs = targets.map(target => snapshot?.tabs.find(tab => tab.id === target.id)).filter((tab): tab is TabRecord => !!tab);
    const moving = tabs.filter(tab => tab.windowId !== windowId).length;
    const pinned = tabs.filter(tab => tab.pinned).length;
    element('group-description').textContent = `${targets.length} selected · ${moving} will change windows.${pinned ? ` ${pinned} pinned tab${pinned === 1 ? '' : 's'} will be unpinned.` : ''}`;
    const color = group?.color;
    const swatch = element('group-color');
    swatch.hidden = !color;
    swatch.style.backgroundColor = groupColor(color ?? 'grey');
    submit.disabled = submitting || !snapshot?.groupingAvailable || (isNew ? !name.value.trim() || !windowSelect.value : !group);
  }

  async function open(): Promise<void> {
    if (callbacks.busy() || dialog.open) return;
    targets = callbacks.targets().map(target => ({ ...target }));
    if (!targets.length) return;
    const token = ++generation;
    snapshot = undefined;
    name.value = '';
    destination.replaceChildren(new Option('New group…', 'new'));
    windowSelect.replaceChildren();
    output.textContent = 'Loading groups…';
    update(); dialog.showModal(); destination.focus();
    try {
      const fresh = await request<Snapshot>({ type: 'snapshot' });
      if (!dialog.open || token !== generation) return;
      snapshot = fresh;
      const ids = (fresh.groupWindows ?? []).map(window => window.id).sort((a, b) => a - b);
      const windowLabel = (id: number) => `Window ${ids.indexOf(id) + 1}${id === callbacks.windowId() ? ' (this window)' : ''}`;
      ids.forEach(id => windowSelect.add(new Option(windowLabel(id), String(id))));
      const selectedWindows = new Set(targets.map(target => fresh.tabs.find(tab => tab.id === target.id)?.windowId));
      const defaultWindow = selectedWindows.size === 1 ? [...selectedWindows][0] : callbacks.windowId();
      windowSelect.value = String(ids.includes(defaultWindow ?? -1) ? defaultWindow : ids.includes(callbacks.windowId()) ? callbacks.windowId() : ids[0]);
      const groups = [...fresh.browserGroups ?? []].sort((a, b) => a.title.localeCompare(b.title) || a.windowId - b.windowId || a.id - b.id);
      groups.forEach(group => destination.add(new Option(`${browserGroupLabel(group, windowLabel(group.windowId))} · ${group.color}`, String(group.id))));
      if (groups.length) destination.value = String(groups[0].id);
      output.textContent = fresh.groupingAvailable ? '' : 'Browser tab grouping is unavailable in this browser.';
      update();
    } catch (error) { if (dialog.open && token === generation) output.textContent = error instanceof Error ? error.message : String(error); }
  }
  destination.addEventListener('change', () => { update(); if (destination.value === 'new') name.focus(); });
  windowSelect.addEventListener('change', update);
  name.addEventListener('input', update);
  dialog.addEventListener('cancel', event => { if (submitting) event.preventDefault(); });
  dialog.addEventListener('close', () => { generation++; element('results').focus({ preventScroll: true }); });
  element('group-cancel').addEventListener('click', () => { if (!submitting) dialog.close(); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled || submitting || callbacks.busy()) return;
    const target: GroupDestination = destination.value === 'new' ? { name: name.value.trim(), windowId: Number(windowSelect.value) } : { groupId: Number(destination.value) };
    submitting = true; callbacks.setBusy(true);
    form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button').forEach(control => { control.disabled = true; });
    output.textContent = 'Grouping…';
    try {
      const result = await request<GroupResult>({ type: 'group-tabs', targets, destination: target });
      callbacks.clearSelection(); dialog.close();
      callbacks.status(result.warning ?? `${result.grouped} tab${result.grouped === 1 ? '' : 's'} grouped.`);
    } catch (error) { output.textContent = error instanceof Error ? error.message : String(error); }
    finally {
      submitting = false; callbacks.setBusy(false);
      form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button').forEach(control => { control.disabled = false; });
      update(); await callbacks.refresh();
      if (!dialog.open) element('results').focus({ preventScroll: true });
    }
  });
  element('group-selected').addEventListener('click', () => { void open(); });
  return () => { void open(); };
}
