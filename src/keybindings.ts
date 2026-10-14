export const DEFAULT_BINDINGS = {
  groupSelected: 'G', clearSelection: 'Escape', closeSelected: 'Backspace', openTab: 'Enter',
  toggleSelection: 'Space', selectRange: 'Shift+Space',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  next: 'Ctrl+N', previous: 'Ctrl+P', clearSearch: '',
};
export type KeyAction = keyof typeof DEFAULT_BINDINGS;
export type KeyBindings = Record<KeyAction, string>;
export const KEY_LABELS: Record<KeyAction, string> = {
  groupSelected: 'Group selected tabs', clearSelection: 'Deselect all / cancel drag', closeSelected: 'Close selected tabs', openTab: 'Open focused tab',
  toggleSelection: 'Toggle focused selection', selectRange: 'Extend selection to focused tab',
  up: 'Move up', down: 'Move down', left: 'Move left', right: 'Move right',
  next: 'Next tab', previous: 'Previous tab', clearSearch: 'Clear search',
};
const modifiers = ['Ctrl', 'Alt', 'Shift', 'Meta'];
const namedKeys = ['Escape', 'Backspace', 'Delete', 'Enter', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)];

export function normalizeBinding(value: string): string {
  if (typeof value !== 'string') throw new Error('Shortcuts must be text.');
  if (!value.trim()) return '';
  const parts = value.trim().split('+').map(part => part.trim());
  const rawKey = parts.pop()!;
  const key = /^[a-z0-9]$/i.test(rawKey) ? rawKey.toUpperCase() : namedKeys.find(key => key.toLowerCase() === rawKey.toLowerCase());
  const mods = parts.map(part => modifiers.find(mod => mod.toLowerCase() === part.toLowerCase()));
  if (!key || mods.some(mod => !mod) || new Set(mods).size !== mods.length) throw new Error(`Invalid shortcut: ${value}. Use a key like Escape or Ctrl+Shift+K.`);
  return [...modifiers.filter(mod => mods.includes(mod)), key].join('+');
}

export function resolveBindings(value: Partial<KeyBindings> = {}): KeyBindings {
  // Preserve a pre-existing G shortcut when upgrading older saved settings.
  const legacyG = value.groupSelected === undefined && Object.entries(value).some(([action, binding]) => action !== 'groupSelected' && typeof binding === 'string' && binding.trim().toUpperCase() === 'G');
  return { ...DEFAULT_BINDINGS, ...value, groupSelected: value.groupSelected ?? (legacyG ? '' : DEFAULT_BINDINGS.groupSelected) };
}

export function validateBindings(value: Partial<KeyBindings> = {}): KeyBindings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid keyboard settings.');
  const bindings = resolveBindings(value);
  const used = new Set<string>();
  for (const action of Object.keys(bindings) as KeyAction[]) {
    const binding = normalizeBinding(value[action] ?? bindings[action]);
    if (binding && used.has(binding)) throw new Error(`Shortcut ${binding} is assigned more than once.`);
    bindings[action] = binding;
    if (binding) used.add(binding);
  }
  return bindings;
}

export function matchesBinding(event: KeyboardEvent, binding: string): boolean {
  if (!binding || event.isComposing) return false;
  const key = event.key === ' ' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  const chord = [event.ctrlKey ? 'Ctrl' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '', event.metaKey ? 'Meta' : '', key].filter(Boolean).join('+');
  return chord === binding;
}
