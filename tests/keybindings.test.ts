import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_BINDINGS, matchesBinding, normalizeBinding, validateBindings } from '../src/keybindings';

test('keyboard settings migrate defaults, normalize modifiers, and reject conflicts or invalid keys', () => {
  assert.deepEqual(validateBindings(), DEFAULT_BINDINGS);
  assert.equal(normalizeBinding('shift + ctrl + k'), 'Ctrl+Shift+K');
  assert.equal(validateBindings({ closeSelected: 'delete', clearSearch: 'Ctrl+L' }).closeSelected, 'Delete');
  assert.equal(validateBindings({ closeSelected: '' }).closeSelected, '');
  assert.throws(() => validateBindings({ closeSelected: 'Escape' }), /more than once/);
  for (const value of ['Ctrl+Ctrl+K', 'Tab', 'Ctrl+', 'Invalid']) assert.throws(() => normalizeBinding(value), /Invalid shortcut/);
});

test('bindings match exact modifiers, Space and letter case, and ignore composing events', () => {
  const event = (key: string, changes = {}) => ({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, ...changes }) as KeyboardEvent;
  assert.equal(matchesBinding(event(' '), 'Space'), true);
  assert.equal(matchesBinding(event('k', { ctrlKey: true }), 'Ctrl+K'), true);
  assert.equal(matchesBinding(event('K', { ctrlKey: true, shiftKey: true }), 'Ctrl+K'), false);
  assert.equal(matchesBinding(event('Escape', { isComposing: true }), 'Escape'), false);
  assert.equal(matchesBinding(event('Escape'), ''), false);
});
