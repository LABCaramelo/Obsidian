import { el } from '../core/util.js';

let container = null;

/** Shows a transient toast in the top-right corner. */
export function notice(message, timeout = 4000) {
  if (!container) {
    container = el('div', { class: 'notice-container' });
    document.body.appendChild(container);
  }
  const node = el('div', { class: 'notice', text: message });
  node.addEventListener('click', () => node.remove());
  container.appendChild(node);
  if (timeout > 0) setTimeout(() => node.remove(), timeout);
  return node;
}
