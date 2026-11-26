// Scans a project folder into a graph: files (nodes) + import dependencies (edges).
import fs from 'node:fs';
import path from 'node:path';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt',
  '.turbo', '.cache', 'coverage', '__pycache__', '.venv', 'venv', 'env', '.idea',
  '.vscode', 'target', 'bin', 'obj', '.gradle', 'vendor', '.claude', 'concept', 'data',
]);

const CODE_EXT = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.svelte', '.py', '.go', '.rs',
  '.java', '.kt', '.cs', '.php', '.rb', '.swift', '.dart', '.c', '.h', '.cpp', '.hpp',
  '.css', '.scss', '.html', '.json', '.md', '.sql', '.yml', '.yaml', '.toml', '.sh', '.ps1',
]);

const RESOLVE_EXT = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.py',
  '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/__init__.py'];

const MAX_FILES = 1500;
const MAX_BYTES = 512 * 1024;

export function toRel(root, file) {
  if (!file || !root) return null;
  const abs = path.isAbsolute(file) ? file : path.join(root, file);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// Module = first meaningful folder (skips a leading src/app/lib so "src/api/x.ts" -> "api").
export function moduleOf(rel) {
  const parts = rel.split('/');
  if (parts.length === 1) return 'root';
  const wrappers = new Set(['src', 'app', 'lib', 'packages', 'apps']);
  if (wrappers.has(parts[0]) && parts.length > 2) return parts[1];
  return parts[0];
}

function walk(root) {
  const files = [];
  const stack = [root];
  while (stack.length && files.length < MAX_FILES) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name) && !(e.name.startsWith('.') && e.name !== '.github')) stack.push(full);
      } else if (CODE_EXT.has(path.extname(e.name).toLowerCase())) {
        if (e.name === 'package-lock.json' || e.name.endsWith('.lock')) continue;
        files.push(full);
        if (files.length >= MAX_FILES) break;
      }
    }
  }
  return files;
}

function importsOf(text, ext) {
  const out = [];
  if (ext === '.py') {
    for (const m of text.matchAll(/^\s*from\s+([.\w]+)\s+import/gm)) out.push({ spec: m[1], py: true });
    for (const m of text.matchAll(/^\s*import\s+([.\w]+)/gm)) out.push({ spec: m[1], py: true });
    return out;
  }
  const re = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*|import\s+|export\s[^'"]*?from\s*|@import\s+)['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(re)) out.push({ spec: m[1], py: false });
  return out;
}

function resolveSpec(fromRel, { spec, py }, fileSet) {
  let base;
  if (py) {
    if (spec.startsWith('.')) {
      const dots = spec.match(/^\.+/)[0].length;
      let dir = path.posix.dirname(fromRel);
      for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
      base = path.posix.join(dir, spec.slice(dots).replace(/\./g, '/'));
    } else {
      base = spec.replace(/\./g, '/');
    }
    for (const cand of [base + '.py', base + '/__init__.py']) {
      if (fileSet.has(cand)) return cand;
      for (const pre of ['src/', 'app/']) if (fileSet.has(pre + cand)) return pre + cand;
    }
    return null;
  }
  if (spec.startsWith('.')) {
    base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  } else if (spec.startsWith('@/') || spec.startsWith('~/')) {
    base = 'src/' + spec.slice(2);
  } else {
    return null; // external package
  }
  for (const ext of RESOLVE_EXT) {
    if (fileSet.has(base + ext)) return base + ext;
  }
  return null;
}

export function scanProject(root) {
  const absFiles = walk(root);
  const rels = absFiles.map((f) => toRel(root, f));
  const fileSet = new Set(rels.filter(Boolean));
  const nodes = [];
  const edges = [];
  const edgeKeys = new Set();

  absFiles.forEach((abs, i) => {
    const rel = rels[i];
    if (!rel) return;
    let text = '';
    try {
      if (fs.statSync(abs).size <= MAX_BYTES) text = fs.readFileSync(abs, 'utf8');
    } catch { /* unreadable file: keep as node with no imports */ }
    const loc = text ? text.split('\n').length : 1;
    nodes.push({ id: rel, name: path.posix.basename(rel), module: moduleOf(rel), loc });
    const ext = path.extname(rel).toLowerCase();
    for (const imp of importsOf(text, ext)) {
      const target = resolveSpec(rel, imp, fileSet);
      if (target && target !== rel) {
        const key = rel + '->' + target;
        if (!edgeKeys.has(key)) { edgeKeys.add(key); edges.push({ source: rel, target }); }
      }
    }
  });

  return { root, name: path.basename(root), scannedAt: new Date().toISOString(), nodes, edges };
}
