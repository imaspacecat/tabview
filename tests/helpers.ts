import type { Filters, TabRecord } from '../src/types';

export const filters: Filters = { query: '', windowId: 'all', age: 'all', includePinned: false, includeAudible: false };
export function tab(id: number, changes: Partial<TabRecord> = {}): TabRecord {
  return { id, key: `key-${id}`, windowId: 1, index: id, title: `Tab ${id}`, url: `https://example.com/${id}`, pinned: false, audible: false, hidden: false, discarded: false, ...changes };
}
