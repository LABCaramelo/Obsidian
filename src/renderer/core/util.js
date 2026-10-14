// Small helpers shared by the renderer.

export class Events {
  constructor() {
    this._handlers = new Map();
  }

  on(name, fn) {
    if (!this._handlers.has(name)) this._handlers.set(name, new Set());
    this._handlers.get(name).add(fn);
    return () => this.off(name, fn);
  }

  off(name, fn) {
    this._handlers.get(name)?.delete(fn);
  }

  emit(name, ...args) {
    for (const fn of [...(this._handlers.get(name) || [])]) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`Erro no evento ${name}`, err);
      }
    }
  }
}

// --- paths (always vault-relative, forward slashes) ---

export function basename(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

export function dirname(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

export function extname(p) {
  const name = basename(p);
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase();
}

/** File name without extension. */
export function stem(p) {
  const name = basename(p);
  const i = name.lastIndexOf('.');
  return i <= 0 ? name : name.slice(0, i);
}

export function joinPath(...parts) {
  return parts
    .filter((p) => p !== '' && p != null)
    .join('/')
    .replace(/\/+/g, '/')
    .replace(/^\/|\/$/g, '');
}

export function isMarkdown(p) {
  return extname(p) === 'md';
}

export const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'avif']);
export const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac', 'webm', '3gp']);
export const VIDEO_EXT = new Set(['mp4', 'webm', 'ogv', 'mov', 'mkv']);

export function sanitizeFileName(name) {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, '').trim();
}

// --- timing ---

export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...args);
    }, ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  wrapped.flush = (...args) => {
    if (t !== null) {
      clearTimeout(t);
      t = null;
      fn(...args);
    }
  };
  return wrapped;
}

// --- fuzzy matching ---

/**
 * Scores `text` against `query` as an in-order subsequence match.
 * Returns null when not every query character is found.
 */
export function fuzzyMatch(query, text) {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return { score: 0, matches: [] };
  const t = text.toLowerCase();
  const matches = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    matches.push(found);
    if (found === prev + 1) score += 5; // consecutive
    if (found === 0 || /[\s/_\-.]/.test(t[found - 1])) score += 3; // word start
    score -= Math.min(found - ti, 10) * 0.1;
    prev = found;
    ti = found + 1;
  }
  if (t.startsWith(q)) score += 10;
  score -= text.length * 0.01;
  return { score, matches };
}

/** Wraps matched characters in <mark> for display. */
export function highlightMatches(el, text, matches) {
  el.textContent = '';
  const set = new Set(matches);
  let buf = '';
  let marked = false;
  const flush = () => {
    if (!buf) return;
    if (marked) {
      const m = document.createElement('mark');
      m.textContent = buf;
      el.appendChild(m);
    } else {
      el.appendChild(document.createTextNode(buf));
    }
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const isMatch = set.has(i);
    if (isMatch !== marked) {
      flush();
      marked = isMatch;
    }
    buf += text[i];
  }
  flush();
}

// --- dates (subset of moment-style tokens) ---

const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

export function formatDate(date, format) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const tokens = {
    YYYY: () => String(date.getFullYear()),
    YY: () => String(date.getFullYear()).slice(-2),
    MMMM: () => MONTHS[date.getMonth()],
    MMM: () => MONTHS[date.getMonth()].slice(0, 3),
    MM: () => pad(date.getMonth() + 1),
    M: () => String(date.getMonth() + 1),
    DD: () => pad(date.getDate()),
    D: () => String(date.getDate()),
    dddd: () => WEEKDAYS[date.getDay()],
    ddd: () => WEEKDAYS[date.getDay()].slice(0, 3),
    HH: () => pad(date.getHours()),
    H: () => String(date.getHours()),
    mm: () => pad(date.getMinutes()),
    ss: () => pad(date.getSeconds()),
  };
  return format.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|mm|ss/g, (m, literal) =>
    literal !== undefined ? literal : tokens[m](),
  );
}

// --- DOM ---

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function countWords(text) {
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const words = body.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu);
  return { words: words ? words.length : 0, chars: body.replace(/\s/g, '').length };
}

export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
