import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  systemFromUrl, parseLaunchpadUrl, isDefaultHost, guessEdition, looksLikeLaunchpad,
  chunkArray, byteSize, readChunked, writeChunked, migrateSnapshot, memoryArea, createStorage, buildSeedEntries, validateSystems, normalizeSystem, SCHEMA_VERSION, KEYS,
} from '../src/storage.js';

const mk = () => createStorage({ sync: memoryArea(), local: memoryArea(), session: memoryArea() });

test('chunkArray respects byte budget', () => {
  const items = Array.from({ length: 300 }, (_, i) => ({ alias: `a${i}`, title: 'x'.repeat(50) }));
  const chunks = chunkArray(items, 2000);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => byteSize(c) <= 2000));
  assert.equal(chunks.flat().length, 300);
  assert.deepEqual(chunkArray([], 100), [[]]);
  assert.equal(chunkArray([{ big: 'y'.repeat(500) }], 100).length, 1);
});

test('writeChunked/readChunked round-trip and stale chunk removal', async () => {
  const area = memoryArea({ userAliases: [{ alias: 'legacy' }] });
  assert.deepEqual(await readChunked(area, 'userAliases'), [{ alias: 'legacy' }]);
  const many = Array.from({ length: 200 }, (_, i) => ({ alias: `a${i}`, title: 'x'.repeat(40) }));
  await writeChunked(area, 'userAliases', many, 1500);
  assert.equal('userAliases' in area.data, false);
  const n = area.data['userAliases.meta'].chunks;
  assert.ok(n > 1);
  assert.deepEqual(await readChunked(area, 'userAliases'), many);
  await writeChunked(area, 'userAliases', many.slice(0, 5), 1500);
  assert.equal(area.data['userAliases.meta'].chunks, 1);
  assert.equal(Object.keys(area.data).filter((k) => k.startsWith('userAliases.')).length, 2);
  assert.deepEqual(await readChunked(area, 'userAliases'), many.slice(0, 5));
});

test('migrateSnapshot v0 → v1', () => {
  const out = migrateSnapshot({
    sync: { systems: [{ key: 'ACD', host: 'https://My1.s4hana.cloud.sap/ui', env: 'dev', isDefault: true }], aliases: [{ alias: 'po', semanticObject: 'PurchaseOrder', action: 'manage', title: 'x' }] },
    local: {},
  });
  assert.equal(out.sync.schemaVersion, SCHEMA_VERSION);
  assert.equal(out.sync.systems[0].key, 'acd');
  assert.equal(out.sync.systems[0].host, 'my1.s4hana.cloud.sap');
  assert.equal(out.sync.systems[0].launchpadPath, '/ui');
  assert.equal(out.sync.systems[0].env, 'DEV');
  assert.equal(out.sync.aliases, undefined);
  assert.equal(out.sync.userAliases[0].source, 'user');
  assert.deepEqual(out.sync.hiddenAliases, []);
  assert.equal(out.sync.settings.autoScanDays, 7);
  assert.deepEqual(out.local.discovered, {});
  assert.deepEqual(migrateSnapshot(out), out); // idempotent
});

test('validateSystems', () => {
  const ok = [normalizeSystem({ key: 'acd', host: 'my1.s4hana.cloud.sap', isDefault: true })];
  assert.deepEqual(validateSystems(ok), []);
  const bad = [normalizeSystem({ key: 'A B', host: 'bad host!', isDefault: false }), normalizeSystem({ key: 'a b', host: 'x', isDefault: false })];
  const errors = validateSystems(bad);
  assert.ok(errors.some((e) => e.includes('key')));
  assert.ok(errors.some((e) => e.includes('host')));
  assert.ok(errors.some((e) => e.includes('default')));
});

