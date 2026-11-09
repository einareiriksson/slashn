// The embedding API (src/embed.js) as a desktop host drives it: real seed files, a configuration in the export format,
// JSON in and out. No chrome.* anywhere on this path.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as core from '../src/embed.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(new URL(p, new URL('..', import.meta.url)), 'utf8');
const seed = { aliasesCsv: read('src/seed/aliases.csv'), libraryCsv: read('src/seed/library.csv'), tcodesCsv: read('src/seed/tcodes.csv'), tcodeAppsJson: read('src/seed/tcode-apps.json') };

const GUI = { serviceUuid: '1ef8d0c0-91f0-4961-af0e-0438689400f9', serviceName: 'ERP development', client: '100', language: 'en' };
const config = () => ({
  format: 'slashn-config',
  systems: [
    { key: 'acd', name: 'Cloud', host: 'my1.s4hana.cloud.sap', env: 'TST', isDefault: true },
    { key: 'erp', name: 'ERP', host: 'erp.example.com', launchpadQuery: 'sap-client=100', env: 'DEV', edition: 'onprem', gui: GUI },
    { key: 'gui', name: 'Classic only', host: '', launchpad: false, env: 'PRD', edition: 'onprem', gui: { ...GUI, client: '800' } },
  ],
  userAliases: [{ alias: 'po', semanticObject: 'PurchaseOrder', action: 'manage', title: 'My POs' }],
  hiddenAliases: [],
  settings: {},
});

before(() => {
  const r = core.init(seed, config());
  assert.ok(r.entryCount > 15000, `seed loaded (${r.entryCount})`);
  assert.deepEqual(r.seedErrors, [], 'the bundled seed has no problems');
  assert.deepEqual(r.configErrors, [], 'the fixture validates');
});

test('CORE_VERSION follows package.json', () => {
  assert.equal(core.CORE_VERSION, JSON.parse(readFileSync(`${root}/package.json`, 'utf8')).version);
  assert.equal(core.version().slashn, core.CORE_VERSION);
});

