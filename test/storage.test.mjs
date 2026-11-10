import { test } from 'node:test';
import { clientOf, targetKey, systemByTarget, systemForUrl, isOnTarget, systemFromUrl as sysFromUrl } from '../src/storage.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  systemFromUrl, parseLaunchpadUrl, isDefaultHost, guessEdition, looksLikeLaunchpad, editionFromSystemInfo, sanitizeSystemInfo, describeSystemInfo, pickProductLine, splitProductLines,
  chunkArray, byteSize, readChunked, writeChunked, migrateSnapshot, memoryArea, createStorage, buildSeedEntries, validateSystems, normalizeSystem, SCHEMA_VERSION, KEYS,
  sanitizeSettings, sanitizeDiscoveredRecord, DEFAULT_SETTINGS,
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
  assert.equal(out.sync.systems[0].key, 'ACD'); // keys keep their case
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
  assert.deepEqual((await s.getScanMeta())['my1.s4hana.cloud.sap'], { lastScanned: '2026-01-01T00:00:00Z', appCount: 1, system: null, detectedEdition: null });
  // Shell-startGUI exists on Public Cloud tenants too, so the intents never decide the edition; the About-dialog product does.
  await s.setDiscovered('op.example', { scannedAt: '2026-01-01T00:00:00Z', entries: [{ intent: 'Shell-startGUI', title: 'gui' }], system: { productName: 'SAP S/4HANA', productVersion: 'SAP S/4HANA 2023 FPS02', systemRole: 'Development System', junk: 'x' } });
  assert.deepEqual((await s.getScanMeta())['op.example'].system, { productName: 'SAP S/4HANA', productVersion: 'SAP S/4HANA 2023 FPS02', systemRole: 'Development System' });
  assert.equal((await s.getScanMeta())['op.example'].detectedEdition, 'onprem');
  // live About fields: stored without a scan date on an unscanned host; merged into an existing scan without touching its apps
  assert.deepEqual(await s.setScanSystemInfo('fresh.example', { productVersion: 'SAP S/4HANA CLOUD 2508', nope: 1 }, '1.130.0'), { lastScanned: null, appCount: 0, system: { productVersion: 'SAP S/4HANA CLOUD 2508' }, detectedEdition: 'public', ui5Version: '1.130.0' });
  await s.setScanSystemInfo('op.example', { productVersion: 'SAP S/4HANA Cloud Private Edition 2023' });
  assert.deepEqual((await s.getScanMeta())['op.example'], { lastScanned: '2026-01-01T00:00:00Z', appCount: 1, system: { productVersion: 'SAP S/4HANA Cloud Private Edition 2023' }, detectedEdition: 'private' });
  assert.equal((await s.getDiscovered('op.example')).entries.length, 1);
  assert.equal((await s.getDiscovered('op.example')).system.productVersion, 'SAP S/4HANA Cloud Private Edition 2023');
  assert.equal(await s.getDiscovered('fresh.example'), null, 'no discovered record is invented');
  assert.deepEqual((await s.setScanSystemInfo('op.example', null)).system, null);

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
  assert.equal(op.key, 'acd600', 'the client joins the key');
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

