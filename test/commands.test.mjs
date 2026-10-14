import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Commands, normalizeCombo, eventToCombo, eventToHotkey, formatHotkey } from '../src/renderer/core/commands.js';

function keyEvent(key, options = {}) {
  return {
    key, code: key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key,
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    prevented: 0, stopped: 0, immediate: 0,
    preventDefault() { this.prevented++; },
    stopPropagation() { this.stopped++; },
    stopImmediatePropagation() { this.immediate++; },
    ...options,
  };
}

function registry(config) {
  const calls = [];
  const commands = new Commands(config);
  commands.add({ id: 'new', name: 'Criar nota', hotkeys: ['Mod+N'], run: () => calls.push('new') });
  commands.add({ id: 'open', name: 'Abrir nota', hotkeys: ['Mod+O'], run: () => calls.push('open') });
  return { commands, calls };
}

test('default hotkeys dispatch once, respect availability and preserve command definitions', () => {
  const { commands, calls } = registry();
  try {
    const event = keyEvent('n', { ctrlKey: true });
    commands.onKeyDown(event);
    assert.deepEqual(calls, ['new']);
    assert.equal(event.prevented, 1);
    assert.equal(event.stopped, 1);
    commands.onKeyDown(keyEvent('n', { ctrlKey: true, repeat: true }));
    commands.onKeyDown(keyEvent('n', { ctrlKey: true, isComposing: true }));
    assert.deepEqual(calls, ['new']);
    commands.commands.get('new').isAvailable = () => false;
    commands.onKeyDown(keyEvent('n', { ctrlKey: true }));
    assert.deepEqual(commands.list().map((command) => command.id), ['open']);
    assert.deepEqual(calls, ['new']);
    const keys = commands.getHotkeys('open');
    keys.push('Mod+X');
    assert.deepEqual(commands.getHotkeys('open'), ['Mod+O']);
    assert.deepEqual(commands.commands.get('open').hotkeys, ['Mod+O']);
  } finally { commands.destroy(); }
});

test('overrides replace defaults, deduplicate, remove all bindings and restore defaults', () => {
  const { commands, calls } = registry();
  try {
    assert.equal(commands.isCustomized('new'), false);
    commands.setHotkeys('new', ['Mod+Shift+J', 'Control+Shift+J', null, 'Shift+']);
    assert.deepEqual(commands.getHotkeys('new'), ['Mod+Shift+J']);
    commands.addHotkey('new', 'Alt+K');
    commands.onKeyDown(keyEvent('n', { ctrlKey: true }));
    commands.onKeyDown(keyEvent('j', { ctrlKey: true, shiftKey: true }));
    assert.deepEqual(calls, ['new']);
    assert.equal(commands.isCustomized('new'), true);
    commands.removeHotkey('new', 'ctrl+shift+j');
    commands.removeHotkey('new', 'alt+k');
    assert.deepEqual(commands.getHotkeys('new'), []);
    commands.onKeyDown(keyEvent('n', { ctrlKey: true }));
    assert.deepEqual(calls, ['new']);
    commands.resetHotkeys('new');
    assert.equal(commands.isCustomized('new'), false);
    assert.deepEqual(commands.getHotkeys('new'), ['Mod+N']);
    commands.onKeyDown(keyEvent('n', { ctrlKey: true }));
    assert.deepEqual(calls, ['new', 'new']);
    assert.equal(commands.addHotkey('missing', 'Mod+J'), false);
  } finally { commands.destroy(); }
});

test('ConfigFile writes sparse hotkey overrides and restores them only in the same vault', async () => {
  const files = new Map();
  let activeVault = 'one';
  const previousWindow = globalThis.window;
  globalThis.window = { basalto: { vault: {
    readConfig: async (name) => structuredClone(files.get(`${activeVault}/${name}`) || null),
    writeConfig: async (name, data) => { files.set(`${activeVault}/${name}`, structuredClone(data)); },
  } } };
  let ConfigFile;
  try {
    ({ ConfigFile } = await import('../src/renderer/core/settings.js?hotkey-persistence-test'));
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }

  const config = new ConfigFile('hotkeys.json', {});
  await config.load();
  const first = registry(config).commands;
  first.setHotkeys('new', ['Mod+Shift+J']);
  first.setHotkeys('open', []);
  await config.save();
  first.destroy();
  assert.deepEqual(files.get('one/hotkeys.json'), { new: ['Mod+Shift+J'], open: [] });

  const reloaded = new ConfigFile('hotkeys.json', {});
  await reloaded.load();
  const reopened = registry(reloaded).commands;
  assert.deepEqual(reopened.getHotkeys('new'), ['Mod+Shift+J']);
  assert.deepEqual(reopened.getHotkeys('open'), []);
  reopened.resetHotkeys('new');
  await reloaded.save();
  reopened.destroy();
  assert.deepEqual(files.get('one/hotkeys.json'), { open: [] });

  activeVault = 'two';
  const other = new ConfigFile('hotkeys.json', {});
  await other.load();
  const isolated = registry(other).commands;
  assert.deepEqual(isolated.getHotkeys('open'), ['Mod+O']);
  isolated.destroy();
});

