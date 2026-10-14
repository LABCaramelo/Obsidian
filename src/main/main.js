'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, Menu, nativeTheme, session } = require('electron');
const { VaultRegistry } = require('./vault-registry');
const { VaultFs } = require('./vault-fs');
const { resolveInVault } = require('./paths');
const { CloseBarrier } = require('./close-barrier');

const DEV = process.argv.includes('--dev');

// Lets tests run against a throwaway profile instead of the real vault registry.
if (process.env.BASALTO_USER_DATA) app.setPath('userData', process.env.BASALTO_USER_DATA);
const DIST = path.join(__dirname, '..', '..', 'dist');
const PRELOAD = path.join(__dirname, 'preload.js');

protocol.registerSchemesAsPrivileged([
  { scheme: 'vaultfile', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let registry;
let starterWindow = null;
let quitting = false;
const vaultWindows = new Map(); // vaultId -> BrowserWindow
const vaultFsById = new Map(); // vaultId -> VaultFs
const contextByWebContents = new Map(); // webContents.id -> { vaultId }
const closeBarriers = new Map(); // webContents.id -> CloseBarrier

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function baseWebPreferences() {
  return {
    preload: PRELOAD,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: true,
  };
}

function hardenNavigation(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault();
      if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    }
  });
}

function openStarter() {
  if (starterWindow && !starterWindow.isDestroyed()) {
    starterWindow.focus();
    return;
  }
  starterWindow = new BrowserWindow({
    width: 780,
    height: 520,
    resizable: false,
    maximizable: false,
    title: 'Basalto',
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true,
    show: false,
    webPreferences: baseWebPreferences(),
  });
  hardenNavigation(starterWindow);
  starterWindow.loadFile(path.join(DIST, 'starter.html'));
  starterWindow.once('ready-to-show', () => starterWindow.show());
  starterWindow.on('closed', () => {
    starterWindow = null;
  });
}

function getVaultFs(vaultId) {
  let vfs = vaultFsById.get(vaultId);
  if (!vfs) {
    const v = registry.get(vaultId);
    if (!v) throw new Error('Cofre desconhecido');
    vfs = new VaultFs(v.path);
    vaultFsById.set(vaultId, vfs);
  }
  return vfs;
}

function openVault(vaultId) {
  const existing = vaultWindows.get(vaultId);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return existing;
  }
  const v = registry.get(vaultId);
  if (!v) throw new Error('Cofre desconhecido');

  const bounds = v.bounds || {};
  const win = new BrowserWindow({
    width: bounds.width || 1280,
    height: bounds.height || 820,
    x: bounds.x,
    y: bounds.y,
    minWidth: 520,
    minHeight: 360,
    title: `${v.name} - Basalto`,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
    show: false,
    webPreferences: baseWebPreferences(),
  });
  if (bounds.maximized) win.maximize();
  hardenNavigation(win);

  const wcId = win.webContents.id;
  contextByWebContents.set(wcId, { vaultId });
  vaultWindows.set(vaultId, win);
  registry.update(vaultId, { ts: Date.now(), open: true });

  const vfs = getVaultFs(vaultId);
  const unsubscribe = vfs.onEvent((event) => {
    if (!win.isDestroyed()) win.webContents.send('fs:event', event);
  });

  win.loadFile(path.join(DIST, 'index.html'), { query: { vault: vaultId } });
  win.once('ready-to-show', () => {
    win.show();
    if (DEV) win.webContents.openDevTools({ mode: 'detach' });
  });

  const closeBarrier = new CloseBarrier({
    request: (id) => win.webContents.send('window:before-close', id),
    close: () => win.close(),
    failed: (message) => {
      quitting = false;
      dialog.showMessageBox(win, {
        type: 'error',
        title: 'Não foi possível salvar',
        message: 'A janela permanece aberta para preservar suas alterações.',
        detail: String(message),
      });
    },
  });
  closeBarriers.set(wcId, closeBarrier);
  win.on('close', (event) => {
    if (!closeBarrier.onClose(event)) return;
    registry.update(vaultId, {
      bounds: { ...win.getNormalBounds(), maximized: win.isMaximized() },
      // Closing the last window quits the app; that vault should come back on next launch.
      open: quitting || vaultWindows.size === 1,
    });
  });
  win.on('closed', () => {
    unsubscribe();
    contextByWebContents.delete(wcId);
    closeBarriers.delete(wcId);
    vaultWindows.delete(vaultId);
    if (!vaultFsById.get(vaultId)?.listeners.size) vaultFsById.delete(vaultId);
  });
  return win;
}

