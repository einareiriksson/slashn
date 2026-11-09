import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEBUG_CALLS, debugCallById, runDebugCallInPage, parseDebugParams } from '../src/debug.js';

const logon = () => ({
  getProductName: () => 'SAP S/4HANA', getProductVersion: () => 'SAP S/4HANA 2025', getSystemName: () => 'ACD', getClient: () => '600',
  getTenantRole: () => { throw new Error('not on this release'); }, getPlatform: () => 'abap', isTrial: () => false, setName: () => {}, _internal: 1,
});
const links = [{ intent: '#PurchaseOrder-manage', text: 'Manage Purchase Orders' }, { intent: '#Shell-startGUI?sap-ui2-tcode=SE16', text: 'SE16' }];
const services = {
  Navigation: {
    getLinks: async (args) => args.map(() => links),
    getSemanticObjects: async () => ['PurchaseOrder', 'Shell'],
    isNavigationSupported: async (targets) => targets.map((t) => ({ supported: t.target.semanticObject !== 'Nope' })),
  },
  NavTargetResolution: { resolveHashFragment: async (h) => { if (/VA01/.test(h)) return { applicationType: 'TR', url: '/sap/bc/gui/sap/its/webgui?~transaction=VA01', text: 'VA01' }; throw new Error('Could not resolve navigation target'); } },
  CrossApplicationNavigation: { getLinks: async () => links, getSemanticObjects: async () => ['PurchaseOrder'], isNavigationSupported: async () => [] },
  AppLifeCycle: {
    getCurrentApplication: () => ({ applicationType: 'UI5', homePage: true, getInfo: async (keys) => Object.fromEntries(keys.filter((k) => k !== 'theme').map((k) => [k, k === 'appVersion' ? '2025.0.23' : `v:${k}`])), getAllAppInfo: async (flag) => (flag ? { appTitle: 'Home', appVersion: '2025.0.23' } : { custom: 1 }), getIntent: async () => ({ semanticObject: 'Shell', action: 'home' }), componentInstance: { getManifestEntry: (p) => ({ '/sap.app/id': 'sap.ushell.components.pages', '/sap.app/applicationVersion/version': '2025.0.23' }[p] ?? null) } }),
  },
  SearchableContent: { getApps: async () => Array.from({ length: 30 }, (_, i) => ({ id: `app${i}`, title: `App ${i}`, target: { semanticObject: 'X', action: `a${i}` } })) },
  CommonDataModel: { getApplications: async () => Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`id${i}`, { 'sap.app': { id: `id${i}` } }])) },
};
const shell = () => ({
  ui: { version: '1.136.3', getVersionInfo: async ({ library }) => ({ name: library, version: '1.136.3', buildTimestamp: '202510' }) },
  ushell: { Container: {
    getLogonSystem: () => logon(),
    getServiceAsync: async (name) => { if (!services[name]) throw new Error(`service ${name} not available`); return services[name]; },
    getFLPPlatform: () => 'ABAP',
    getUser: () => ({ getId: () => 'EEI', getLanguage: () => 'EN', getFullName: () => 'private', getEmail: () => 'private', getTheme: () => 'sap_horizon' }),
  } },
});
const run = (id, params = null, sap = shell()) => { globalThis.window = sap ? { sap } : {}; return runDebugCallInPage(id, params); };

test('catalogue: unique ids, every id runs, no free-form evaluator', () => {
  assert.equal(new Set(DEBUG_CALLS.map((c) => c.id)).size, DEBUG_CALLS.length);
  assert.ok(DEBUG_CALLS.every((c) => c.group && c.label));
  assert.ok(!DEBUG_CALLS.some((c) => c.id === 'custom'), 'fixed, catalogued calls only: nothing typed by the user is evaluated in the SAP session');
  assert.equal(debugCallById('nope'), null);
  assert.equal(debugCallById('logon.getClient').label, 'getClient()');
  assert.ok(!/\b(import|require|DEBUG_CALLS)\b/.test(runDebugCallInPage.toString()), 'self-contained: executeScript serialises it');
});