test('conflicting combinations are reported and never choose an arbitrary available command', () => {
  const { commands, calls } = registry();
  try {
    commands.setHotkeys('open', ['Ctrl+N']);
    assert.deepEqual(commands.conflictsFor('new', 'Mod+N').map((command) => command.id), ['open']);
    const event = keyEvent('n', { ctrlKey: true });
    commands.onKeyDown(event);
    assert.deepEqual(calls, []);
    assert.equal(event.prevented, 1);
    commands.commands.get('open').isAvailable = () => false;
    commands.onKeyDown(keyEvent('n', { ctrlKey: true }));
    assert.deepEqual(calls, ['new']);
    commands.removeHotkey('open', 'Mod+N');
    assert.deepEqual(commands.conflictsFor('new', 'Mod+N'), []);
  } finally { commands.destroy(); }
});

test('capture consumes shortcuts before commands, ignores held modifiers, and Escape cancels', () => {
  const { commands, calls } = registry();
  const captured = [];
  try {
    commands.captureHotkey((hotkey) => captured.push(hotkey));
    assert.equal(commands.isCapturing, true);
    const modifier = keyEvent('Control', { ctrlKey: true });
    commands.onKeyDown(modifier);
    commands.onKeyDown(keyEvent('n', { ctrlKey: true, repeat: true }));
    assert.equal(commands.isCapturing, true);
    const event = keyEvent('n', { ctrlKey: true });
    commands.onKeyDown(event);
    assert.equal(event.immediate, 1);
    assert.deepEqual(calls, []);
    assert.deepEqual(captured, ['Mod+N']);
    assert.equal(commands.isCapturing, false);
    commands.captureHotkey((hotkey) => captured.push(hotkey));
    commands.onKeyDown(keyEvent('Escape'));
    assert.deepEqual(captured, ['Mod+N', null]);
    assert.deepEqual(calls, []);
    const cancel = commands.captureHotkey((hotkey) => captured.push(hotkey));
    cancel();
    assert.equal(commands.isCapturing, false);
    commands.onKeyDown(keyEvent('n', { ctrlKey: true }));
    assert.deepEqual(calls, ['new']);
  } finally { commands.destroy(); }
});

test('local controls retain F2 and typing keys while modified global shortcuts still work', () => {
  const { commands, calls } = registry();
  try {
    commands.add({ id: 'rename', name: 'Renomear', hotkeys: ['F2'], run: () => calls.push('rename') });
    commands.add({ id: 'letter', name: 'Letra', hotkeys: ['Q'], run: () => calls.push('letter') });
    const modal = { closest: (selector) => selector.includes('.modal-backdrop') };
    const bookmark = { closest: (selector) => selector.includes('.bookmark-row') };
    const input = { closest: (selector) => selector.includes('textarea') };
    commands.onKeyDown(keyEvent('F2', { target: modal }));
    commands.onKeyDown(keyEvent('F2', { target: bookmark }));
    commands.onKeyDown(keyEvent('q', { target: input }));
    assert.deepEqual(calls, []);
    commands.onKeyDown(keyEvent('n', { target: modal, ctrlKey: true }));
    commands.onKeyDown(keyEvent('F2', { target: input }));
    assert.deepEqual(calls, ['new', 'rename']);
  } finally { commands.destroy(); }
});

test('physical key capture is stable for shifted punctuation, space and keyboard layouts', () => {
  assert.equal(eventToHotkey(keyEvent('+', { code: 'Equal', ctrlKey: true, shiftKey: true })), 'Mod+Shift+=');
  assert.equal(eventToCombo(keyEvent('?', { code: 'Slash', ctrlKey: true, shiftKey: true })), normalizeCombo('Mod+Shift+/'));
  assert.equal(eventToHotkey(keyEvent(' ', { code: 'Space', altKey: true })), 'Alt+Space');
  assert.equal(eventToHotkey(keyEvent('й', { code: 'KeyQ', ctrlKey: true })), 'Mod+Q');
  assert.equal(eventToCombo(keyEvent('Dead')), null);
  assert.equal(eventToHotkey(keyEvent('q', { ctrlKey: true, altKey: true, getModifierState: () => true })), null);
  assert.equal(normalizeCombo('Shift+Mod+Q'), normalizeCombo('Control+Shift+q'));
  assert.equal(normalizeCombo('Ctrl++'), normalizeCombo('Ctrl+Plus'));
  assert.equal(formatHotkey('Mod+Shift+Space'), 'Ctrl+Shift+Espaço');
});