test('editionFromSystemInfo classifies About-dialog product strings conservatively', () => {
  assert.equal(editionFromSystemInfo({ productName: 'SAP S/4HANA Cloud', productVersion: 'SAP S/4HANA CLOUD 2508' }), 'public');
  assert.equal(editionFromSystemInfo({ productVersion: 'SAP S/4HANA Cloud Public Edition' }), 'public');
  assert.equal(editionFromSystemInfo({ productVersion: 'SAP S/4HANA Cloud Private Edition 2023' }), 'private');
  assert.equal(editionFromSystemInfo({ productVersion: 'SAP S/4HANA 2023 FPS01' }), 'onprem');
  assert.equal(editionFromSystemInfo({ productVersion: 'SAP S/4HANA 1909' }), 'onprem');
  assert.equal(editionFromSystemInfo({ productVersion: 'SAP S/4HANA Cloud' }), null, 'cloud without a release or "public" is not enough');
  assert.equal(editionFromSystemInfo({ productVersion: 'S4CORE 109' }), null);
  assert.equal(editionFromSystemInfo(null), null);
  assert.deepEqual(sanitizeSystemInfo({ productVersion: '  x  ', client: 100, nope: 'y', appVersion: '2025.0.23', systemRole: { v: 1 } }), { productVersion: 'x', client: '100', appVersion: '2025.0.23' }, 'numbers are kept as strings, objects dropped');
  assert.equal(sanitizeSystemInfo({ appVersion: 'v'.repeat(500) }).appVersion.length, 120);
  assert.equal(sanitizeSystemInfo({}), null);
  assert.equal(describeSystemInfo({ productName: 'SAP S/4HANA Cloud', productVersion: 'SAP S/4HANA CLOUD 2508' }), 'SAP S/4HANA CLOUD 2508');
  assert.equal(describeSystemInfo({ productName: 'SAP S/4HANA', productVersion: '2023' }), 'SAP S/4HANA 2023');
  assert.equal(describeSystemInfo({ productName: 'SAP S/4HANA', productVersion: 'SAP S/4HANA 2025', appVersion: '2025.0.23' }), 'SAP S/4HANA 2025 · 2025.0.23');
  assert.equal(describeSystemInfo({ appVersion: '2025.0.23' }), '2025.0.23', 'the Application version alone still describes the system');
  assert.equal(describeSystemInfo({ productVersion: 'SAP S/4HANA 2025.0.23', appVersion: '2025.0.23' }), 'SAP S/4HANA 2025.0.23', 'not repeated when the product line already contains it');
  assert.equal(editionFromSystemInfo({ appVersion: '2025.0.23' }), null, 'the application version never decides the edition');
});

test('on-premise getProductVersion() lists every installed product: the S/4HANA line is the product version', () => {
  // verbatim from an S/4HANA 2025 on-premise system (getProductName() is undefined there, getSystemRole() is the number 1)
  const raw = { productVersion: 'SAP SCREEN PERSONAS 3.0\r\nSAP SMART BUSINESS FOR FND 1.0\r\nSAP SMART BUSINESS FOR ERP 1.0\r\nSAP ANALYTICS FOUNDATION 1.0\r\nSAP S/4HANA 2025\r\nABAP PLATFORM 2025\r\nSAP S/4HANA FOUNDATION 2025\r\nSAP FIORI FOR SAP S/4HANA 2025\r\nSAP FIORI FES 2025 FOR S/4HANA', client: '600', clientRole: 'D', systemRole: 1, tenantRole: 'tenant role', getName: 'ACD' };
  const info = sanitizeSystemInfo(raw);
  assert.equal(info.productVersion, 'SAP S/4HANA 2025');
  assert.equal(info.productVersions, 'SAP SCREEN PERSONAS 3.0 · SAP SMART BUSINESS FOR FND 1.0 · SAP SMART BUSINESS FOR ERP 1.0 · SAP ANALYTICS FOUNDATION 1.0 · SAP S/4HANA 2025 · ABAP PLATFORM 2025 · SAP S/4HANA FOUNDATION 2025 · SAP FIORI FOR SAP S/4HANA 2025 · SAP FIORI FES 2025 FOR S/4HANA');
  assert.equal(info.clientRole, 'D');
  assert.equal(info.systemRole, '1');
  assert.equal(info.getName, undefined);
  assert.equal(editionFromSystemInfo(info), 'onprem', 'the 120-character cap used to cut the list before the S/4HANA line and left the edition undecided');
  assert.equal(describeSystemInfo({ ...info, appVersion: '2025.0.23' }), 'SAP S/4HANA 2025 · 2025.0.23');
  assert.equal(sanitizeSystemInfo({ productVersion: 'SAP S/4HANA CLOUD 2508' }).productVersions, undefined, 'a single line stays as it is');
  assert.equal(sanitizeSystemInfo({ productVersion: 'A\nB', productVersions: 'already provided' }).productVersions, 'already provided');
  assert.equal(sanitizeSystemInfo({ productVersions: 'x'.repeat(1000) }).productVersions.length, 600);
  assert.deepEqual(splitProductLines(' A \r\n\nB\n'), ['A', 'B']);
  assert.equal(pickProductLine(['SAP FIORI FOR SAP S/4HANA 2025', 'SAP S/4HANA FOUNDATION 2025', 'SAP S/4HANA 2025']), 'SAP S/4HANA 2025');
  assert.equal(pickProductLine(['ABAP PLATFORM 2025', 'SAP FIORI FOR SAP S/4HANA 2025']), 'SAP FIORI FOR SAP S/4HANA 2025', 'a secondary S/4HANA line beats a non-S/4HANA line');
  assert.equal(pickProductLine(['SAP S/4HANA CLOUD PRIVATE EDITION 2023', 'SAP FIORI FES 2023']), 'SAP S/4HANA CLOUD PRIVATE EDITION 2023');
  assert.equal(pickProductLine(['ABAP PLATFORM 2025', 'SAP BW/4HANA 2023']), 'ABAP PLATFORM 2025', 'no S/4HANA line: the first line');
  assert.equal(pickProductLine([]), '');
  assert.equal(pickProductLine('SAP S/4HANA 2023 FPS01'), 'SAP S/4HANA 2023 FPS01');
});

