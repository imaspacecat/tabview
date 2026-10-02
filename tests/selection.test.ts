import assert from 'node:assert/strict';
import { test } from 'node:test';
import { faviconSource } from '../src/favicon';
import { directionalNeighbor } from '../src/navigation';
import { intersectingIds, selectionBounds } from '../src/selection';

test('rectangle selection works in either drag direction and across multiple columns', () => {
  const items = [
    { id: 1, left: 0, top: 0, right: 100, bottom: 40 },
    { id: 2, left: 110, top: 0, right: 210, bottom: 40 },
    { id: 3, left: 0, top: 50, right: 100, bottom: 90 },
    { id: 4, left: 110, top: 50, right: 210, bottom: 90 },
  ];
  const bounds = selectionBounds({ x: 200, y: 80 }, { x: 10, y: 10 });
  assert.deepEqual(intersectingIds(bounds, items), [1, 2, 3, 4]);
  assert.deepEqual(intersectingIds({ left: 100, right: 110, top: 0, bottom: 90 }, items), []);
  assert.equal(directionalNeighbor(1, items, 'right'), 2);
  assert.equal(directionalNeighbor(1, items, 'down'), 3);
  assert.equal(directionalNeighbor(4, items, 'up'), 2);
  assert.equal(directionalNeighbor(4, items, 'left'), 3);
  assert.equal(directionalNeighbor(1, items, 'up'), 1);
});

test('favicons use supported browser URLs and fall back for privileged or missing icons', () => {
  const fallback = 'moz-extension://test/tab.svg';
  assert.equal(faviconSource('https://example.com/favicon.ico', fallback), 'https://example.com/favicon.ico');
  assert.equal(faviconSource('data:image/png;base64,AA==', fallback), 'data:image/png;base64,AA==');
  for (const source of [undefined, 'chrome://global/icon.svg', 'resource://icon.svg', 'javascript:alert(1)', 'data:text/html,test', 'moz-extension://other/icon.svg', 'invalid']) assert.equal(faviconSource(source, fallback), fallback);
});
