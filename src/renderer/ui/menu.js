import { el } from '../core/util.js';
import { icon } from './icons.js';

let openMenu = null;

/**
 * Context menu. Items: { title, icon?, onClick, danger?, disabled? } or 'separator'.
 */
export class Menu {
  constructor() {
    this.items = [];
  }

  addItem(item) {
    this.items.push(item);
    return this;
  }

  addSeparator() {
    if (this.items.length && this.items[this.items.length - 1] !== 'separator') this.items.push('separator');
    return this;
  }

  showAtMouseEvent(e) {
    e.preventDefault();
    this.showAt(e.clientX, e.clientY);
  }

  showAt(x, y) {
    closeMenu();
    const menu = el('div', { class: 'menu', role: 'menu' });
    for (const item of this.items) {
      if (item === 'separator') {
        menu.appendChild(el('div', { class: 'menu-separator' }));
        continue;
      }
      const row = el(
        'div',
        { class: `menu-item${item.danger ? ' is-danger' : ''}${item.disabled ? ' is-disabled' : ''}`, role: 'menuitem' },
        el('span', { class: 'menu-item-icon' }, item.icon ? icon(item.icon, 14) : null),
        el('span', { class: 'menu-item-title', text: item.title }),
      );
      row.addEventListener('click', () => {
        if (item.disabled) return;
        closeMenu();
        item.onClick?.();
      });
      menu.appendChild(row);
    }
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 4)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 4)}px`;
    openMenu = menu;
    setTimeout(() => {
      document.addEventListener('mousedown', outside, true);
      document.addEventListener('keydown', onKey, true);
    });
  }
}

function outside(e) {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
}

function onKey(e) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    closeMenu();
  }
}

export function closeMenu() {
  if (openMenu) openMenu.remove();
  openMenu = null;
  document.removeEventListener('mousedown', outside, true);
  document.removeEventListener('keydown', onKey, true);
}
