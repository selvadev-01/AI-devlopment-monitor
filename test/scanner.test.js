// Module grouping: big folders split, wrapper folders skipped, tiny folders and loose files merged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignModules, moduleFor, toRel } from '../server/scanner.js';

const files = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}/f${i}.ts`);

test('a small project keeps one module per top folder', () => {
  const { moduleOfId } = assignModules([...files('api', 5), ...files('ui', 6)]);
  assert.equal(moduleOfId.get('api/f0.ts'), 'api');
  assert.equal(moduleOfId.get('ui/f5.ts'), 'ui');
});

test('a folder over 80 files splits into its sub-folders, skipping wrapper folders', () => {
  const ids = [...files('backend/src/modules/billing', 50), ...files('backend/src/modules/auth', 45)];
  const { moduleOfId } = assignModules(ids);
  assert.equal(moduleOfId.get('backend/src/modules/billing/f0.ts'), 'backend/billing');
  assert.equal(moduleOfId.get('backend/src/modules/auth/f0.ts'), 'backend/auth');
});

test('sub-folders under 4 files and a few loose files join the biggest sibling', () => {
  const ids = [...files('erp/sales', 60), ...files('erp/hr', 30), ...files('erp/tiny', 2), 'erp/index.ts'];
  const { moduleOfId } = assignModules(ids);
  // 93 files under erp/ -> split; "tiny" (2) + 1 loose file = 3 < 4, so they join "sales", the biggest
  assert.equal(moduleOfId.get('erp/sales/f0.ts'), 'erp/sales');
  assert.equal(moduleOfId.get('erp/tiny/f0.ts'), 'erp/sales');
  assert.equal(moduleOfId.get('erp/index.ts'), 'erp/sales');
  assert.equal(moduleOfId.get('erp/hr/f0.ts'), 'erp/hr');
});

test('sibling wrapper folders in a big folder do not merge into one oversized module', () => {
  const ids = [...files('web/(marketing)/pricing', 50), ...files('web/[locale]/docs', 50)];
  const { moduleOfId } = assignModules(ids);
  assert.equal(moduleOfId.get('web/(marketing)/pricing/f0.ts'), 'web/pricing');
  assert.equal(moduleOfId.get('web/[locale]/docs/f0.ts'), 'web/docs');
});

test('a new file lands in the module with the longest matching folder', () => {
  const prefixes = { 'backend/billing': 'backend/src/modules/billing/', backend: 'backend/' };
  assert.equal(moduleFor('backend/src/modules/billing/refund.ts', prefixes), 'backend/billing');
  assert.equal(moduleFor('backend/other/x.ts', prefixes), 'backend');
});

test('paths outside the project are not relative', () => {
  assert.equal(toRel('/p/app', '/p/app/src/a.ts'), 'src/a.ts');
  assert.equal(toRel('/p/app', '/p/other/a.ts'), null);
});
