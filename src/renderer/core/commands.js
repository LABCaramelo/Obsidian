import { Events } from './util.js';

const isMac = globalThis.navigator?.platform?.toUpperCase().includes('MAC') || false;
const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph']);
const KEY_CODES = {
  Space: 'Space', Equal: '=', Minus: '-', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
};
const KEY_LABELS = {
  space: 'Space', escape: 'Escape', enter: 'Enter', tab: 'Tab', backspace: 'Backspace',
  delete: 'Delete', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight', pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End',
  insert: 'Insert', plus: 'Plus',
};

/** Vault-scoped command hotkeys. An empty override disables the defaults. */
export class Commands extends Events {
  constructor(config = null) {
    super();
    this.commands = new Map();
    this.recent = [];
    this.overrides = {};
    this.capture = null;
    this._onKeyDown = (event) => this.onKeyDown(event);
    globalThis.window?.addEventListener('keydown', this._onKeyDown, true);
    if (config) this.setConfig(config);
  }

  setConfig(config) {
    this._offConfig?.();
    this.config = config;
    this.overrides = config?.data || {};
    this._offConfig = config?.on('change', () => {
      this.overrides = config.data;
      this.emit('hotkeys-change');
    });
    this.emit('hotkeys-change');
    return this;
  }

  add(command) {
    this.commands.set(command.id, command);
    this.emit('hotkeys-change');
  }

  list() {
    return [...this.commands.values()].filter((c) => !c.isAvailable || c.isAvailable());
  }

  getHotkeys(id) {
    const override = Object.hasOwn(this.overrides, id) ? this.overrides[id] : null;
    return cleanHotkeys(Array.isArray(override) ? override : this.commands.get(id)?.hotkeys || []);
  }

  isCustomized(id) {
    return Object.hasOwn(this.overrides, id) && Array.isArray(this.overrides[id]);
  }

  setHotkeys(id, hotkeys) {
    if (!this.commands.has(id) || !Array.isArray(hotkeys)) return false;
    const keys = cleanHotkeys(hotkeys);
    this.overrides[id] = keys;
    if (this.config) this.config.set({ [id]: keys });
    else this.emit('hotkeys-change');
    return true;
  }

  addHotkey(id, hotkey) {
    if (!normalizeCombo(hotkey)) return false;
    return this.setHotkeys(id, [...this.getHotkeys(id), hotkey]);
  }

  removeHotkey(id, hotkey) {
    const combo = normalizeCombo(hotkey);
    return this.setHotkeys(id, this.getHotkeys(id).filter((key) => normalizeCombo(key) !== combo));
  }

  resetHotkeys(id) {
    if (!this.commands.has(id)) return false;
    delete this.overrides[id];
    // ConfigFile's data is the same sparse map; deleting restores future defaults too.
    if (this.config) this.config.set({});
    else this.emit('hotkeys-change');
    return true;
  }

  conflictsFor(id, hotkey) {
    const combo = normalizeCombo(hotkey);
    if (!combo) return [];
    return [...this.commands.values()].filter((command) =>
      command.id !== id && this.getHotkeys(command.id).some((key) => normalizeCombo(key) === combo),
    );
  }

  get isCapturing() {
    return !!this.capture;
  }

  /** The window capture listener runs before the editor, modal and global commands. */
  captureHotkey(onCapture) {
    const capture = { onCapture };
    this.capture = capture;
    return () => {
      if (this.capture === capture) this.capture = null;
    };
  }

  async run(id) {
    const command = this.commands.get(id);
    if (!command) return false;
    if (command.isAvailable && !command.isAvailable()) return false;
    this.recent = [id, ...this.recent.filter((r) => r !== id)].slice(0, 10);
    try {
      await command.run();
    } catch (err) {
      console.error(err);
      const { notice } = await import('../ui/notice.js');
      notice(`Erro: ${err.message || err}`);
    }
    return true;
  }

