#!/usr/bin/env node
// Publishes dist/ai-dev-monitor-<version>.vsix (build it first: npm run ext:build).
//   VSCE_PAT=... node scripts/publish-extension.js   -> VS Code Marketplace (publisher "selvadev")
//   OVSX_PAT=... node scripts/publish-extension.js   -> Open VSX (namespace "selvadev")
// With both tokens set it publishes to both. A store without a token is skipped.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { name, version, publisher } = JSON.parse(fs.readFileSync(path.join(ROOT, 'vscode-extension', 'package.json'), 'utf8'));
const vsix = path.join(ROOT, 'dist', `${name}-${version}.vsix`);
if (!fs.existsSync(vsix)) { console.error(`${vsix} not found. Run: npm run ext:build`); process.exit(1); }
const { VSCE_PAT, OVSX_PAT } = process.env;
if (!VSCE_PAT && !OVSX_PAT) {
  console.error('Set VSCE_PAT (Marketplace) and/or OVSX_PAT (Open VSX).');
  process.exit(process.env.CI ? 0 : 1); // in CI: no secrets yet, so nothing to publish
}

// tokens go through the environment, never on the command line (they would show in process lists and logs)
const run = (cmd, env) => { console.log(`> ${cmd}`); execSync(cmd, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } }); };
const failed = [];
// --skip-duplicate: a version already in the store (e.g. uploaded by hand) is not an error
if (VSCE_PAT) {
  try { run(`npx --yes @vscode/vsce@3.2.1 publish --packagePath "${vsix}" --skip-duplicate`, { VSCE_PAT }); } catch { failed.push('VS Code Marketplace'); }
}
if (OVSX_PAT) {
  // the namespace must exist before the first publish; creating it again just fails, which is fine
  try { run(`npx --yes ovsx@0.10.1 create-namespace ${publisher}`, { OVSX_PAT }); } catch { console.log(`(namespace ${publisher} already exists)`); }
  try { run(`npx --yes ovsx@0.10.1 publish "${vsix}" --skip-duplicate`, { OVSX_PAT }); } catch { failed.push('Open VSX'); }
}
if (failed.length) { console.error(`\nPublishing failed for: ${failed.join(', ')}`); process.exit(1); }
console.log(`\nPublished ${publisher}.${name} ${version}.`);
