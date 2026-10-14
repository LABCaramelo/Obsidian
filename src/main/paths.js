'use strict';

const path = require('node:path');

// Directories that never show up in the vault tree nor fire watcher events.
const IGNORED_DIRS = new Set(['.basalto', '.obsidian', '.git', '.trash', 'node_modules']);

/** Normalizes a vault-relative path to forward slashes without leading/trailing separators. */
function normalizeRel(rel) {
  if (typeof rel !== 'string') throw new TypeError('Caminho inválido');
  const parts = [];
  for (const part of rel.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') throw new Error(`Caminho fora do cofre: ${rel}`);
    parts.push(part);
  }
  return parts.join('/');
}

/** Resolves a vault-relative path to an absolute one, refusing anything outside the vault. */
function resolveInVault(root, rel) {
  const normalized = normalizeRel(rel);
  const abs = path.resolve(root, normalized);
  const back = path.relative(root, abs);
  if (back.startsWith('..') || path.isAbsolute(back)) {
    throw new Error(`Caminho fora do cofre: ${rel}`);
  }
  return abs;
}

function toRel(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

function isIgnored(rel) {
  const first = rel.split('/')[0];
  return IGNORED_DIRS.has(first) || rel.split('/').some((p) => p.startsWith('.'));
}

module.exports = { normalizeRel, resolveInVault, toRel, isIgnored, IGNORED_DIRS };
