import type { BrowserGroup } from './types';

// Firefox's installed type definitions predate the native tab-group API.
interface GroupEvent { addListener(callback: () => void): void }
interface GroupAPI {
  query(query: Record<string, never>): Promise<BrowserGroup[]>;
  get(id: number): Promise<BrowserGroup>;
  update(id: number, properties: { title: string }): Promise<BrowserGroup>;
  onCreated: GroupEvent;
  onUpdated: GroupEvent;
  onRemoved: GroupEvent;
  onMoved: GroupEvent;
}
interface GroupTabsAPI {
  group(options: { tabIds: number[]; groupId?: number; createProperties?: { windowId: number } }): Promise<number>;
}
export function groupingAPI(): { groups: GroupAPI; tabs: GroupTabsAPI } | undefined {
  const groups = (browser as unknown as { tabGroups?: GroupAPI }).tabGroups;
  const tabs = browser.tabs as unknown as GroupTabsAPI;
  return groups && typeof groups.query === 'function' && typeof groups.get === 'function' && typeof groups.update === 'function' && typeof tabs.group === 'function' ? { groups, tabs } : undefined;
}

export function browserGroupLabel(group: BrowserGroup, windowLabel: string): string {
  return `${group.title.trim() || 'Unnamed group'} (#${group.id}) · ${windowLabel}`;
}

export function groupColor(color: string): string {
  const colors: Record<string, string> = { grey: '#808080', blue: '#4285f4', red: '#ea4335', yellow: '#d9a600', green: '#34a853', pink: '#df65a5', purple: '#9b72cf', cyan: '#00a8b5', orange: '#e88024' };
  return colors[color] ?? colors.grey;
}