test('suggest: rows carry a launch URL and the transaction a SAP GUI launch would start', () => {
  const r = core.suggest('me21n');
  assert.equal(r.kind, 'query');
  assert.equal(r.system.key, 'acd', 'the default system');
  assert.equal(r.system.launchpad, true);
  assert.equal(r.system.gui, false);
  assert.ok(r.matches.length > 0);
  for (const m of r.matches) {
    assert.match(m.url, /^https:\/\/my1\.s4hana\.cloud\.sap\/ui#/);
    assert.ok(m.tcode === null || typeof m.tcode === 'string');
  }
  assert.ok(['alias', 'tcode'].includes(r.matches[0].matchType), r.matches[0].matchType);
  assert.equal(r.matches[0].tcode, 'me21n', 'the typed code is what a SAP GUI launch starts, whichever way it matched');
  assert.equal(core.suggest('erp manage purchase').matches[0].tcode, 'me21n', 'a title match offers the first mapped code');
  assert.equal(r.terms.head, 'me21n');
});

test('suggest: /n transactions are offered where SAP GUI can open them, never on Public Cloud', () => {
  const erp = core.suggest('erp /nse16');
  assert.equal(erp.matches.length, 1);
  assert.equal(erp.matches[0].gui, true);
  assert.equal(erp.matches[0].tcode, 'se16');
  assert.match(erp.matches[0].url, /\?sap-client=100#Shell-startGUI\?sap-ui2-tcode=SE16$/);
  assert.deepEqual(core.suggest('acd /nse16').matches, []);
  const classic = core.suggest('gui /nse16');
  assert.equal(classic.matches[0].url, null, 'no launchpad, no URL');
  assert.equal(classic.matches[0].tcode, 'se16');
  assert.equal(classic.system.launchpad, false);
  assert.equal(classic.system.gui, true);
});

test('suggest: user aliases, systems list, home hint on a classic-only system', () => {
  const po = core.suggest('erp po');
  assert.equal(po.matches[0].alias, 'po');
  assert.equal(po.matches[0].source, 'user');
  const list = core.suggest('?');
  assert.equal(list.kind, 'systems');
  assert.deepEqual(list.matches.map((m) => m.alias), ['acd', 'erp', 'gui']);
  assert.equal(list.matches[2].tag, 'PRD · SAP GUI');
  const home = core.suggest('gui');
  assert.equal(home.kind, 'home');
  assert.match(home.hint, /Open SAP GUI logon \[gui · SAP GUI\]/);
});

test('resolve: home, open, app finder, classic-only', () => {
  assert.deepEqual(core.resolve('erp'), { kind: 'home', system: core.resolve('erp').system, url: 'https://erp.example.com/ui?sap-client=100#Shell-home', tcode: null });
  assert.equal(core.resolve('gui').url, null);

  const open = core.resolve('erp me23n 4500001234');
  assert.equal(open.kind, 'open');
  assert.equal(open.param, '4500001234');
  assert.equal(open.tcode, 'me23n');
  assert.match(open.url, /^https:\/\/erp\.example\.com\/ui\?sap-client=100#PurchaseOrder-/);
  assert.match(open.url, /4500001234/);

  const classic = core.resolve('gui se16');
  assert.equal(classic.kind, 'open');
  assert.equal(classic.url, null);
  assert.equal(classic.tcode, 'se16');

  const unknown = core.resolve('acd zzqx9');
  assert.equal(unknown.kind, 'appfinder');
  assert.equal(unknown.url, 'https://my1.s4hana.cloud.sap/ui#Shell-appfinder');
  assert.equal(unknown.tcode, 'zzqx9', 'looks like a transaction: a GUI host may still try it');
  assert.equal(core.resolve('acd nothing matches this at all').tcode, null);
  assert.equal(core.resolve('?').kind, 'systems');
  assert.equal(core.resolve('erp', { preferredKey: 'gui' }).system.key, 'erp', 'an explicit key beats the preferred one');
  assert.equal(core.resolve('se16', { preferredKey: 'gui' }).system.key, 'gui', 'the preferred system wins over the default');
});

test('recordLaunch keeps the last 20 and the last used system; recency boosts that system only', () => {
  const r = core.recordLaunch({ systemKey: 'erp', intent: 'PurchaseOrder-create', alias: 'me21n', title: 'Create PO', target: 'gui' });
  assert.equal(r.recent.length, 1);
  assert.equal(r.lastUsedSystemKey, 'erp');
  assert.ok(Number.isFinite(r.recent[0].ts));
  for (let i = 0; i < 25; i++) core.recordLaunch({ systemKey: 'acd', intent: 'X-y' });
  assert.equal(core.getConfig().recent.length, 20);
  core.setConfig(config()); // back to a clean state for the other tests
});

test('setConfig validates: a classic-only system needs a GUI connection, the client is three digits', () => {
  const c = config();
  c.systems.push({ key: 'bad', host: '', launchpad: false });
  c.systems[1].gui = { ...GUI, client: '10' };
  const { errors, config: normalized } = core.setConfig(c);
  assert.ok(errors.some((e) => /row 4.*SAP GUI connection/.test(e)), errors.join('\n'));
  assert.ok(errors.some((e) => /row 2.*three digits/.test(e)), errors.join('\n'));
  assert.equal(normalized.systems[2].launchpad, false);
  assert.equal(normalized.systems[1].gui.language, 'EN', 'language upper-cased');
  assert.ok(!('gui' in normalized.systems[0]), 'no desktop fields on a plain extension row');
  assert.ok(!('launchpad' in normalized.systems[0]));
  core.setConfig(config());
});

test('normalizeSystem / systemFromParts for hosts that split the URL themselves', () => {
  const s = core.systemFromParts({ scheme: 'HTTPS', host: 'Acd.Finteq.io:8443', launchpadPath: '/sap/bc/ui2/flp/', launchpadQuery: '?sap-client=600' }, config().systems);
  assert.equal(s.key, 'acd2', 'made unique against the existing keys');
  assert.equal(s.host, 'acd.finteq.io:8443');
  assert.equal(s.launchpadPath, '/sap/bc/ui2/flp');
  assert.equal(s.launchpadQuery, 'sap-client=600');
  assert.equal(s.customer, 'finteq');
  assert.equal(s.isDefault, false);
  assert.equal(core.systemFromParts({ host: '' }), null);
  assert.equal(core.normalizeSystem({ key: 'k', host: 'h.example', browserBundleId: ' com.microsoft.edgemac ' }).browserBundleId, 'com.microsoft.edgemac');
});

test('importConfig: replace and merge like the extension, scan data per host', () => {
  const current = { ...config(), discovered: { 'erp.example.com': { scannedAt: '2026-01-01T00:00:00Z', entries: [{ intent: 'PurchaseOrder-manage', title: 'Manage POs' }] } }, recent: [{ ts: 1, systemKey: 'erp', intent: 'X-y' }] };
  const incoming = {
    format: 'slashn-config',
    systems: [{ key: 'ERP', name: 'ERP renamed', host: 'erp.example.com', isDefault: true }, { key: 'new', host: 'new.example.com' }],
    userAliases: [{ alias: 'po', semanticObject: 'PurchaseOrder', action: 'create', title: 'Create PO' }, { alias: 'x', intent: 'A-b' }],
    hiddenAliases: ['f0842'],
    discovered: { 'new.example.com': { scannedAt: '2026-02-02T00:00:00Z', entries: [{ intent: 'A-b' }] } },
    lastUsedSystemKey: 'new',
  };
  const merged = core.importConfig(current, incoming, { replace: false });
  assert.deepEqual(merged.systems.map((s) => s.key), ['acd', 'ERP', 'gui', 'new'], 'merged by key, case-insensitively, incoming wins in place');
  assert.equal(merged.systems[1].name, 'ERP renamed');
  assert.equal(merged.systems[1].gui, undefined, 'the incoming row replaces the whole system, as the extension does');
  assert.deepEqual(merged.userAliases.map((a) => a.alias), ['po', 'x']);
  assert.equal(merged.userAliases[0].intent, 'PurchaseOrder-create');
  assert.deepEqual(merged.hiddenAliases, ['f0842']);
  assert.deepEqual(Object.keys(merged.discovered).sort(), ['erp.example.com', 'new.example.com']);
  assert.equal(merged.recent.length, 1, 'merge keeps the launch history');
  assert.equal(merged.lastUsedSystemKey, 'new');

  const replaced = core.importConfig(current, incoming, { replace: true });
  assert.deepEqual(replaced.systems.map((s) => s.key), ['ERP', 'new']);
  assert.deepEqual(Object.keys(replaced.discovered), ['new.example.com']);
  assert.deepEqual(replaced.recent, []);
  assert.throws(() => core.importConfig(current, { systems: [] }), /Not a slashn config export/);
});

test('json facade: strings in, strings out, undefined becomes null', () => {
  const out = JSON.parse(core.json.suggest(JSON.stringify('erp se16'), JSON.stringify({ limit: 3 })));
  assert.ok(out.matches.length <= 3);
  assert.equal(out.matches[0].systemKey, 'erp');
  assert.equal(JSON.parse(core.json.version()).slashn, core.CORE_VERSION);
  assert.equal(core.json.reset(), 'null');
  core.init(seed, config());
});