  onKeyDown(event) {
    if (this.capture) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.isComposing || event.repeat || MODIFIERS.has(event.key)) return;
      const hotkey = event.key === 'Escape' ? null : eventToHotkey(event);
      if (!hotkey && event.key !== 'Escape') return;
      const { onCapture } = this.capture;
      this.capture = null;
      onCapture(hotkey);
      return;
    }
    if (event.isComposing || event.repeat || event.getModifierState?.('AltGraph')) return;
    if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      // Local modal and bookmark controls keep their own plain-key navigation.
      if (event.target?.closest?.('.modal-backdrop, .bookmark-row')) return;
      if (!/^F\d+$/.test(event.key) && event.target?.closest?.('input, textarea, select, [contenteditable="true"], .cm-editor')) return;
    }
    const combo = eventToCombo(event);
    if (!combo) return;
    const matches = [...this.commands.values()].filter((command) =>
      (!command.isAvailable || command.isAvailable()) &&
      this.getHotkeys(command.id).some((key) => normalizeCombo(key) === combo),
    );
    if (!matches.length) return;
    event.preventDefault();
    event.stopPropagation();
    // Ambiguous combinations are disabled until their visible conflict is resolved.
    if (matches.length === 1) this.run(matches[0].id);
  }

  destroy() {
    this.capture = null;
    this._offConfig?.();
    globalThis.window?.removeEventListener('keydown', this._onKeyDown, true);
  }
}

function cleanHotkeys(hotkeys) {
  const seen = new Set();
  return hotkeys.filter((hotkey) => {
    const combo = normalizeCombo(hotkey);
    if (!combo || seen.has(combo)) return false;
    seen.add(combo);
    return true;
  });
}

export function normalizeCombo(hotkey) {
  if (typeof hotkey !== 'string' || !hotkey.trim()) return null;
  const parts = hotkey.trim().toLowerCase().split('+');
  let key = parts.pop();
  if (!key && parts.at(-1) === '') {
    parts.pop();
    key = 'plus';
  }
  if (!key || ['mod', 'ctrl', 'control', 'meta', 'shift', 'alt'].includes(key)) return null;
  const mods = new Set(parts.map((part) => part === 'control' ? 'ctrl' : part));
  if ([...mods].some((mod) => !['mod', 'ctrl', 'meta', 'alt', 'shift'].includes(mod))) return null;
  if (mods.has('mod')) {
    mods.delete('mod');
    mods.add(isMac ? 'meta' : 'ctrl');
  }
  if (key === 'esc') key = 'escape';
  if (key === 'return') key = 'enter';
  if (key === ' ') key = 'space';
  return [...['ctrl', 'meta', 'alt', 'shift'].filter((mod) => mods.has(mod)), key].join('+');
}

function eventKey(event) {
  if (!event.key || MODIFIERS.has(event.key) || ['Dead', 'Unidentified', 'Process'].includes(event.key)) return null;
  if (event.code?.startsWith('Key')) return event.code.slice(3);
  if (event.code?.startsWith('Digit')) return event.code.slice(5);
  return KEY_CODES[event.code] || (event.key === '+' ? 'Plus' : event.key === ' ' ? 'Space' : event.key);
}

export function eventToCombo(event) {
  const key = eventKey(event);
  if (!key) return null;
  const mods = [];
  if (event.ctrlKey) mods.push('ctrl');
  if (event.metaKey) mods.push('meta');
  if (event.altKey) mods.push('alt');
  if (event.shiftKey) mods.push('shift');
  return normalizeCombo([...mods, key].join('+'));
}

export function eventToHotkey(event) {
  const combo = eventToCombo(event);
  if (!combo || event.getModifierState?.('AltGraph')) return null;
  return combo.split('+').map((part) => {
    if (part === (isMac ? 'meta' : 'ctrl')) return 'Mod';
    if (part === 'ctrl') return 'Ctrl';
    if (part === 'meta') return 'Meta';
    if (part === 'shift') return 'Shift';
    if (part === 'alt') return 'Alt';
    return KEY_LABELS[part] || (part.length === 1 ? part.toUpperCase() : /^f\d+$/.test(part) ? part.toUpperCase() : part);
  }).join('+');
}

export function formatHotkey(hotkey) {
  return String(hotkey).split('+').map((part) => {
    const lower = part.toLowerCase();
    if (lower === 'mod') return isMac ? '⌘' : 'Ctrl';
    if (lower === 'ctrl' || lower === 'control') return isMac ? '⌃' : 'Ctrl';
    if (lower === 'meta') return isMac ? '⌘' : 'Win';
    if (lower === 'shift') return isMac ? '⇧' : 'Shift';
    if (lower === 'alt') return isMac ? '⌥' : 'Alt';
    if (lower === 'space') return 'Espaço';
    if (lower === 'plus') return '+';
    return KEY_LABELS[lower] || (part.length === 1 ? part.toUpperCase() : part);
  }).join(isMac ? '' : '+');
}