test('logon-system getters: one at a time, all at once, missing method, no container', async () => {
  let r = await run('logon.getProductVersion');
  assert.equal(r.ok, true);
  assert.equal(r.result, 'SAP S/4HANA 2025');
  assert.equal(typeof r.ms, 'number');
  r = await run('logon.getTenantRole');
  assert.equal(r.ok, false);
  assert.match(r.error, /not on this release/);
  r = await run('logon.getSystemRole');
  assert.equal(r.ok, false);
  assert.match(r.error, /getSystemRole is not a function on this release; available: .*getClient.*getProductName/);
  r = await run('logon.all');
  assert.equal(r.ok, true);
  assert.equal(r.result['getProductVersion()'], 'SAP S/4HANA 2025');
  assert.match(r.result['getTenantRole()'], /«throws: not on this release»/);
  assert.equal(r.result['isTrial()'], false);
  assert.equal(r.result['setName()'], undefined, 'only get*/is*/has* are called');
  r = await run('logon.getClient', null, null);
  assert.equal(r.ok, false);
  assert.match(r.error, /sap.ushell.Container is not available/);
  r = await run('logon.getClient', null, { ushell: { Container: { getLogonSystem: () => null } } });
  assert.match(r.error, /returned nothing/);
});

test('AppLifeCycle, shell versions, user and services', async () => {
  let r = await run('app.getInfo', ['appVersion', 'appId', 'theme']);
  assert.deepEqual(r.result, { appVersion: '2025.0.23', appId: 'v:appId' }, 'unsupported keys are absent');
  r = await run('app.getInfo', 'not an array');
  assert.deepEqual(r.result, {});
  r = await run('app.getAllAppInfo');
  assert.deepEqual(r.result, { appTitle: 'Home', appVersion: '2025.0.23' }, 'no params: the standard entries (flag true)');
  r = await run('app.getAllAppInfo', false);
  assert.deepEqual(r.result, { custom: 1 });
  r = await run('app.manifestVersion');
  assert.equal(r.result['/sap.app/applicationVersion/version'], '2025.0.23');
  assert.equal(r.result['/sap.app/id'], 'sap.ushell.components.pages');
  assert.equal(r.result['/sap.app/title'], null);
  const noComp = shell(); noComp.ushell.Container.getServiceAsync = async () => ({ getCurrentApplication: () => ({}) });
  r = await run('app.manifestVersion', null, noComp);
  assert.match(r.error, /no componentInstance/);
  r = await run('app.getAllAppInfo', null, noComp);
  assert.match(r.error, /getAllAppInfo is not available/);
  r = await run('app.current');
  assert.equal(r.result.applicationType, 'UI5');
  assert.deepEqual(r.result['getIntent()'], { semanticObject: 'Shell', action: 'home' });
  assert.ok(r.result.methods.includes('getInfo'));
  r = await run('shell.versions');
  assert.deepEqual(r.result, { 'sap.ui.version': '1.136.3', 'getFLPPlatform()': 'ABAP', 'sap.ushell library': { name: 'sap.ushell', version: '1.136.3', buildTimestamp: '202510' } });
  r = await run('shell.user');
  assert.equal(r.result['getId()'], 'EEI');
  assert.equal(r.result['getFullName()'], undefined, 'personal fields are not read');
  assert.ok(r.result.methods.includes('getEmail'), 'but the method list shows what exists');
  r = await run('shell.services', ['Navigation', 'Bookmark']);
  assert.deepEqual(r.result.Navigation.methods, ['getLinks', 'getSemanticObjects', 'isNavigationSupported']);
  assert.match(r.result.Bookmark, /«unavailable: service Bookmark not available»/);
});

