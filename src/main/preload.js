'use strict';

// Narrow bridge between the sandboxed renderer and the main process.
// Every file-system call is scoped by the main process to the window's own vault.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
let beforeCloseHandler = null;

// Installed immediately, including while the renderer is still loading its vault.
ipcRenderer.on('window:before-close', async (_event, id) => {
  let error = null;
  try {
    await beforeCloseHandler?.();
  } catch (err) {
    error = err?.message || String(err);
  }
  ipcRenderer.invoke('window:close-result', id, error).catch(console.error);
});

contextBridge.exposeInMainWorld('basalto', {
  app: {
    info: invoke('app:info'),
    nativeDark: invoke('theme:native-dark'),
  },
  vaults: {
    list: invoke('vaults:list'),
    openPath: invoke('vaults:open-path'),
    openId: invoke('vaults:open-id'),
    create: invoke('vaults:create'),
    remove: invoke('vaults:remove'),
    pickFolder: invoke('vaults:pick-folder'),
    defaultParent: invoke('vaults:default-parent'),
    starter: invoke('vaults:starter'),
  },
  vault: {
    info: invoke('vault:info'),
    list: invoke('fs:list'),
    stat: invoke('fs:stat'),
    read: invoke('fs:read'),
    readMany: invoke('fs:read-many'),
    write: invoke('fs:write'),
    writeBinary: invoke('fs:write-binary'),
    mkdir: invoke('fs:mkdir'),
    rename: invoke('fs:rename'),
    trash: invoke('fs:trash'),
    exists: invoke('fs:exists'),
    readConfig: invoke('config:read'),
    writeConfig: invoke('config:write'),
    onEvent(callback) {
      const listener = (_e, event) => callback(event);
      ipcRenderer.on('fs:event', listener);
      return () => ipcRenderer.removeListener('fs:event', listener);
    },
  },
  shell: {
    openExternal: invoke('shell:open-external'),
    openPath: invoke('shell:open-path'),
    reveal: invoke('shell:reveal'),
  },
  window: {
    onBeforeClose(callback) {
      beforeCloseHandler = callback;
      return () => { if (beforeCloseHandler === callback) beforeCloseHandler = null; };
    },
    setTitle: invoke('window:set-title'),
    printToPdf: invoke('window:print-pdf'),
    onMenuCommand(callback) {
      const listener = (_e, id) => callback(id);
      ipcRenderer.on('menu:command', listener);
      return () => ipcRenderer.removeListener('menu:command', listener);
    },
  },
});
