import { request } from './client';
import { create, element } from './dom';
import { DEFAULT_BINDINGS, KEY_LABELS, validateBindings } from './keybindings';
import type { KeyAction } from './keybindings';
import { parseTopics } from './model';
import type { Preferences } from './types';

interface SettingsCallbacks {
  preferences(): Preferences;
  containers(): boolean;
  setContainers(enabled: boolean): void;
  saved(preferences: Preferences): void;
}

export function installSettings(callbacks: SettingsCallbacks): void {
  const settingsDialog = element<HTMLDialogElement>('settings-dialog');
  const settingsStatus = element<HTMLParagraphElement>('settings-status');
  element('memory-diagnostics').addEventListener('click', () => {
    const address = element<HTMLInputElement>('memory-address');
    address.focus(); address.select();
    void navigator.clipboard?.writeText(address.value).then(() => { settingsStatus.textContent = 'Address copied. Paste it into the address bar to open memory diagnostics.'; }).catch(() => { settingsStatus.textContent = 'Copy the selected address and paste it into the address bar.'; });
  });
  element('settings-open').addEventListener('click', () => {
    element<HTMLTextAreaElement>('topic-rules').value = callbacks.preferences().topics.map(rule => `${rule.name}: ${rule.keywords.join(', ')}`).join('\n');
    element<HTMLInputElement>('preserve-containers').checked = callbacks.containers();
    renderBindingSettings();
    settingsStatus.textContent = ''; settingsDialog.showModal();
    element('shortcut-status').textContent = '';
    void loadShortcut().catch(error => { element('shortcut-status').textContent = String(error); });
  });
  function renderBindingSettings(reset = false): void {
    const list = element('keybindings'); list.replaceChildren();
    const bindings = reset ? DEFAULT_BINDINGS : { ...DEFAULT_BINDINGS, ...callbacks.preferences().keybindings };
    for (const action of Object.keys(DEFAULT_BINDINGS) as KeyAction[]) {
      list.append(create('label', {}, KEY_LABELS[action], create('input', { type: 'text', data: { action }, value: bindings[action], autocomplete: 'off', spellcheck: false })));
    }
  }
  element('bindings-reset').addEventListener('click', () => { renderBindingSettings(true); });
  async function loadShortcut(): Promise<void> {
    const command = (await browser.commands.getAll()).find(command => command.name === 'open-dashboard');
    element<HTMLInputElement>('shortcut').value = command?.shortcut ?? '';
  }
  async function updateShortcut(reset: boolean): Promise<void> {
    const output = element('shortcut-status');
    const buttons = ['shortcut-update', 'shortcut-reset'].map(id => element<HTMLButtonElement>(id));
    buttons.forEach(button => { button.disabled = true; });
    try {
      if (reset) await browser.commands.reset('open-dashboard');
      else await browser.commands.update({ name: 'open-dashboard', shortcut: element<HTMLInputElement>('shortcut').value.trim() });
      await loadShortcut();
      output.textContent = element<HTMLInputElement>('shortcut').value ? 'Shortcut updated.' : 'Shortcut disabled.';
    } catch (error) { output.textContent = error instanceof Error ? error.message : String(error); }
    finally { buttons.forEach(button => { button.disabled = false; }); }
  }
  element('shortcut-update').addEventListener('click', () => { void updateShortcut(false); });
  element('shortcut-reset').addEventListener('click', () => { void updateShortcut(true); });
  element('preserve-containers').addEventListener('change', async event => {
    const checkbox = event.target as HTMLInputElement;
    checkbox.disabled = true;
    try {
      if (checkbox.checked) checkbox.checked = await browser.permissions.request({ permissions: ['cookies'] });
      else await browser.permissions.remove({ permissions: ['cookies'] });
      callbacks.setContainers(checkbox.checked);
      settingsStatus.textContent = checkbox.checked ? 'Container recovery enabled.' : 'Container recovery disabled.';
    } catch (error) { checkbox.checked = callbacks.containers(); settingsStatus.textContent = String(error); }
    finally { checkbox.disabled = false; }
  });
  element('save-settings').addEventListener('click', async () => {
    try {
      const keybindings = validateBindings(Object.fromEntries([...settingsDialog.querySelectorAll<HTMLInputElement>('input[data-action]')].map(input => [input.dataset.action, input.value])));
      const updated = { ...callbacks.preferences(), keybindings, topics: parseTopics(element<HTMLTextAreaElement>('topic-rules').value) };
      await request({ type: 'preferences', preferences: updated });
      callbacks.saved(updated); settingsDialog.close();
    } catch (error) { settingsStatus.textContent = error instanceof Error ? error.message : String(error); }
  });
}