test('createStorage: typed api, migrate, export/import round-trip', async () => {
  const s = mk();
  await s.migrate();
  await s.setSystems([{ key: 'acd', name: 'A', customer: 'A', host: 'my1.s4hana.cloud.sap', env: 'DEV', isDefault: true }]);
  await s.setUserAliases([{ alias: 'po', semanticObject: 'PurchaseOrder', action: 'manage', title: 'Manage POs' }]);
  await s.setHiddenAliases(['F0842']);
  await s.setDiscovered('my1.s4hana.cloud.sap', { scannedAt: '2026-01-01T00:00:00Z', entries: [{ intent: 'A-b', title: 't' }] });
  await s.pushRecent({ ts: 1, intent: 'A-b' });
  await s.setLastUsedSystemKey('acd');
  await s.setPendingRescan('my1.s4hana.cloud.sap', true);
  assert.equal(await s.getPendingRescan('my1.s4hana.cloud.sap'), true);
  await s.setPendingRescan('my1.s4hana.cloud.sap', false);
  assert.equal(await s.getPendingRescan('my1.s4hana.cloud.sap'), false);
  assert.deepEqual((await s.getScanMeta())['my1.s4hana.cloud.sap'], { lastScanned: '2026-01-01T00:00:00Z', appCount: 1 });
  // Shell-startGUI exists on Public Cloud tenants too, so the scan must not infer an edition from it.
  await s.setDiscovered('op.example', { scannedAt: '2026-01-01T00:00:00Z', entries: [{ intent: 'Shell-startGUI', title: 'gui' }] });
  assert.equal('detectedEdition' in (await s.getScanMeta())['op.example'], false);
  await assert.rejects(() => s.setSystems([{ key: 'x', host: 'bad host' }]));

  const exported = await s.exportJson();
  const t = mk();
  await t.migrate();
  await t.importJson(exported);
  const a = await s.loadSnapshot();
  const b = await t.loadSnapshot();
  assert.deepEqual(b.systems, a.systems);
  assert.deepEqual(b.userAliases, a.userAliases);
  assert.deepEqual(b.hiddenAliases, ['f0842']);
  assert.deepEqual(b.settings, a.settings);
  await assert.rejects(() => t.importJson({ foo: 1 }));
});

test('buildSeedEntries merges aliases, library and tcodes; applySeed respects version', async () => {
  const aliasesCsv = 'alias,semanticObject,action,appId,tcodes,title,paramKey\nme21n,PurchaseOrder,create,F0842A,ME21N,Create Purchase Order,\n';
  const libraryCsv = 'alias,semanticObject,action,appId,tcodes,title,paramKey\nf0842a,PurchaseOrder,manage,F0842A,,Manage Purchase Orders,\nf1873,SalesOrder,manage,F1873,,Manage Sales Orders,\n';
  const tcodesCsv = 'tcode,semanticObject,action,appId,paramKey,confidence,note\nme22n;me2l,PurchaseOrder,manage,,PurchaseOrder,high,\nva41,SalesContract,manage,,,low,Manage Sales Contracts\n';
  const { entries, errors } = buildSeedEntries({ aliasesCsv, libraryCsv, tcodesCsv });
  assert.deepEqual(errors, []);
  const po = entries.find((e) => e.intent === 'PurchaseOrder-manage');
  assert.deepEqual(po.tcodes, ['me22n', 'me2l']);
  assert.equal(po.paramKey, 'PurchaseOrder');
  assert.equal(po.source, 'library');
  assert.equal(entries.find((e) => e.intent === 'SalesContract-manage').source, 'seed');
  const s = mk();
  const r1 = await s.applySeed({ aliasesCsv, libraryCsv, tcodesCsv, version: '1' });
  assert.equal(r1.applied, true);
  assert.equal((await s.getSeedAliases()).length, 4);
  const r2 = await s.applySeed({ aliasesCsv, libraryCsv, tcodesCsv, version: '1' });
  assert.equal(r2.applied, false);
  await s.setUserAliases([{ alias: 'mine', semanticObject: 'X', action: 'y', title: 'Mine' }]);
  await s.applySeed({ aliasesCsv, libraryCsv, tcodesCsv, version: '2' });
  assert.equal((await s.getUserAliases()).length, 1); // seed never touches user rows
});