test('normalizeSystem: a hash or query pasted into the path/query fields never reaches the generated URL', () => {
  const s = normalizeSystem({ key: 'acd', host: 'acd.finteq.io:8443', launchpadPath: '/sap/bc/ui2/flp#Shell-home', launchpadQuery: 'sap-client=600#Shell-home' });
  assert.equal(s.launchpadPath, '/sap/bc/ui2/flp');
  assert.equal(s.launchpadQuery, 'sap-client=600');
  const t = normalizeSystem({ key: 'acd', host: 'acd.finteq.io:8443', launchpadPath: '/sap/bc/ui2/flp?sap-client=600#Shell-home', launchpadQuery: '?sap-language=EN' });
  assert.equal(t.launchpadPath, '/sap/bc/ui2/flp');
  assert.equal(t.launchpadQuery, 'sap-client=600&sap-language=EN');
  assert.equal(normalizeSystem({ key: 'x', host: 'h', launchpadPath: '#Shell-home' }).launchpadPath, '/ui', 'a hash alone falls back to the default path');
});

test('buildSeedEntries: the t-code → app table attaches codes to library apps, and reports the rest as info', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const { entries, errors } = buildSeedEntries({ libraryCsv: read('../src/seed/library.csv'), tcodesCsv: read('../src/seed/tcodes.csv'), tcodeAppsJson: read('../src/seed/tcode-apps.json') });
  const has = (code) => entries.filter((e) => e.tcodes.includes(code));
  assert.deepEqual(has('ksu5').map((e) => e.appId), ['F3337'], 'KSU5 → Run Allocations by app ID');
  assert.deepEqual([...new Set(has('st22').map((e) => e.intent))], ['ABAPSystem-displayRuntimeErrors'], 'ST22 → ABAP Runtime Errors (F7770)');
  assert.deepEqual([...new Set(has('sm37').map((e) => `${e.intent}/${e.confidence}`))], ['ApplicationJob-show/high'], 'SM37 → Application Jobs F1240 by its real intent');
  assert.deepEqual([...new Set(has('sm36').map((e) => e.appId))], ['F1240']);
  assert.deepEqual([...new Set([...has('sm19'), ...has('sm20')].map((e) => `${e.intent}/${e.appId}`))], ['SecurityAuditLog-displayV2/F4204A'], 'SM19 and SM20 → Display Security Audit Log');
  assert.deepEqual([...new Set(has('sm59').map((e) => e.appId))], ['F1762'], 'SM59 → Communication Systems, no longer Carry Forward Balances');
  assert.deepEqual([...new Set(has('soamanager').map((e) => e.appId))], ['F1763']);
  assert.deepEqual(has('gcts').map((e) => `${e.alias}/${e.intent}`), ['f4158/GCTSRepository-manage'], 'gcts → Git-enabled CTS F4158, the primary entry only');
  assert.deepEqual(has('sm12').map((e) => e.appId).sort(), ['F5708', 'F6049'], 'SM12 → user sessions (all, own); SMENQ likewise');
  assert.deepEqual(has('smenq').map((e) => e.appId).sort(), ['F5708', 'F6049']);
  assert.deepEqual([...new Set(has('sm13').map((e) => e.intent))].sort(), ['AIFMessage-manage', 'ApplicationLog-showList'], 'SM13 → application logs and the AIF message dashboard');
  assert.deepEqual([...new Set(has('sm21').map((e) => e.appId))].sort(), ['F1487', 'F4106'], 'SM21 → application logs and the authorization trace');
  assert.deepEqual([...new Set(has('slg1').map((e) => e.appId))], ['F1487'], 'SLG1 → Application Logs is F1487, the library row, not a standalone seed');
  assert.ok(['su53', 'st01', 'stauthtrace'].every((c) => has(c).some((e) => e.appId === 'F4106')), 'SU53, ST01 and STAUTHTRACE → Display Authorization Trace');
  assert.deepEqual(has('fb03').filter((e) => e.appId === 'F0717').map((e) => e.alias), ['f0717', 'f0717-3'], 'the primary entry of the nine-intent app from the app table, plus the AccountingDocument-manage row tcodes.csv names');
  assert.ok(has('mb22').length >= 1 && has('mb22').every((e) => /^Manage Reservations$/i.test(e.title)), 'no app ID: matched by title');
  assert.ok(has('me23n').some((e) => e.appId === 'F0842A'), 'a code already in tcodes.csv is also attached to the mapped app');
  assert.ok(errors.every((e) => e.info), 'only informational messages');
  assert.ok(errors.some((e) => /snote/i.test(e.message)), 'SNOTE has no app');
  assert.ok(errors.length < 60, `unmapped codes: ${errors.length}`);
  assert.deepEqual(buildSeedEntries({ tcodeAppsJson: '[not json' }).errors.map((e) => e.file), ['tcode-apps.json']);
});

