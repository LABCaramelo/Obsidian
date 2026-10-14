/* Optional desktop integration check: set BASALTO_PLAYWRIGHT to an installed Playwright module. */
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.BASALTO_PLAYWRIGHT || 'playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'basalto-smoke-'));
  const vault = path.join(sandbox, 'Cofre');
  const profile = path.join(sandbox, 'Profile');
  await fs.mkdir(path.join(vault, 'Notas'), { recursive: true });
  await fs.writeFile(path.join(vault, 'Inicial.md'), '# Inicial\n\nUma nota de teste.\n');
  await fs.writeFile(path.join(vault, 'Outra.md'), '# Outra\n');
  await fs.writeFile(path.join(vault, 'Painel.canvas'), JSON.stringify({ nodes: [{ id: 'first', type: 'text', x: 0, y: 0, width: 300, height: 180, text: '# Cartão inicial' }], edges: [] }));
  const errors = [];
  let desktop;
  const launch = async () => {
    const env = { ...process.env, BASALTO_USER_DATA: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    desktop = await _electron.launch({ executablePath: require('electron'), args: [root, vault], cwd: root, env, timeout: 30000 });
    const page = await desktop.firstWindow();
    page.on('pageerror', (err) => errors.push(err.message));
    await page.waitForFunction(() => window.app?.workspace?.ready && !document.body.classList.contains('is-loading'));
    return page;
  };
  try {
    let page = await launch();
    await page.evaluate(() => window.app.openFile('Inicial.md'));
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nTexto salvo pelo teste.');
    await page.evaluate(() => window.app.flushSaves());
    assert.match(await fs.readFile(path.join(vault, 'Inicial.md'), 'utf8'), /Texto salvo pelo teste/);
    await page.keyboard.press('Control+e');
    await page.locator('.markdown-reading-view:visible').waitFor();
    assert.match(await page.locator('.markdown-reading-view:visible').innerText(), /Texto salvo pelo teste/);

    await page.evaluate(() => window.app.commands.run('bookmarks:add-active'));
    await page.locator('.bookmark-row', { hasText: 'Inicial' }).waitFor();
    await page.getByRole('button', { name: 'Novo grupo de favoritos', exact: true }).click();
    await page.locator('.prompt-text-modal input').fill('Trabalho');
    await page.locator('.prompt-text-modal').getByRole('button', { name: 'Salvar', exact: true }).click();
    await page.locator('.bookmark-row', { hasText: 'Trabalho' }).waitFor();
    await page.evaluate(() => {
      const app = window.app;
      const file = app.bookmarks.findTarget({ type: 'file', path: 'Inicial.md' });
      const group = app.bookmarks.items.find((item) => item.title === 'Trabalho');
      app.bookmarks.move(file.id, group.id);
    });
    await page.evaluate(() => window.app.renameFile('Inicial.md', 'Notas/Renomeada.md'));
    await page.locator('.bookmark-row[data-path="Notas/Renomeada.md"]').waitFor();
    await page.evaluate(() => window.app.openSearch('Texto salvo'));
    await page.getByRole('button', { name: 'Salvar busca nos favoritos', exact: true }).click();
    await page.locator('.prompt-text-modal input').fill('Minha busca');
    await page.locator('.prompt-text-modal').getByRole('button', { name: 'Salvar', exact: true }).click();
    await page.locator('.bookmark-row', { hasText: 'Minha busca' }).click();
    await page.locator('.search-result-file-title', { hasText: 'Renomeada' }).waitFor();

    await page.evaluate(() => window.app.commands.run('app:open-settings'));
    await page.getByText('Atalhos', { exact: true }).click();
    await page.getByRole('searchbox', { name: 'Buscar comando' }).fill('Mostrar favoritos');
    await page.getByRole('button', { name: 'Adicionar atalho para Mostrar favoritos', exact: true }).click();
    await page.keyboard.press('Control+Shift+b');
    assert.deepEqual(await page.evaluate(() => window.app.commands.getHotkeys('panel:bookmarks')), ['Mod+Shift+B']);
    await page.locator('.modal-close').click();
    await page.keyboard.press('Control+Shift+b');
    await page.locator('.sidebar-tab[data-panel="bookmarks"].is-active').waitFor();

    await page.evaluate(() => window.app.openFile('Painel.canvas'));
    await page.locator('.canvas-node[data-id="first"]').waitFor();
    await page.locator('.canvas-node[data-id="first"]').dblclick();
    await page.locator('.canvas-node.is-editing .cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nCartao editado.');
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.app.flushSaves());
    let canvas = JSON.parse(await fs.readFile(path.join(vault, 'Painel.canvas'), 'utf8'));
    assert.match(canvas.nodes[0].text, /Cartao editado/);
    await page.evaluate(() => window.app.openFile('Painel.canvas', { split: true }));
    await page.evaluate(() => {
      const views = window.app.canvasViews();
      views[0].addTextNode({ x: 500, y: 0 }, false, 'Criado no outro painel');
      return views[0].saveNow();
    });
    await page.waitForFunction(() => window.app.canvasViews().every((view) => view.data.nodes.some((node) => node.text === 'Criado no outro painel')));
    await page.evaluate(() => window.app.flushSaves());
    if (process.env.BASALTO_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.BASALTO_SMOKE_SCREENSHOT });
    await desktop.close();
    desktop = null;
    page = await launch();
    assert.equal(await page.evaluate(() => window.app.bookmarks.findTarget({ type: 'file', path: 'Notas/Renomeada.md' })?.path), 'Notas/Renomeada.md');
    assert.deepEqual(await page.evaluate(() => window.app.commands.getHotkeys('panel:bookmarks')), ['Mod+Shift+B']);
    assert.equal(await page.evaluate(() => window.app.bookmarks.findTarget({ type: 'search', query: 'Texto salvo' })?.title), 'Minha busca');
    await page.waitForFunction(() => window.app.canvasViews().length === 2 && window.app.canvasViews().every((view) => view.data.nodes.length === 2));
    assert.deepEqual(errors, []);
    console.log('PASS: desktop editing, reading, bookmarks/groups/search, rename, hotkey capture, Canvas synchronization and restart persistence.');
    console.log(`Throwaway vault and profile: ${sandbox}`);
  } finally {
    if (desktop) await desktop.close();
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
