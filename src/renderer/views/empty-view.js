import { View } from '../workspace/workspace.js';
import { el } from '../core/util.js';
import { formatHotkey } from '../core/commands.js';

export class EmptyView extends View {
  constructor(leaf) {
    super(leaf);
    this.containerEl.classList.add('empty-view');
    this.hotkeyHints = [];
    const action = (label, command) => {
      const hint = el('span', { class: 'empty-state-hotkey' });
      this.hotkeyHints.push({ command, hint });
      const a = el('a', { class: 'empty-state-action', href: '#' }, label, hint);
      a.addEventListener('click', (e) => {
        e.preventDefault();
        this.app.commands.run(command);
      });
      return a;
    };
    this.containerEl.append(
      el(
        'div',
        { class: 'empty-state' },
        el('div', { class: 'empty-state-title', text: 'Nenhum arquivo aberto' }),
        action('Criar nova nota', 'file:new-note'),
        action('Criar novo canvas', 'canvas:new'),
        action('Ir para arquivo', 'switcher:open'),
        action('Ver arquivos recentes', 'switcher:recent'),
        action('Abrir visualização em grafo', 'graph:open'),
        action('Fechar', 'workspace:close'),
      ),
    );
    const updateHotkeys = () => {
      for (const { command, hint } of this.hotkeyHints) {
        const hotkeys = this.app.commands.getHotkeys(command);
        hint.textContent = hotkeys.length ? ` (${hotkeys.map(formatHotkey).join(' / ')})` : '';
      }
    };
    this._offHotkeys = this.app.commands.on('hotkeys-change', updateHotkeys);
    updateHotkeys();
  }

  onClose() {
    this._offHotkeys?.();
  }

  get type() {
    return 'empty';
  }

  getDisplayText() {
    return 'Nova aba';
  }

  getIcon() {
    return 'file';
  }
}
