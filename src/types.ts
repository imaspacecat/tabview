import type { KeyBindings } from './keybindings';
export interface TabRecord extends Required<Pick<browser.tabs.Tab, 'id' | 'windowId' | 'index' | 'title' | 'url' | 'pinned' | 'audible' | 'hidden' | 'discarded'>>, Pick<browser.tabs.Tab, 'lastAccessed' | 'cookieStoreId' | 'favIconUrl'> {
  key: string;
  openedAt?: number;
}

export type GroupMode = 'none' | 'domain' | 'opened' | 'accessed' | 'topic';
export interface TopicRule { name: string; keywords: string[] }
export type SortMode = 'recent' | 'loaded' | 'unloaded';
export interface Preferences { group: GroupMode; topics: TopicRule[]; layout?: 'grid' | 'list'; sort?: SortMode; keybindings?: KeyBindings }
export const DEFAULT_PREFERENCES: Preferences = { group: 'none', topics: [], layout: 'grid' };
export interface Filters {
  query: string;
  windowId: number | 'all';
  age: 'all' | '7' | '30' | 'unknown';
  includePinned: boolean;
  includeAudible: boolean;
}
export type Ranges = [number, number][];
export interface SearchResult { item: TabRecord; matches?: (Ranges | null)[] }
export interface TabGroup { name: string; results: SearchResult[] }
export interface CloseTarget { id: number; key: string; url: string }
export type RecoveryStatus = 'pending' | 'closed' | 'failed' | 'uncertain' | 'reopening' | 'reopen-uncertain' | 'reopened';
export interface RecoveryEntry {
  tab: TabRecord;
  status: RecoveryStatus;
  error?: string;
  reopenedTabId?: number;
}
export interface RecoveryBatch { id: string; createdAt: number; entries: RecoveryEntry[] }
export interface CloseResult { closed: number; skipped: number; failed: number; interrupted: boolean }
export interface RestoreResult { reopened: number; failed: number }
export interface Snapshot { tabs: TabRecord[]; preferences: Preferences; containers: boolean }
export type Request =
  | { type: 'snapshot' }
  | { type: 'activate'; id: number }
  | { type: 'preferences'; preferences: Preferences }
  | { type: 'close'; targets: CloseTarget[]; includePinned: boolean; includeAudible: boolean }
  | { type: 'recovery' }
  | { type: 'restore'; id: string; windowId: number }
  | { type: 'delete-batch'; id: string };
export type Response<T> = { ok: true; value: T } | { ok: false; error: string };
