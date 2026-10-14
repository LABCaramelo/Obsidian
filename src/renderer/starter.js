import './styles/starter.css';
import { el } from './core/util.js';
import { icon } from './ui/icons.js';

const api = window.basalto.vaults;

async function render() {
  document.body.textContent = '';
  const vaults = await api.list();
  const info = await window.basalto.app.info();

  const status = el('div', { class: 'starter-status' });
  const run = async (fn) => {
    status.textContent = '';
    try {
      await fn();
    } catch (err) {
      status.textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    }
  };

  const list = el('div', { class: 'recent-vaults' });
  if (!vaults.length) list.appendChild(el('div', { class: 'recent-vaults-empty', text: 'Nenhum cofre ainda.' }));
  for (const vault of vaults) {
    const remove = el('button', { class: 'clickable-icon recent-vault-remove', title: 'Remover da lista (não apaga os arquivos)' }, icon('x', 14));
    remove.addEventListener('click', async (e) => {
      e.stopPropagation();
      await api.remove(vault.id);
      render();
    });
    const row = el(
      'div',
      { class: 'recent-vault', title: vault.path },
      el('div', { class: 'recent-vault-text' }, el('div', { class: 'recent-vault-name', text: vault.name }), el('div', { class: 'recent-vault-path', text: vault.path })),
      remove,
    );
    row.addEventListener('click', () => run(() => api.openId(vault.id)));
    list.appendChild(row);
  }

  const action = (title, desc, button, onClick) => {
    const btn = el('button', { class: 'mod-cta', text: button });
    btn.addEventListener('click', onClick);
    return el('div', { class: 'starter-action' }, el('div', { class: 'starter-action-info' }, el('div', { class: 'starter-action-title', text: title }), el('div', { class: 'starter-action-desc', text: desc })), btn);
  };

  const createForm = el('div', { class: 'create-vault is-hidden' });
  const nameInput = el('input', { type: 'text', class: 'text-input', placeholder: 'Nome do cofre', spellcheck: 'false' });
  let parent = await api.defaultParent();
  const parentLabel = el('div', { class: 'create-vault-parent', text: parent });
  const browse = el('button', { text: 'Procurar…' });
  browse.addEventListener('click', async () => {
    const chosen = await api.pickFolder('Escolha onde criar o cofre');
    if (chosen) {
      parent = chosen;
      parentLabel.textContent = chosen;
    }
  });
  const create = el('button', { class: 'mod-cta', text: 'Criar' });
  create.addEventListener('click', () => run(() => api.create(parent, nameInput.value)));
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') create.click();
  });
  const back = el('button', { text: 'Voltar' });
  back.addEventListener('click', () => {
    createForm.classList.add('is-hidden');
    actions.classList.remove('is-hidden');
  });
  createForm.append(
    el('div', { class: 'starter-action-title', text: 'Criar novo cofre' }),
    el('label', { class: 'create-vault-row' }, el('span', { text: 'Nome' }), nameInput),
    el('div', { class: 'create-vault-row' }, el('span', { text: 'Local' }), parentLabel, browse),
    el('div', { class: 'create-vault-buttons' }, back, create),
  );

  const actions = el(
    'div',
    { class: 'starter-actions' },
    action('Criar novo cofre', 'Cria um novo cofre em uma pasta.', 'Criar', () => {
      actions.classList.add('is-hidden');
      createForm.classList.remove('is-hidden');
      nameInput.focus();
    }),
    action('Abrir pasta como cofre', 'Escolha uma pasta existente com arquivos Markdown (inclusive um cofre do Obsidian).', 'Abrir', () =>
      run(async () => {
        const folder = await api.pickFolder('Abrir pasta como cofre');
        if (folder) await api.openPath(folder);
      }),
    ),
  );

  document.body.append(
    el(
      'div',
      { class: 'starter-container' },
      el('div', { class: 'starter-left' }, list),
      el(
        'div',
        { class: 'starter-right' },
        el('div', { class: 'starter-brand' }, el('div', { class: 'starter-logo' }, icon('vault', 56)), el('div', { class: 'starter-app-name', text: 'Basalto' }), el('div', { class: 'starter-version', text: `Versão ${info.version}` })),
        actions,
        createForm,
        status,
      ),
    ),
  );
}

render();
