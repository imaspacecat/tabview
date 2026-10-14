import { resolveBindings, matchesBinding } from './keybindings';
import type { KeyAction, KeyBindings } from './keybindings';
import { directionalNeighbor } from './navigation';
import type { TabRecord } from './types';

interface KeyboardState {
  bindings?: KeyBindings;
  visible: TabRecord[];
  focusedId?: number;
  grid: boolean;
  canClose: boolean;
  canGroup: boolean;
}
interface KeyboardCallbacks {
  state(): KeyboardState;
  pointerMoved(moved: boolean): void;
  clearSelection(): void;
  closeSelected(): void;
  groupSelected(): void;
  focus(id: number | undefined, scroll: boolean): void;
  activate(id: number): Promise<void>;
  toggleSelection(id: number, range: boolean): void;
  clearSearch(): void;
}

export function installKeyboard(search: HTMLInputElement, results: HTMLElement, callbacks: KeyboardCallbacks): void {
  document.addEventListener('mousemove', () => { callbacks.pointerMoved(true); });
  document.addEventListener('keydown', event => {
    callbacks.pointerMoved(false);
    const { bindings: overrides, visible, focusedId, grid, canClose, canGroup } = callbacks.state();
    if (document.querySelector('dialog[open]') || event.isComposing) return;
    const bindings = resolveBindings(overrides);
    const matches = (action: KeyAction) => matchesBinding(event, bindings[action]);
    const active = document.activeElement;
    const editable = active?.matches('input:not([type=checkbox]), textarea, select, [contenteditable]:not([contenteditable=false])') || active?.closest('[contenteditable=true]');
    if (active?.classList.contains('tab-open') && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && ['Enter', ' '].includes(event.key)) return;
    if (active === search && !event.ctrlKey && !event.altKey && !event.metaKey && (event.key.length === 1 || ['Backspace', 'Delete', 'Home', 'End', 'ArrowLeft', 'ArrowRight'].includes(event.key))) return;
    if (matches('clearSelection') && (!editable || active === search)) {
      event.preventDefault();
      callbacks.clearSelection(); return;
    }
    if (matches('groupSelected') && !editable && !event.repeat && canGroup) {
      event.preventDefault(); callbacks.groupSelected(); return;
    }
    if (matches('closeSelected') && !editable && !event.repeat && canClose) {
      event.preventDefault();
      callbacks.closeSelected();
      return;
    }
    if (active !== search && active !== results && !active?.closest('.tab-row')) return;
    const direction = (['up', 'down', 'left', 'right'] as const).find(matches);
    if (direction || matches('next') || matches('previous')) {
      event.preventDefault();
      const delta = direction === 'down' || direction === 'right' || matches('next') ? 1 : -1;
      const index = visible.findIndex(tab => tab.id === focusedId);
      const neighboring = grid && direction && focusedId !== undefined ? directionalNeighbor(focusedId, [...results.querySelectorAll<HTMLElement>('.tab-row')].map(row => ({ id: Number(row.dataset.id), ...rectCoordinates(row.getBoundingClientRect()) })), direction) : undefined;
      const tab = neighboring !== undefined ? visible.find(tab => tab.id === neighboring) : visible[Math.max(0, Math.min(visible.length - 1, index + delta))];
      callbacks.focus(tab?.id, true);
      if (active !== search) {
        const row = results.querySelector<HTMLElement>(`.tab-row[data-id="${tab?.id}"]`);
        (row?.querySelector<HTMLButtonElement>('.tab-select:not(:disabled)') ?? row?.querySelector<HTMLButtonElement>('.tab-open'))?.focus({ preventScroll: true });
      }
    } else if (matches('openTab') && (active === search || active === results || active?.classList.contains('tab-select')) && focusedId !== undefined) {
      event.preventDefault(); void callbacks.activate(focusedId);
    } else if ((matches('toggleSelection') || matches('selectRange')) && (active === results || active?.classList.contains('tab-select')) && focusedId !== undefined) {
      event.preventDefault();
      callbacks.toggleSelection(focusedId, matches('selectRange'));
    } else if (matches('clearSearch')) {
      event.preventDefault(); callbacks.clearSearch();
    } else if (active?.classList.contains('tab-select') && ['Enter', ' '].includes(event.key)) {
      event.preventDefault();
    }
  });

  function rectCoordinates(rect: DOMRect): { left: number; top: number; right: number; bottom: number } {
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  }
}