test('system keys keep their case; lookups, duplicates and typing ignore it', async () => {
  const s = normalizeSystem({ key: 'MyDev', host: 'my1.s4hana.cloud.sap', isDefault: true });
  assert.equal(s.key, 'MyDev');
  assert.deepEqual(validateSystems([s]), []);
  assert.ok(validateSystems([s, normalizeSystem({ key: 'mydev', host: 'my2.s4hana.cloud.sap' })]).some((e) => /duplicate key/.test(e)), 'the same key in another case is a duplicate');
});

test('import hardening: settings, discovered records and scan metadata from a backup file are bounded and typed', async () => {
  assert.deepEqual(sanitizeSettings({ suggestionLimit: 999, autoScanDays: -3, reuseTabOnSameHost: 'yes', copyUnresolved: true, bogus: 1 }), { ...DEFAULT_SETTINGS, suggestionLimit: 10, autoScanDays: 0, copyUnresolved: true }, 'clamped, coerced, unknown keys dropped');
  assert.deepEqual(sanitizeSettings(null), { ...DEFAULT_SETTINGS });
  const rec = sanitizeDiscoveredRecord({ scannedAt: 'x'.repeat(100), ui5Version: '1.' + '2'.repeat(100), methods: { links: 'L'.repeat(500), nested: { deep: 1 }, n: 3, ['k'.repeat(50)]: 'v' }, errors: Array.from({ length: 40 }, () => 'e'.repeat(1000)), entries: 'not an array', system: { productVersion: 'SAP S/4HANA 2025', secret: 'x' } });
  assert.equal(rec.scannedAt.length, 40);
  assert.equal(rec.ui5Version.length, 40);
  assert.deepEqual(rec.methods, { links: 'L'.repeat(200), n: 3 }, 'scalar method fields only, bounded');
  assert.equal(rec.errors.length, 20);
  assert.equal(rec.errors[0].length, 300);
  assert.deepEqual(rec.entries, []);
  assert.equal(rec.system.productVersion, 'SAP S/4HANA 2025');
  assert.ok(!('secret' in rec.system));
  // a malformed backup: discovered[host].entries as a string, scanMeta with junk, an invalid host key
  const m = migrateSnapshot({ sync: {}, local: { discovered: { 'my1.s4hana.cloud.sap': { entries: 'x' }, 'not a host!': { entries: [] } }, scanMeta: { 'my1.s4hana.cloud.sap': { appCount: 'many', detectedEdition: 'mars', system: 'junk' } } } });
  assert.deepEqual(Object.keys(m.local.discovered), ['my1.s4hana.cloud.sap']);
  assert.deepEqual(m.local.discovered['my1.s4hana.cloud.sap'].entries, [], 'the resolver can iterate it');
  assert.deepEqual(m.local.scanMeta['my1.s4hana.cloud.sap'], { lastScanned: null, appCount: 0, system: null, detectedEdition: null });
  const st = mk();
  await st.importJson({ format: 'slashn-config', systems: [{ key: 'acd', host: 'my1.s4hana.cloud.sap', isDefault: true }], settings: { suggestionLimit: '7', weird: true }, discovered: { 'my1.s4hana.cloud.sap': { entries: [{ intent: 'PurchaseOrder-manage', title: 'Manage POs' }, { intent: 'bad intent' }] } } });
  assert.deepEqual(await st.getSettings(), { ...DEFAULT_SETTINGS, suggestionLimit: 7 });
  assert.equal((await st.getDiscovered())['my1.s4hana.cloud.sap'].entries.length, 1);
});

