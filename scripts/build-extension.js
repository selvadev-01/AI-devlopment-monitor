#!/usr/bin/env node
// Bundles server/ + web/ into vscode-extension/, installs its runtime deps and packages a .vsix.
//   node scripts/build-extension.js            -> dist/ai-dev-monitor-<version>.vsix
//   node scripts/build-extension.js --install  -> also installs it into VS Code (code CLI)
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'vscode-extension');
const DIST = path.join(ROOT, 'dist');
const run = (cmd, cwd = ROOT) => { console.log(`> ${cmd}`); execSync(cmd, { cwd, stdio: 'inherit' }); };

for (const dir of ['server', 'web']) {
  fs.rmSync(path.join(EXT, dir), { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, dir), path.join(EXT, dir), { recursive: true });
}
fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(EXT, 'LICENSE'));
// server/ is ESM while extension.js is CommonJS: mark the folder as a module scope.
fs.writeFileSync(path.join(EXT, 'server', 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n');

run('npm install --omit=dev --no-audit --no-fund', EXT);

const { version, name } = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
fs.mkdirSync(DIST, { recursive: true });
const vsix = path.join(DIST, `${name}-${version}.vsix`);
run(`npx --yes @vscode/vsce@3.2.1 package -o "${vsix}"`, EXT);
console.log(`\nBuilt ${vsix}`);

if (process.argv.includes('--install')) {
  // builds before 0.2.6 were published as local.ai-dev-monitor: remove that copy, or two monitors fight over the port
  try { execSync('code --uninstall-extension local.ai-dev-monitor', { stdio: 'ignore' }); console.log('> removed the old local.ai-dev-monitor build'); } catch { /* not installed */ }
  run(`code --install-extension "${vsix}" --force`);
  console.log('Installed. Run "Developer: Reload Window" in VS Code to activate it.');
}
