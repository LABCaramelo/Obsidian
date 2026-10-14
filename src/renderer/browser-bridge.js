// Browser bridge for running Basalto directly in any web browser without Electron
(function() {
  if (window.basalto) return;

  const rpc = async (endpoint, data) => {
    const isPost = data !== undefined;
    const res = await fetch(`/api/${endpoint}`, {
      method: isPost ? 'POST' : 'GET',
      headers: isPost ? { 'Content-Type': 'application/json' } : {},
      body: isPost ? JSON.stringify(data) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(err.message || res.statusText);
    }
    return res.json();
  };

  const listeners = new Set();
  try {
    const eventSource = new EventSource('/api/events');
    eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        for (const listener of listeners) listener(data);
      } catch {}
    };
  } catch {}

  window.basalto = {
    app: {
      info: () => rpc('app/info'),
      nativeDark: () => false,
    },
    vaults: {
      list: () => rpc('vaults/list'),
      openPath: (path) => rpc('vaults/open-path', { path }),
      openId: (id) => rpc('vaults/open-id', { id }),
      create: (parent, name) => rpc('vaults/create', { parent, name }),
      remove: (id) => rpc('vaults/remove', { id }),
      pickFolder: () => null,
      defaultParent: () => '',
      starter: () => { window.location.href = '/starter.html'; },
    },
    vault: {
      info: () => rpc('vault/info'),
      list: () => rpc('fs/list'),
      stat: (path) => rpc('fs/stat', { path }),
      read: (path) => rpc('fs/read', { path }),
      readMany: (paths) => rpc('fs/read-many', { paths }),
      write: (path, text) => rpc('fs/write', { path, text }),
      writeBinary: async (path, bytes) => {
        let binary = '';
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);
        return rpc('fs/write-binary', { path, base64 });
      },
      mkdir: (path) => rpc('fs/mkdir', { path }),
      rename: (from, to) => rpc('fs/rename', { from, to }),
      trash: (path) => rpc('fs/trash', { path }),
      exists: (path) => rpc('fs/exists', { path }),
      readConfig: (name) => rpc('config/read', { name }),
      writeConfig: (name, data) => rpc('config/write', { name, data }),
      onEvent(callback) {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    },
    shell: {
      openExternal: (url) => window.open(url, '_blank'),
      openPath: () => {},
      reveal: () => {},
    },
    window: {
      onBeforeClose: () => () => {},
      setTitle: (title) => { document.title = title; },
      printToPdf: async () => { window.print(); return null; },
      onMenuCommand: () => () => {},
    },
  };
})();