test('systemFromUrl builds a row from a pasted URL', () => {
  const a = systemFromUrl('https://my419228.s4hana.cloud.sap', []);
  assert.deepEqual(a, { key: 'my419228', name: 'my419228.s4hana.cloud.sap', customer: '', host: 'my419228.s4hana.cloud.sap', scheme: 'https', launchpadPath: '/ui', launchpadQuery: '', env: 'TST', edition: 'public', isDefault: true });
  const b = systemFromUrl('https://acd.finteq.io/ui#Shell-home', [a]);
  assert.equal(b.key, 'acd');
  assert.equal(b.customer, 'finteq');
  assert.equal(b.host, 'acd.finteq.io');
  assert.equal(b.launchpadPath, '/ui');
  assert.equal(b.isDefault, false);
  assert.equal(systemFromUrl('MY419228.s4hana.cloud.sap/sap/bc/ui2/flp?x=1#Shell-home', []).launchpadPath, '/sap/bc/ui2/flp');
  assert.equal(systemFromUrl('https://dev.customer.example', []).env, 'DEV');
  assert.equal(systemFromUrl('https://prd-erp.customer.example', []).env, 'PRD');
  assert.equal(systemFromUrl('https://acd.finteq.io', [{ key: 'acd' }, { key: 'acd2' }]).key, 'acd3');
  const op = systemFromUrl('https://acd.finteq.io:8443/sap/bc/ui2/flp?sap-client=600#Shell-home', []);
  assert.equal(op.host, 'acd.finteq.io:8443');
  assert.equal(op.key, 'acd');
  assert.equal(op.customer, 'finteq');
  assert.equal(op.launchpadPath, '/sap/bc/ui2/flp');
  assert.equal(op.launchpadQuery, 'sap-client=600');
  assert.equal(op.scheme, 'https');
  assert.equal(op.edition, 'onprem');
  assert.equal(guessEdition('my300001.s4hana.ondemand.com'), 'public');
  assert.equal(normalizeSystem({ host: 'x.y', edition: 'private' }).edition, 'private');
  assert.equal(normalizeSystem({ host: 'x.y', edition: 'bogus' }).edition, 'onprem');
  assert.deepEqual(validateSystems([op]), []);
  assert.equal(systemFromUrl('http://erp.internal.example:8000/sap/bc/ui2/flp?sap-client=100&sap-language=EN', []).launchpadQuery, 'sap-client=100&sap-language=EN');
  assert.equal(systemFromUrl('http://erp.internal.example:8000/', []).scheme, 'http');
  assert.equal(isDefaultHost('my1.s4hana.cloud.sap:443'), true);
  assert.equal(systemFromUrl('not a url', []), null);
  assert.equal(systemFromUrl('ftp://x.y', []), null);
  assert.equal(systemFromUrl('localhost', []), null);
  assert.deepEqual(parseLaunchpadUrl('https://a.b.c/'), { scheme: 'https', host: 'a.b.c', launchpadPath: '/ui', launchpadQuery: '' });
  assert.equal(isDefaultHost('my1.s4hana.cloud.sap'), true);
  assert.equal(isDefaultHost('acd.finteq.io'), false);
});

test('looksLikeLaunchpad heuristics', () => {
  assert.equal(looksLikeLaunchpad('https://my419228.s4hana.cloud.sap/ui#Shell-home'), true);
  assert.equal(looksLikeLaunchpad('https://my419228.s4hana.cloud.sap/'), true);
  assert.equal(looksLikeLaunchpad('https://acd.finteq.io:8443/sap/bc/ui2/flp?sap-client=600#Shell-home'), true);
  assert.equal(looksLikeLaunchpad('https://acd.finteq.io/ui#PurchaseOrder-manage'), true);
  assert.equal(looksLikeLaunchpad('https://acd.finteq.io/ui'), false); // too generic without an intent hash
  assert.equal(looksLikeLaunchpad('https://erp.example/portal?sap-client=100#SalesOrder-manage'), true);
  assert.equal(looksLikeLaunchpad('https://www.google.com/'), false);
  assert.equal(looksLikeLaunchpad('chrome://extensions'), false);
  assert.equal(looksLikeLaunchpad('nonsense'), false);
});