test('navigation and content calls return counts with bounded samples', async () => {
  let r = await run('nav.getLinks');
  assert.deepEqual(r.result, { count: 2, first: links });
  r = await run('nav.getSemanticObjects');
  assert.deepEqual(r.result, { count: 2, first: ['PurchaseOrder', 'Shell'] });
  r = await run('nav.isNavigationSupported', ['PurchaseOrder-manage', '#Nope-x', 'garbage']);
  assert.equal(r.result.via, 'Navigation');
  assert.deepEqual(r.result.result, [{ supported: true }, { supported: false }]);
  const noNav = shell(); noNav.ushell.Container.getServiceAsync = async (n) => { if (n === 'Navigation') throw new Error('old release'); return services[n]; };
  r = await run('nav.isNavigationSupported', ['A-b'], noNav);
  assert.match(r.result.via, /CrossApplicationNavigation \(old release\)/);
  r = await run('nav.resolve', 'Shell-startGUI?sap-ui2-tcode=VA01');
  assert.equal(r.result.hash, 'Shell-startGUI?sap-ui2-tcode=VA01');
  assert.equal(r.result.resolved.applicationType, 'TR', 'the hash gets its # and the resolved target comes back');
  r = await run('nav.resolve', '#Nope-x');
  assert.equal(r.ok, false);
  assert.match(r.error, /Could not resolve/);
  r = await run('can.getLinks');
  assert.equal(r.result.count, 2);
  r = await run('can.getSemanticObjects');
  assert.deepEqual(r.result.first, ['PurchaseOrder']);
  r = await run('content.searchable');
  assert.equal(r.result.count, 30);
  assert.equal(r.result.first.length, 10);
  r = await run('content.cdm');
  assert.equal(r.result.count, 8);
  assert.deepEqual(Object.keys(r.result.first), ['id0', 'id1', 'id2', 'id3', 'id4']);
  r = await run('content.cdm', null, { ushell: { Container: { getServiceAsync: async () => { throw new Error('no CDM'); } } } });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no CDM');
});

test('unknown calls are rejected; a removed "custom" id evaluates nothing', async () => {
  let r = await run('custom', 'window.sap.ui.version');
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown debug call: custom/);
  r = await run('bogus.call');
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown debug call: bogus.call/);
});

test('answers are made JSON-safe and bounded before they leave the page', async () => {
  const cyc = { name: 'root', fn: () => 1, big: 'x'.repeat(1000), n: 1, b: true, u: undefined, nul: null, nested: { a: { b: { c: { d: { e: { f: 'too deep' } } } } } }, list: Array.from({ length: 100 }, (_, i) => i), map: new Map([['k', 'v']]), set: new Set([1]), err: new Error('boom'), bi: 10n, sym: Symbol('s'), date: new Date('2026-01-01T00:00:00Z') };
  cyc.self = cyc;
  // a catalogued call whose answer is whatever the shell returns: here the awkward object above
  const sap = shell();
  sap.ushell.Container.getServiceAsync = async () => ({ getCurrentApplication: () => ({ getAllAppInfo: async () => cyc }) });
  const out = (await run('app.getAllAppInfo', true, sap)).result;
  assert.equal(out.name, 'root');
  assert.equal(out.fn, '«function fn»');
  assert.ok(out.big.endsWith('…(1000 chars)') && out.big.length < 430);
  assert.equal(out.n, 1);
  assert.equal(out.b, true);
  assert.equal(out.u, '«undefined»');
  assert.equal(out.nul, null);
  assert.equal(out.self, '«cycle»');
  assert.equal(out.nested.a.b.c.d, '«object Object»', 'depth limit');
  assert.equal(out.list.length, 61);
  assert.equal(out.list[60], '…(100 items)');
  assert.deepEqual(out.map, [['k', 'v']]);
  assert.deepEqual(out.set, [1]);
  assert.deepEqual(out.err, { name: 'Error', message: 'boom' });
  assert.equal(out.bi, '10n');
  assert.equal(out.sym, 'Symbol(s)');
  assert.deepEqual(out.date, { '«type»': 'Date' });
  assert.doesNotThrow(() => JSON.stringify(out));
  delete globalThis.window;
});

test('parseDebugParams: JSON when it parses, else the raw text', () => {
  assert.deepEqual(parseDebugParams('["a","b"]'), ['a', 'b']);
  assert.deepEqual(parseDebugParams(' {"k":1} '), { k: 1 });
  assert.equal(parseDebugParams('sap.ui.version'), 'sap.ui.version');
  assert.equal(parseDebugParams('42'), 42);
  assert.equal(parseDebugParams(''), null);
  assert.equal(parseDebugParams(null), null);
});
