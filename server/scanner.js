// Scans a project folder into a graph: files (nodes) + import dependencies (edges).
import fs from 'node:fs';
import path from 'node:path';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt',
  '.turbo', '.cache', 'coverage', '__pycache__', '.venv', 'venv', 'env', '.idea',
  '.vscode', 'target', 'bin', 'obj', '.gradle', 'vendor', '.claude', 'concept', 'data',
  // generated / asset folders that only add noise in big repos
  '.angular', '.nx', '.svelte-kit', '.output', '.vercel', '.expo', 'storybook-static',
  'generated', '__generated__', 'assets', 'public', 'tmp', 'temp', '.terraform',
  'hls', 'media', 'videos', 'renders', '.venv-tts',
]);

// Source code only: templates, styles, JSON, docs and config would double or triple the node count
// of a large project (an Angular component is .ts + .html + .scss + .spec.ts) without adding meaning.
const CODE_EXT = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.svelte', '.py', '.go', '.rs',
  '.java', '.kt', '.cs', '.php', '.rb', '.swift', '.dart', '.c', '.h', '.cpp', '.hpp',
]);

const RESOLVE_EXT = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.py',
  '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/__init__.py'];

const MAX_FILES = 6000;
const MAX_MODULE = 80; // a folder with more files than this is split into its sub-folders
const MIN_MODULE = 4;  // sub-folders smaller than this stay with their parent
const WRAPPERS = new Set(['src', 'app', 'apps', 'lib', 'libs', 'packages', 'modules', 'module', 'features',
  'feature', 'source', 'sources', 'main', 'pkg', 'internal', 'cmd', 'core', 'java', 'kotlin', 'python']);

/**
 * Group files into modules of a readable size. Big folders are split by sub-folder until each
 * module has at most MAX_MODULE files; wrapper folders (src, app, modules…) are skipped in names,
 * so "vruksha-frontend/src/app/modules/sales/x.ts" lands in "vruksha-frontend/sales".
 * @returns {{ moduleOfId: Map<string,string>, prefixes: Map<string,string> }} prefixes: module -> folder path
 */
export function assignModules(ids) {
  const moduleOfId = new Map();
  const prefixes = new Map();
  const put = (list, label, prefix) => {
    for (const id of list) moduleOfId.set(id, label);
    if (!prefixes.has(label)) prefixes.set(label, prefix);
  };
  // Returns the biggest module created for this subtree as { label, prefix, size }.
  const split = (list, depth, label, prefix) => {
    if (label && list.length <= MAX_MODULE) { put(list, label, prefix); return { label, prefix, size: list.length }; }
    const groups = new Map(); const here = [];
    for (const id of list) {
      const parts = id.split('/');
      if (parts.length - 1 > depth) {
        if (!groups.has(parts[depth])) groups.set(parts[depth], []);
        groups.get(parts[depth]).push(id);
      } else here.push(id);
    }
    let biggest = null;
    for (const [seg, sub] of groups) {
      if (label && sub.length < MIN_MODULE) { here.push(...sub); continue; }
      const subLabel = isWrapper(seg) ? label : (label ? `${label}/${seg}` : seg);
      const b = split(sub, depth + 1, subLabel, `${prefix}${seg}/`);
      if (!biggest || b.size > biggest.size) biggest = b;
    }
    if (!here.length) return biggest;
    // A few loose files next to big sub-folders join the biggest one instead of forming a tiny module.
    if (biggest && label && here.length < MIN_MODULE) {
      for (const id of here) moduleOfId.set(id, biggest.label);
      biggest.size += here.length;
      return biggest;
    }
    put(here, label || 'root', prefix);
    return !biggest || here.length > biggest.size ? { label: label || 'root', prefix, size: here.length } : biggest;
  };
  split(ids, 0, '', '');
  return { moduleOfId, prefixes };
}

/** Binary check on the first 2 KB: NUL bytes, or MPEG-TS sync bytes (0x47 every 188 bytes). */
function isBinary(abs) {
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(2048);
    const n = fs.readSync(fd, buf, 0, 2048, 0);
    if (n >= 377 && buf[0] === 0x47 && buf[188] === 0x47 && buf[376] === 0x47) return true;
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
    return false;
  } finally { fs.closeSync(fd); }
}

/** Folders that only organise code: src/app/modules…, Next.js route groups "(auth)" and params "[id]". */
const isWrapper = (seg) => WRAPPERS.has(seg.toLowerCase()) || /^\(.*\)$|^\[.*\]$/.test(seg);

/** Module for a file that appeared after the scan: the module with the longest matching folder. */
export function moduleFor(rel, modulePrefixes) {
  let best = null; let len = -1;
  for (const [label, prefix] of Object.entries(modulePrefixes || {})) {
    if (prefix && rel.startsWith(prefix) && prefix.length > len) { best = label; len = prefix.length; }
  }
  return best || moduleOf(rel);
}
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
  // Read every file first so binary files with a code extension (e.g. .ts video segments of an
  // HLS stream) are dropped before modules are formed.
  const texts = new Map(); const keep = [];
  for (const abs of absFiles) {
    const rel = toRel(root, abs);
    if (!rel) continue;
    let text = '';
    try {
      if (isBinary(abs)) continue;
      if (fs.statSync(abs).size <= MAX_BYTES) text = fs.readFileSync(abs, 'utf8');
    } catch { /* unreadable file: keep as node with no imports */ }
    texts.set(rel, text);
    keep.push([abs, rel]);
  }
  const fileSet = new Set(texts.keys());
  const modules = assignModules([...fileSet]);
  const nodes = [];
  const edges = [];
  const edgeKeys = new Set();

  keep.forEach(([, rel]) => {
    const text = texts.get(rel);
    const loc = text ? text.split('\n').length : 1;
    nodes.push({ id: rel, name: path.posix.basename(rel), module: modules.moduleOfId.get(rel) || moduleOf(rel), loc });
    const ext = path.extname(rel).toLowerCase();
    for (const imp of importsOf(text, ext)) {
      const target = resolveSpec(rel, imp, fileSet);
      if (target && target !== rel) {
        const key = rel + '->' + target;
        if (!edgeKeys.has(key)) { edgeKeys.add(key); edges.push({ source: rel, target }); }
      }
    }
  });

  return {
    root, name: path.basename(root), scannedAt: new Date().toISOString(), nodes, edges,
    modulePrefixes: Object.fromEntries(modules.prefixes),
  };
}