function openVaultByPath(folder) {
  if (!path.isAbsolute(folder) || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    throw new Error(`A pasta não existe: ${folder}`);
  }
  const id = registry.add(folder);
  openVault(id);
  if (starterWindow && !starterWindow.isDestroyed()) starterWindow.close();
  return id;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function vaultOf(event) {
  const ctx = contextByWebContents.get(event.sender.id);
  if (!ctx) throw new Error('Esta janela não pertence a um cofre');
  return { id: ctx.vaultId, fs: getVaultFs(ctx.vaultId) };
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => fn(event, ...args));
}

function registerIpc() {
  // App / vault registry
  handle('app:info', () => ({ version: app.getVersion(), platform: process.platform }));
  handle('vaults:list', () => registry.list());
  handle('vaults:open-path', (_e, folder) => openVaultByPath(String(folder)));
  handle('vaults:open-id', (_e, id) => {
    openVault(String(id));
    if (starterWindow && !starterWindow.isDestroyed()) starterWindow.close();
  });
  handle('vaults:create', (_e, parent, name) => {
    const clean = String(name).trim().replace(/[\\/:*?"<>|]/g, '');
    if (!clean) throw new Error('Informe um nome para o cofre');
    if (!parent || !path.isAbsolute(String(parent)) || !fs.existsSync(String(parent))) {
      throw new Error('Escolha uma pasta válida para o cofre');
    }
    const folder = path.join(String(parent), clean);
    if (fs.existsSync(folder) && fs.readdirSync(folder).length > 0) {
      throw new Error('Já existe uma pasta não vazia com esse nome');
    }
    fs.mkdirSync(folder, { recursive: true });
    return openVaultByPath(folder);
  });
  handle('vaults:remove', (_e, id) => {
    const win = vaultWindows.get(id);
    if (win && !win.isDestroyed()) win.close();
    registry.remove(String(id));
  });
  handle('vaults:pick-folder', async (event, title) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(owner, {
      title: title || 'Escolha uma pasta',
      properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
  });
  handle('vaults:default-parent', () => app.getPath('documents'));
  handle('vaults:starter', () => openStarter());

  // Current vault (scoped by the calling window)
  handle('vault:info', (event) => {
    const { id, fs: vfs } = vaultOf(event);
    return { id, path: vfs.root, name: path.basename(vfs.root) };
  });
  handle('fs:list', (event) => vaultOf(event).fs.list());
  handle('fs:stat', (event, rel) => vaultOf(event).fs.stat(rel));
  handle('fs:read', (event, rel) => vaultOf(event).fs.read(rel));
  handle('fs:read-many', (event, rels) => vaultOf(event).fs.readMany(Array.from(rels || [])));
  handle('fs:write', (event, rel, text) => vaultOf(event).fs.write(rel, String(text)));
  handle('fs:write-binary', (event, rel, bytes) => vaultOf(event).fs.writeBinary(rel, bytes));
  handle('fs:mkdir', (event, rel) => vaultOf(event).fs.mkdir(rel));
  handle('fs:rename', (event, from, to) => vaultOf(event).fs.rename(from, to));
  handle('fs:trash', (event, rel) => vaultOf(event).fs.trash(rel));
  handle('fs:exists', (event, rel) => vaultOf(event).fs.exists(rel));
  handle('config:read', (event, name) => vaultOf(event).fs.readConfig(name));
  handle('config:write', (event, name, data) => vaultOf(event).fs.writeConfig(name, data));

  // Shell integration
  handle('shell:open-external', (_e, url) => {
    if (/^(https?|mailto):/i.test(String(url))) return shell.openExternal(String(url));
    throw new Error('Somente links http(s) e mailto podem ser abertos externamente');
  });
  handle('shell:open-path', (event, rel) => shell.openPath(vaultOf(event).fs.abs(rel)));
  handle('shell:reveal', (event, rel) => shell.showItemInFolder(vaultOf(event).fs.abs(rel)));
  handle('window:set-title', (event, title) => {
    BrowserWindow.fromWebContents(event.sender)?.setTitle(String(title));
  });
  handle('window:close-result', (event, id, error) => closeBarriers.get(event.sender.id)?.complete(id, error));
  handle('window:print-pdf', async (event, rel) => {
    const { fs: vfs } = vaultOf(event);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showSaveDialog(owner, {
      title: 'Exportar como PDF',
      defaultPath: vfs.abs(String(rel).replace(/\.md$/i, '.pdf')),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (res.canceled || !res.filePath) return null;
    const data = await event.sender.printToPDF({ printBackground: true, pageSize: 'A4' });
    await fs.promises.writeFile(res.filePath, data);
    return res.filePath;
  });
  handle('theme:native-dark', () => nativeTheme.shouldUseDarkColors);
}

// ---------------------------------------------------------------------------
// Vault file protocol: vaultfile://<vaultId>/<relative path>
// ---------------------------------------------------------------------------

function registerProtocol() {
  protocol.handle('vaultfile', (request) => {
    try {
      const url = new URL(request.url);
      const vfs = getVaultFs(url.hostname);
      const rel = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      const abs = resolveInVault(vfs.root, rel);
      return net.fetch(pathToFileURL(abs).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function sendCommand(id) {
  const win = BrowserWindow.getFocusedWindow();
  if (win && contextByWebContents.has(win.webContents.id)) win.webContents.send('menu:command', id);
}

function buildMenu() {
  const template = [
    {
      label: 'Arquivo',
      submenu: [
        { label: 'Nova nota', click: () => sendCommand('file:new-note') },
        { label: 'Abrir rapidamente…', click: () => sendCommand('switcher:open') },
        { type: 'separator' },
        { label: 'Abrir outro cofre…', click: () => openStarter() },
        { label: 'Exportar como PDF…', click: () => sendCommand('file:export-pdf') },
        { type: 'separator' },
        { role: 'close', label: 'Fechar janela' },
        { role: 'quit', label: 'Sair' },
      ],
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'undo', label: 'Desfazer' },
        { role: 'redo', label: 'Refazer' },
        { type: 'separator' },
        { role: 'cut', label: 'Recortar' },
        { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Colar' },
        { role: 'selectAll', label: 'Selecionar tudo' },
      ],
    },
    {
      label: 'Exibir',
      submenu: [
        { label: 'Paleta de comandos…', click: () => sendCommand('command-palette:open') },
        { label: 'Alternar leitura/edição', click: () => sendCommand('editor:toggle-mode') },
        { label: 'Visualização em grafo', click: () => sendCommand('graph:open') },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Tamanho real' },
        { role: 'zoomIn', label: 'Aumentar zoom' },
        { role: 'zoomOut', label: 'Diminuir zoom' },
        { role: 'togglefullscreen', label: 'Tela cheia' },
        { type: 'separator' },
        { role: 'reload', label: 'Recarregar' },
        { role: 'toggleDevTools', label: 'Ferramentas de desenvolvedor' },
      ],
    },
    {
      label: 'Ajuda',
      submenu: [{ label: 'Sobre o Basalto', click: () => dialog.showMessageBox({ message: `Basalto ${app.getVersion()}`, detail: 'Editor de notas Markdown local.' }) }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = [...vaultWindows.values()][0] || starterWindow;
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    } else {
      openStarter();
    }
  });

  app.whenReady().then(() => {
    registry = new VaultRegistry(path.join(app.getPath('userData'), 'vaults.json'));
    registerProtocol();
    registerIpc();
    buildMenu();
    try {
      session.defaultSession.setSpellCheckerLanguages(['pt-BR', 'en-US']);
    } catch {
      // Spell-checker dictionaries unavailable on this platform.
    }

    // CLI: `electron . <pasta>` opens that folder as a vault.
    const cliFolder = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-') && a !== '.');
    if (cliFolder && fs.existsSync(cliFolder)) {
      openVaultByPath(path.resolve(cliFolder));
      return;
    }

    const toReopen = registry.list().filter((v) => v.open);
    if (toReopen.length) toReopen.forEach((v) => openVault(v.id));
    else openStarter();
  });

  app.on('before-quit', () => {
    quitting = true;
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openStarter();
  });
}
