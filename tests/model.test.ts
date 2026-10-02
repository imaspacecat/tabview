import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DAY, dateBucket, domain, groupResults, parseTopics, searchTabs, selectable, selectRange, topic } from '../src/model';
import { filters, tab } from './helpers';

test('search matches titles and URLs, highlights matches, and ranks exact titles first', () => {
  const results = searchTabs([tab(1, { title: 'GitHub', url: 'https://example.com' }), tab(2, { title: 'Elsewhere', url: 'https://github.com/project' }), tab(3, { title: 'Unrelated' })], { ...filters, query: 'github' });
  assert.deepEqual(results.map(result => result.item.id), [1, 2]);
  assert.deepEqual(results[0].matches?.[0], [[0, 5]]);
  assert.ok(results[1].matches?.[1]?.length);
  assert.deepEqual(searchTabs([tab(1, { title: 'Mozilla Developer Network' })], { ...filters, query: 'mdn' }).map(result => result.item.id), [1]);
});

test('empty search is recent first, with unknown access last', () => {
  assert.deepEqual(searchTabs([tab(1), tab(2, { lastAccessed: 20 }), tab(3, { lastAccessed: 50 })], filters).map(result => result.item.id), [3, 2, 1]);
});

test('date buckets use local midnight and consistent week/month boundaries', () => {
  const now = new Date(2026, 9, 1, 12).getTime();
  assert.equal(dateBucket(undefined, now), 'Unknown');
  assert.equal(dateBucket(Number.NaN, now), 'Unknown');
  assert.equal(dateBucket(new Date(2026, 9, 1, 0).getTime(), now), 'Today');
  assert.equal(dateBucket(now - 7 * DAY, now), 'Previous 7 days');
  assert.equal(dateBucket(now - 7 * DAY - 1, now), 'Previous 30 days');
  assert.equal(dateBucket(now - 30 * DAY, now), 'Previous 30 days');
  assert.equal(dateBucket(now - 30 * DAY - 1, now), 'Older');
});

test('window and age filters compose and keep unknown access explicit', () => {
  const now = Date.now();
  const tabs = [tab(1, { windowId: 1, lastAccessed: now - 8 * DAY }), tab(2, { windowId: 2, lastAccessed: now - 8 * DAY }), tab(3)];
  assert.deepEqual(searchTabs(tabs, { ...filters, windowId: 1, age: '7' }, now).map(result => result.item.id), [1]);
  assert.deepEqual(searchTabs(tabs, { ...filters, age: 'unknown' }, now).map(result => result.item.id), [3]);
});

test('groups use hostname and ordered topic rules without changing tabs', () => {
  const rules = parseTopics('Research: study, paper\nDevelopment: github, docs');
  assert.equal(topic(tab(1, { title: 'Study docs', url: 'https://github.com' }), rules), 'Research');
  assert.equal(topic(tab(2, { title: 'Other' }), rules), 'Uncategorized');
  assert.throws(() => parseTopics('Missing separator'), /Line 1/);
  assert.throws(() => parseTopics('Empty:'), /Line 1/);
  const records = [tab(1, { url: 'https://a.example.com/x' }), tab(2, { url: 'https://a.example.com/y' }), tab(3, { url: 'about:blank' })];
  const original = structuredClone(records);
  assert.deepEqual(groupResults(searchTabs(records, filters), 'domain', []).map(group => group.results.length), [2, 1]);
  assert.equal(domain('about:blank'), 'about: pages');
  assert.deepEqual(records, original);
  assert.equal(groupResults(searchTabs(records, filters), 'opened', [])[0].name, 'Unknown');
});

test('bulk eligibility protects pinned/audio tabs and range selection is inclusive', () => {
  assert.equal(selectable(tab(1, { pinned: true }), filters), false);
  assert.equal(selectable(tab(1, { audible: true }), filters), false);
  assert.equal(selectable(tab(1, { pinned: true }), { ...filters, includePinned: true }), true);
  assert.deepEqual(selectRange([3, 2, 1], 3, 1), [3, 2, 1]);
  assert.deepEqual(selectRange([3, 2, 1], undefined, 2), [2]);
  assert.deepEqual(selectRange([3, 2, 1], 99, 2), [2]);
});

test('search and grouping 1,000 tabs complete well under one second', () => {
  const tabs = Array.from({ length: 1000 }, (_, id) => tab(id, { title: `Project ${id} developer notes` }));
  const start = performance.now();
  const matches = searchTabs(tabs, { ...filters, query: 'dev notes' });
  assert.equal(matches.length, 1000);
  assert.equal(groupResults(matches, 'domain', []).length, 1);
  assert.ok(performance.now() - start < 1000);
});
