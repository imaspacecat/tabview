import microfuzz from '@nozbe/microfuzz';
import type { Filters, GroupMode, SearchResult, TabGroup, TabRecord, TopicRule } from './types';

export const DAY = 86_400_000;
const BUCKETS = ['Today', 'Previous 7 days', 'Previous 30 days', 'Older', 'Unknown'];
const createFuzzySearch: typeof microfuzz = typeof microfuzz === 'function' ? microfuzz : (microfuzz as unknown as { default: typeof microfuzz }).default;

export function dateBucket(time: number | undefined, now = Date.now()): string {
  if (time === undefined || !Number.isFinite(time)) return 'Unknown';
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  if (time >= midnight.getTime()) return 'Today';
  if (time >= now - 7 * DAY) return 'Previous 7 days';
  if (time >= now - 30 * DAY) return 'Previous 30 days';
  return 'Older';
}

export function domain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname || `${parsed.protocol} pages`;
  } catch { return 'Unknown domain'; }
}

export function topic(tab: TabRecord, rules: TopicRule[]): string {
  const text = `${tab.title} ${tab.url}`.toLowerCase();
  return rules.find(rule => rule.keywords.some(word => text.includes(word.toLowerCase())))?.name ?? 'Uncategorized';
}

export function parseTopics(text: string): TopicRule[] {
  return text.split('\n').filter(line => line.trim()).map((line, index) => {
    const colon = line.indexOf(':');
    const name = line.slice(0, colon).trim();
    const keywords = line.slice(colon + 1).split(',').map(word => word.trim()).filter(Boolean);
    if (colon < 1 || !name || !keywords.length) throw new Error(`Line ${index + 1}: use Name: keyword, keyword.`);
    return { name, keywords };
  });
}

export function searchTabs(tabs: TabRecord[], filters: Filters, now = Date.now()): SearchResult[] {
  const candidates = tabs.filter(tab => {
    if (filters.windowId !== 'all' && tab.windowId !== filters.windowId) return false;
    if (filters.age === 'unknown') return tab.lastAccessed === undefined;
    if (filters.age !== 'all' && (tab.lastAccessed === undefined || tab.lastAccessed > now - Number(filters.age) * DAY)) return false;
    return true;
  }).sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0) || a.id - b.id);
  const query = filters.query.trim();
  if (!query) return candidates.map(item => ({ item }));
  return createFuzzySearch(candidates, { getText: tab => [tab.title, tab.url] })(query);
}

export function groupResults(results: SearchResult[], mode: GroupMode, rules: TopicRule[], now = Date.now()): TabGroup[] {
  if (mode === 'none') return [{ name: 'All tabs', results }];
  const groups = new Map<string, TabGroup>();
  for (const result of results) {
    const tab = result.item;
    const name = mode === 'domain' ? domain(tab.url) : mode === 'topic' ? topic(tab, rules) : dateBucket(mode === 'opened' ? tab.openedAt : tab.lastAccessed, now);
    const group = groups.get(name) ?? { name, results: [] };
    group.results.push(result);
    groups.set(name, group);
  }
  return [...groups.values()].sort((a, b) => mode === 'opened' || mode === 'accessed'
    ? BUCKETS.indexOf(a.name) - BUCKETS.indexOf(b.name)
    : a.name === 'Uncategorized' ? 1 : b.name === 'Uncategorized' ? -1 : a.name.localeCompare(b.name));
}

export function selectable(tab: TabRecord, filters: Pick<Filters, 'includePinned' | 'includeAudible'>): boolean {
  return (!tab.pinned || filters.includePinned) && (!tab.audible || filters.includeAudible);
}

export function selectRange(ids: number[], anchor: number | undefined, target: number): number[] {
  const end = ids.indexOf(target);
  const start = anchor === undefined ? end : ids.indexOf(anchor);
  if (end < 0) return [];
  if (start < 0) return [target];
  return ids.slice(Math.min(start, end), Math.max(start, end) + 1);
}
