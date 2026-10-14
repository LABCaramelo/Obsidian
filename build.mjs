import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const watch = process.argv.includes('--watch');
const root = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(root, 'dist');

// Clear old chunks; on Windows a running app may hold some files open, so skip those.
fs.mkdirSync(outdir, { recursive: true });
for (const name of fs.readdirSync(outdir)) {
  try {
    fs.rmSync(path.join(outdir, name), { recursive: true, force: true });
  } catch {
    /* in use — esbuild will overwrite it */
  }
}
for (const file of ['index.html', 'starter.html', 'browser-bridge.js']) {
  fs.copyFileSync(path.join(root, 'src', 'renderer', file), path.join(outdir, file));
}

const options = {
  absWorkingDir: root,
  entryPoints: {
    app: 'src/renderer/app.js',
    starter: 'src/renderer/starter.js',
  },
  bundle: true,
  format: 'esm',
  splitting: true,
  outdir,
  target: 'chrome130',
  sourcemap: true,
  minify: !watch,
  legalComments: 'linked',
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
