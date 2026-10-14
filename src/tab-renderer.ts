import { groupColor } from './browser-groups';
import { create } from './dom';
import { faviconSource } from './favicon';
import { selectable } from './model';
import type { BrowserGroup, Filters, GroupMode, Ranges, SearchResult, TabGroup, TabRecord } from './types';

interface TabCallbacks {
  filters(): Filters;
  group(): GroupMode;
  selected(id: number): boolean;
  browserGroup(id: number): BrowserGroup | undefined;
  toggle(tab: TabRecord, checked: boolean, range: boolean): void;
  selectTabs(tabs: TabRecord[], checked: boolean): void;
  activate(id: number): Promise<void>;
  focus(id: number): void;
  hover(id: number): void;
  openDomain(name: string): void;
}

function highlighted(text: string, ranges: Ranges | null | undefined, className: string): HTMLSpanElement {
  const span = create('span', { className });
  let offset = 0;
  for (const [start, end] of ranges ?? []) {
    span.append(document.createTextNode(text.slice(offset, start)));
    span.append(create('mark', {}, text.slice(start, end + 1)));
    offset = end + 1;
  }
  span.append(document.createTextNode(text.slice(offset)));
  return span;
}

export function createTabRenderer(callbacks: TabCallbacks) {
  function tabIcon(tab: TabRecord | undefined): HTMLImageElement {
    const fallback = typeof browser === 'undefined' ? './tab.svg' : browser.runtime.getURL('tab.svg');
    const icon = create('img', { className: 'tab-icon', alt: '', loading: 'lazy', decoding: 'async', draggable: false, referrerPolicy: 'no-referrer', src: faviconSource(tab?.favIconUrl, fallback) });
    icon.addEventListener('error', () => { icon.src = fallback; }, { once: true });
    return icon;
  }

  function row(result: SearchResult): HTMLDivElement {
    const tab = result.item;
    const disabled = !selectable(tab, callbacks.filters());
    const timestamp = callbacks.group() === 'opened' ? tab.openedAt : tab.lastAccessed;
    const badges = [tab.pinned ? 'Pinned' : '', tab.audible ? 'Audio' : '', tab.hidden ? 'Hidden' : '', tab.discarded ? 'Unloaded' : 'Loaded'].filter(Boolean).join(' · ');
    const nativeGroup = tab.groupId !== undefined && tab.groupId !== -1 ? callbacks.browserGroup(tab.groupId) : undefined;
    const groupName = nativeGroup ? nativeGroup.title.trim() || 'Unnamed group' : 'Grouped';
    const titleLine = create('span', { className: 'tab-title-line' }, highlighted(tab.title || tab.url || 'Untitled', result.matches?.[0], 'tab-title'));
    if (tab.groupId !== undefined && tab.groupId !== -1) {
      const dot = create('span', { className: 'tab-group-dot', ariaHidden: 'true' });
      dot.style.backgroundColor = groupColor(nativeGroup?.color ?? 'grey');
      titleLine.append(create('span', {
        className: 'tab-group-badge', title: `Browser group: ${groupName} (#${tab.groupId})`,
      }, dot, create('span', { className: 'tab-group-name' }, groupName)));
    }
    const selection = create('button', {
      type: 'button', className: 'tab-select', ariaLabel: `Select ${tab.title || tab.url || 'Untitled'}${tab.groupId !== undefined && tab.groupId !== -1 ? ` · Browser group: ${groupName}` : ''}`,
      ariaPressed: String(callbacks.selected(tab.id)), disabled,
      title: disabled ? 'Use Include to select pinned or audible tabs.' : `${tab.title}\n${tab.url}`,
      onfocus: () => callbacks.focus(tab.id),
    },
      titleLine,
      create('span', { className: 'tab-meta' }, highlighted(tab.url, result.matches?.[1], 'tab-url'),
        create('span', { className: 'badges', title: 'Loaded/unloaded describes tab state, not RAM usage.' }, badges)));
    const open = create('button', {
      type: 'button', className: 'tab-open', title: 'Go to tab', ariaLabel: `Go to ${tab.title || tab.url || 'Untitled'}`,
      onclick: event => { event.stopPropagation(); void callbacks.activate(tab.id); },
      onfocus: () => callbacks.focus(tab.id),
    }, create('span', { ariaHidden: 'true' }, '↗'));
    return create('div', {
      className: 'tab-row', data: { id: String(tab.id) },
      onmouseenter: () => { callbacks.hover(tab.id); },
      onclick: event => {
        if (disabled || (event.target as HTMLElement).closest('.tab-open')) return;
        selection.focus({ preventScroll: true });
        callbacks.toggle(tab, !callbacks.selected(tab.id), event.shiftKey);
      },
    }, open, tabIcon(tab), selection,
      create('span', { className: 'tab-age', title: timestamp === undefined ? 'Timestamp unavailable' : `${callbacks.group() === 'opened' ? 'Opened' : 'Last accessed'}: ${new Date(timestamp).toLocaleString()}` },
        timestamp === undefined ? 'Unknown' : new Date(timestamp).toLocaleDateString()));
  }

  function groupCheckbox(group: TabGroup): HTMLInputElement {
    const eligible = group.results.map(result => result.item).filter(tab => selectable(tab, callbacks.filters()));
    const checkbox = create('input', {
      type: 'checkbox', data: { group: group.name, ids: eligible.map(tab => tab.id).join(',') }, disabled: !eligible.length,
      ariaLabel: `Select ${group.name} group`, onchange: () => callbacks.selectTabs(eligible, checkbox.checked),
    });
    return checkbox;
  }

  function domainFolder(group: TabGroup): HTMLDivElement {
    const checkbox = groupCheckbox(group);
    const unloaded = group.results.filter(result => result.item.discarded).length;
    return create('div', { className: 'domain-card', data: { ids: checkbox.dataset.ids } }, checkbox, tabIcon(group.results[0]?.item),
      create('button', { className: 'domain-open', title: group.name, onclick: () => { callbacks.openDomain(group.name); } },
        create('span', { className: 'tab-title' }, group.name), create('span', { className: 'muted' }, `${group.results.length} tabs`),
        create('span', { className: 'domain-state muted', title: 'Tab state only; Firefox does not expose per-tab RAM usage to extensions.' }, `${group.results.length - unloaded} loaded · ${unloaded} unloaded`)));
  }

  return { row, groupCheckbox, domainFolder };
}
