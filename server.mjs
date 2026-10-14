import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { VaultFs } = require('./src/main/vault-fs.js');
const { VaultRegistry } = require('./src/main/vault-registry.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, 'dist');
const DEFAULT_VAULT = path.resolve(process.argv[2] || path.join(__dirname, 'CofreExemplo'));
const PORT = Number(process.env.PORT || 3000);

if (!fs.existsSync(DEFAULT_VAULT)) {
  fs.mkdirSync(DEFAULT_VAULT, { recursive: true });
}

let activeVaultPath = DEFAULT_VAULT;
let activeVaultFs = new VaultFs(activeVaultPath);
const sseClients = new Set();

activeVaultFs.onEvent((event) => {
  const msg = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) client.write(msg);
});

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);

    // API: Server-Sent Events
    if (pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // API endpoints
    if (pathname.startsWith('/api/')) {
      const endpoint = pathname.slice('/api/'.length);
      const send = (data, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
      };

      if (endpoint === 'app/info') {
        return send({ version: '0.1.0', platform: process.platform, isBrowser: true });
      }
      if (endpoint === 'theme/native-dark') {
        return send(false);
      }
      if (endpoint === 'vault/info') {
        return send({ id: 'vault-local', name: path.basename(activeVaultPath), path: activeVaultPath });
      }
      if (endpoint === 'fs/list') {
        return send(await activeVaultFs.list());
      }
      if (endpoint === 'fs/stat') {
        const body = await readBody(req);
        return send(await activeVaultFs.stat(body.path));
      }
      if (endpoint === 'fs/read') {
        const body = await readBody(req);
        return send(await activeVaultFs.read(body.path));
      }
      if (endpoint === 'fs/read-many') {
        const body = await readBody(req);
        return send(await activeVaultFs.readMany(body.paths));
      }
      if (endpoint === 'fs/write') {
        const body = await readBody(req);
        return send(await activeVaultFs.write(body.path, body.text));
      }
      if (endpoint === 'fs/write-binary') {
        const body = await readBody(req);
        const buf = Buffer.from(body.base64, 'base64');
        return send(await activeVaultFs.writeBinary(body.path, buf));
      }
      if (endpoint === 'fs/mkdir') {
        const body = await readBody(req);
        return send(await activeVaultFs.mkdir(body.path));
      }
      if (endpoint === 'fs/rename') {
        const body = await readBody(req);
        return send(await activeVaultFs.rename(body.from, body.to));
      }
      if (endpoint === 'fs/trash') {
        const body = await readBody(req);
        return send(await activeVaultFs.trash(body.path));
      }
      if (endpoint === 'fs/exists') {
        const body = await readBody(req);
        return send(activeVaultFs.exists(body.path));
      }
      if (endpoint === 'config/read') {
        const body = await readBody(req);
        return send(await activeVaultFs.readConfig(body.name));
      }
      if (endpoint === 'config/write') {
        const body = await readBody(req);
        return send(await activeVaultFs.writeConfig(body.name, body.data));
      }

      res.writeHead(404);
      return res.end(JSON.stringify({ error: 'Endpoint not found' }));
    }

    // /vaultfile/* attachment & media serving
    if (pathname.startsWith('/vaultfile/')) {
      const rel = pathname.slice('/vaultfile/'.length);
      const abs = activeVaultFs.abs(rel);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        const ext = path.extname(abs).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        return fs.createReadStream(abs).pipe(res);
      }
      res.writeHead(404);
      return res.end('File not found in vault');
    }

    // Static assets from dist/
    let reqPath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    let filePath = path.join(DIST, reqPath);

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(DIST, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Internal Server Error: ${err.message}`);
  }
});

function startServer(port) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      startServer(port + 1);
    } else {
      console.error(err);
    }
  });

  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`\n======================================================`);
    console.log(`  🌐 BASALTO RODANDO NO NAVEGADOR`);
    console.log(`  URL:   ${url}`);
    console.log(`  Cofre: ${activeVaultPath}`);
    console.log(`======================================================\n`);

    if (process.platform === 'win32') {
      exec(`start ${url}`);
    }
  });
}

startServer(PORT);