test('targets: a client makes a second system on the same host; tabs and scans are told apart by sap-client', () => {
  const a = normalizeSystem({ key: 'acd400', host: 'acd.example.com', launchpadQuery: 'sap-client=400' });
  const b = normalizeSystem({ key: 'acd600', host: 'acd.example.com', launchpadQuery: 'sap-client=600' });
  const c = normalizeSystem({ key: 'erp', host: 'erp.example.com' });
  assert.equal(clientOf(a), '400');
  assert.equal(clientOf(c), null);
  assert.equal(targetKey(a), 'acd.example.com/400');
  assert.equal(targetKey(c), 'erp.example.com');
  assert.equal(systemByTarget([a, b, c], 'acd.example.com/600'), b);
  assert.equal(systemByTarget([a, b, c], 'acd.example.com'), a, 'a bare host picks the first system on it');
  assert.equal(systemForUrl([a, b, c], 'https://acd.example.com/sap/bc/ui2/flp?sap-client=600#Shell-home'), b);
  assert.equal(systemForUrl([a, b, c], 'https://ACD.example.com/ui'), a, 'no client in the URL: the first system on the host');
  assert.equal(systemForUrl([a, b, c], 'https://erp.example.com/ui?sap-client=100'), c, 'no system with that client: the host match');
  assert.equal(systemForUrl([a, b, c], 'https://other.example.com/ui'), null);
  assert.equal(isOnTarget('https://acd.example.com/ui?sap-client=400#X-y', a), true);
  assert.equal(isOnTarget('https://acd.example.com/ui?sap-client=600#X-y', a), false);
  assert.equal(isOnTarget('https://acd.example.com/ui', a), false, 'a system with a client needs the client in the URL');
  assert.equal(isOnTarget('https://erp.example.com/ui?sap-client=100', c), true);
  assert.deepEqual(validateSystems([{ ...a, isDefault: true }, b]), [], 'the same host twice is allowed');
  const s = sysFromUrl('https://acd.example.com/sap/bc/ui2/flp?sap-client=600#Shell-home', [a]);
  assert.equal(s.key, 'acd600');
  assert.equal(s.name, 'acd.example.com (client 600)');
  assert.equal(sysFromUrl('https://acd.example.com/sap/bc/ui2/flp?sap-client=400', [a]).key, 'acd4002', 'taken: numbered');
  assert.equal(sysFromUrl('https://acd.example.com/ui', [a]).key, 'acd', 'no client, plain key');
  // v1 → v2: a scan stored under the bare host moves to the client target
  const m = migrateSnapshot({ sync: { systems: [a] }, local: { discovered: { 'acd.example.com': { scannedAt: 't', entries: [] } }, scanMeta: { 'acd.example.com': { lastScanned: 't', appCount: 0 } } } });
  assert.deepEqual(Object.keys(m.local.discovered), ['acd.example.com/400']);
  assert.deepEqual(Object.keys(m.local.scanMeta), ['acd.example.com/400']);
  assert.deepEqual(migrateSnapshot(m), m, 'idempotent');
  const keep = migrateSnapshot({ sync: { systems: [a, { ...c, host: 'acd.example.com' }] }, local: { discovered: { 'acd.example.com': { scannedAt: 't', entries: [] } } } });
  assert.deepEqual(Object.keys(keep.local.discovered), ['acd.example.com'], 'a client-less system on the host keeps the record');
});
