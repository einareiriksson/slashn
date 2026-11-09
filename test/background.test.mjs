// Drives the service worker through a minimal fake chrome.* API.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { memoryArea, DEFAULT_SETTINGS } from '../src/storage.js';
import { MSG } from '../src/messages.js';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const L = {};
const calls = [];
const listener = (name) => ({ addListener: (f) => { L[name] = f; } });
const sync = memoryArea();
const local = memoryArea();
const session = memoryArea();
const activeTab = { id: 1, url: 'https://my1.s4hana.cloud.sap/ui#Shell-home' };
let openTabs = [];
let lastDefault = '';
let liveReply = null; // fake content-script answer to CHECK_INTENTS
let openContexts = []; // fake extension pages (chrome.runtime.getContexts) – used for the system-info window
let probeResult = null; // fake result of chrome.scripting.executeScript in a launchpad tab
let focusedWindow = { id: 1, left: 100, top: 50, width: 1400, height: 900, tabs: [{ id: 31, active: false, windowId: 1, url: 'https://example.com/' }, { id: 32, active: true, windowId: 1, url: 'https://my1.s4hana.cloud.sap/ui#Shell-home' }] };

globalThis.chrome = {
  runtime: {
    id: 'ext',
    getManifest: () => ({ version: '0.1.0' }),
    getURL: (p) => (p.includes('?') ? `chrome-extension://ext/${p}` : url.pathToFileURL(path.join(root, p)).href), // seed files are fetched from disk
    onInstalled: listener('onInstalled'),
    onStartup: listener('onStartup'),
    onMessage: listener('onMessage'),
    openOptionsPage: async () => { calls.push(['options']); },
    getContexts: async (q) => (q.contextTypes?.includes('TAB') ? openContexts.filter((c) => !q.documentUrls || q.documentUrls.includes(c.documentUrl)) : []),
    sendMessage: async (m) => { calls.push(['sendMessage', m]); return { ok: true }; },
  },
  commands: { onCommand: listener('command') },
  omnibox: {
    onInputStarted: listener('onInputStarted'),
    onInputChanged: listener('onInputChanged'),
    onInputEntered: listener('onInputEntered'),
    onInputCancelled: listener('onInputCancelled'),
    setDefaultSuggestion: (s) => { lastDefault = s.description; },
  },
  storage: { sync, local, session, onChanged: listener('storageChanged') },
  action: {
    onClicked: listener('actionClicked'),
    enable: async (id) => { calls.push(['actionEnable', id ?? 'global']); },
    disable: async (id) => { calls.push(['actionDisable', id ?? 'global']); },
    setTitle: async ({ tabId, title }) => { calls.push(['actionTitle', tabId ?? 'global', title]); },
    setIcon: async ({ tabId, path, imageData }) => { calls.push(['actionIcon', tabId ?? 'global', path ? path[16] : imageData[16]]); },
  },
  tabs: {
    onActivated: listener('tabActivated'),
    onUpdated: listener('tabUpdated'),
    get: async (id) => [activeTab, ...openTabs].find((t) => t?.id === id) || { id, url: '' },
    query: async (q) => (q.active ? [activeTab] : q.url ? openTabs.filter((t) => t.url.startsWith(q.url.replace('/*', ''))) : openTabs.slice()),
    create: async (o) => { calls.push(['create', o]); return { id: 2 }; },
    update: async (id, o) => { calls.push(['update', id, o]); return { id }; },
    reload: async (id) => { calls.push(['reload', id]); },
    sendMessage: async (id, m) => {
      calls.push(['tabMessage', id, m]);
      if (id === 99) throw new Error('no receiver');
      if (m.type === MSG.CHECK_INTENTS) return liveReply ? liveReply(m.intents) : {};
      return {};
    },
  },
  offscreen: {
    createDocument: async (o) => { calls.push(['offscreen', o.reasons]); },
    closeDocument: async () => {},
  },
  permissions: {
    granted: new Set(),
    contains: async ({ origins }) => origins.every((o) => chrome.permissions.granted.has(o)),
    onAdded: listener('permAdded'),
    onRemoved: listener('permRemoved'),
  },
  windows: {
    create: async (o) => { calls.push(['window', o]); return { id: 77 }; },
    update: async (id, o) => { calls.push(['windowUpdate', id, o]); return { id }; },
    remove: async (id) => { calls.push(['windowRemove', id]); },
    getLastFocused: async () => focusedWindow,
    get: async (id) => ({ ...focusedWindow, id }),
  },
  scripting: {
    registered: [],
    executeScript: async ({ target, world, func, args }) => {
      calls.push(['executeScript', target.tabId, world, func.name, args]);
      if (target.tabId === 99) throw new Error('cannot access contents of the page');
      return [{ result: probeResult }];
    },
    getRegisteredContentScripts: async () => chrome.scripting.registered.slice(),
    registerContentScripts: async (list) => { chrome.scripting.registered.push(...list); },
    unregisterContentScripts: async ({ ids }) => { chrome.scripting.registered = chrome.scripting.registered.filter((s) => !ids.includes(s.id)); },
  },
};
globalThis.fetch = async (u) => {
  const p = url.fileURLToPath(u);
  if (!fs.existsSync(p)) return { ok: false, text: async () => '' };
  return { ok: true, text: async () => fs.readFileSync(p, 'utf8') };
};

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const send = (msg, sender = { id: 'ext', tab: { id: 1 } }) => new Promise((resolve) => { L.onMessage(msg, sender, resolve); });
const changed = async (text) => { const out = []; L.onInputChanged(text, (s) => out.push(...s)); await tick(); return out; };
const entered = async (text, disposition = 'currentTab') => { calls.length = 0; L.onInputEntered(text, disposition); await tick(80); return calls; };

before(async () => {
  await import('../src/background.js');
  await L.onInstalled({ reason: 'install' });
  await tick(300);
  await sync.set({ systems: [
    { key: 'acd', name: 'A dev', customer: 'A', host: 'my1.s4hana.cloud.sap', launchpadPath: '/ui', env: 'DEV', isDefault: true },
    { key: 'tst', name: 'A test', customer: 'A', host: 'my2.s4hana.cloud.sap', launchpadPath: '/ui', env: 'TST', isDefault: false },
  ] });
  L.storageChanged();
});

test('seed loaded on install', async () => {
  const seed = (await local.get('seedAliases')).seedAliases;
  assert.ok(seed.length > 50);
  assert.ok(seed.some((e) => e.alias === 'me21n'));
});

test('omnibox suggestions for static alias and system list', async () => {
  const s = await changed('me21n');
  assert.equal(s[0].content, 'acd me21n');
  assert.ok(s[0].description.includes('<match>me21n</match>'));
  assert.ok(lastDefault.includes('<match>me21n</match>'));
  const sys = await changed('?');
  assert.deepEqual(sys.map((x) => x.content), ['acd', 'tst']);
  const amp = await changed('tst manage pur');
  assert.ok(amp.length >= 1);
  assert.ok(amp.every((x) => !/&(?!amp;|lt;|gt;|quot;|apos;)/.test(x.description)));
});

test('enter reuses the active tab on the same host, else opens a new tab', async () => {
  let c = await entered('acd me23n 4500001234');
  assert.deepEqual(c[0], ['update', 1, { url: 'https://my1.s4hana.cloud.sap/ui#PurchaseOrder-displayFactSheet?PurchaseOrder=4500001234' }]);
  c = await entered('tst me21n');
  assert.deepEqual(c[0], ['create', { url: 'https://my2.s4hana.cloud.sap/ui#PurchaseOrder-create', active: true }]);
  c = await entered('acd me21n', 'newBackgroundTab');
  assert.deepEqual(c[0], ['create', { url: 'https://my1.s4hana.cloud.sap/ui#PurchaseOrder-create', active: false }]);
  c = await entered('acd', 'currentTab');
  assert.deepEqual(c[0], ['update', 1, { url: 'https://my1.s4hana.cloud.sap/ui#Shell-home' }]);
  c = await entered('?');
  assert.deepEqual(c[0], ['options']);
  const recent = (await local.get('recent')).recent;
  assert.equal(recent[0].intent, 'Shell-home');
  assert.equal((await local.get('lastUsedSystemKey')).lastUsedSystemKey, 'acd');
});

test('unknown alias opens the app finder; copying the text to the clipboard is opt-in', async () => {
  let c = await entered('acd zzzq');
  assert.deepEqual(c[0], ['update', 1, { url: 'https://my1.s4hana.cloud.sap/ui#Shell-appfinder' }]);
  assert.ok(!c.some((x) => x[0] === 'offscreen'), 'the clipboard is left alone by default');
  await sync.set({ settings: { ...DEFAULT_SETTINGS, copyUnresolved: true } });
  L.storageChanged({ settings: {} }, 'sync');
  c = await entered('acd zzzq');
  assert.ok(c.some((x) => x[0] === 'offscreen'));
  assert.ok(c.some((x) => x[0] === 'sendMessage' && x[1].type === MSG.COPY && x[1].text === 'zzzq'));
  await sync.set({ settings: { ...DEFAULT_SETTINGS } });
  L.storageChanged({ settings: {} }, 'sync');
});

test('discovery handshake, storage and ranking', async () => {
  assert.deepEqual(await send({ type: MSG.PAGE_READY, host: 'nope.s4hana.cloud.sap' }), { scan: false, reason: 'unregistered host' });
  const r = await send({ type: MSG.PAGE_READY, host: 'my1.s4hana.cloud.sap' });
  assert.deepEqual(r, { scan: true, reason: 'never scanned' });
  const stored = await send({ type: MSG.DISCOVERY_RESULT, host: 'my1.s4hana.cloud.sap', ui5Version: '1.130.0', methods: { links: 'Navigation' }, entries: [
    { intent: '#PurchaseOrder-manage?x=1', title: 'Manage Purchase Orders (tenant)' },
    { intent: 'ZCustom-run', title: 'Zebra Quokka App', appId: 'ZAPP1' },
    { intent: 'bad intent', title: 'ignored' },
    { intent: 'SalesContract-manage', title: 'Manage Sales Contracts' },
  ] });
  assert.deepEqual(stored, { stored: 3 });
  const fresh = await send({ type: MSG.PAGE_READY, host: 'my1.s4hana.cloud.sap' });
  assert.deepEqual(fresh, { scan: false, reason: 'fresh' });
  const meta = (await local.get('scanMeta')).scanMeta['my1.s4hana.cloud.sap'];
  assert.equal(meta.appCount, 3);
  const s = await changed('acd zebra quo');
  assert.equal(s[0].content, 'acd zapp1');
  assert.ok(s[0].description.includes('on tenant'));
  const guess = await changed('acd va4z');
  assert.ok(guess[0].description.includes('SalesContract-manage'));
  assert.ok(guess[0].description.includes('guess'));
  const other = await changed('tst zebra quo');
  assert.equal(other.length, 0); // discovered entries are per host
});

test('rescan orchestration', async () => {
  openTabs = [];
  let r = await send({ type: MSG.RESCAN_HOST, host: 'my1.s4hana.cloud.sap' }, { id: 'ext' });
  assert.equal(r.status, 'opened');
  assert.equal((await session.get('pendingRescan')).pendingRescan['my1.s4hana.cloud.sap'], true);
  assert.deepEqual(await send({ type: MSG.PAGE_READY, host: 'my1.s4hana.cloud.sap' }), { scan: true, reason: 'requested' });
  openTabs = [{ id: 5, url: 'https://my1.s4hana.cloud.sap/ui#Shell-home', windowId: 1 }];
  r = await send({ type: MSG.RESCAN_HOST, host: 'my1.s4hana.cloud.sap' }, { id: 'ext' });
  assert.equal(r.status, 'messaged');
  openTabs = [{ id: 99, url: 'https://my1.s4hana.cloud.sap/ui', windowId: 1 }];
  calls.length = 0;
  r = await send({ type: MSG.RESCAN_HOST, host: 'my1.s4hana.cloud.sap' }, { id: 'ext' });
  assert.equal(r.status, 'opened', 'a tab without a content script is never reloaded (unsaved work): a fresh tab scans instead');
  assert.ok(!calls.some((c) => c[0] === 'reload'));
  assert.deepEqual(calls.find((c) => c[0] === 'create')[1], { url: 'https://my1.s4hana.cloud.sap/ui#Shell-home', active: true, windowId: 1 });
  assert.deepEqual(await send({ type: 'nope' }), { ignored: true });
  assert.deepEqual(await send({ type: MSG.PAGE_READY, host: 'x' }, { id: 'other' }), { error: 'foreign sender' });
});

test('popup messages: resolve, navigate, open url', async () => {
  const r = await send({ type: MSG.RESOLVE, text: 'acd me23n 4500001234' }, { id: 'ext' });
  assert.equal(r.kind, 'query');
  assert.equal(r.system.key, 'acd');
  assert.ok(r.matches[0].content.endsWith(' 4500001234'), r.matches[0].content); // the scan-present Manage Purchase Orders app ME23N maps to comes first
  assert.ok(r.matches.some((m) => m.content === 'acd me23n 4500001234'), 'the alias row is still offered: ' + JSON.stringify(r.matches.map((m) => m.content)));
  assert.equal(r.matches[0].param, '4500001234');
  assert.ok('appId' in r.matches[0], 'the popup shows the Fiori app ID under the title');
  assert.ok(r.hint.includes('Manage Purchase Orders') && !r.hint.includes('<'), r.hint);
  const sys = await send({ type: MSG.RESOLVE, text: '?' }, { id: 'ext' });
  assert.deepEqual(sys.matches.map((m) => m.content), ['acd', 'tst']);
  calls.length = 0;
  const nav = await send({ type: MSG.NAVIGATE, text: 'tst me21n', disposition: 'newForegroundTab' }, { id: 'ext' });
  assert.equal(nav.action, 'open');
  assert.deepEqual(calls[0], ['create', { url: 'https://my2.s4hana.cloud.sap/ui#PurchaseOrder-create', active: true }]);
  calls.length = 0;
  const open = await send({ type: MSG.OPEN_URL, url: 'https://my1.s4hana.cloud.sap/ui#Shell-home', host: 'my1.s4hana.cloud.sap', disposition: 'currentTab' }, { id: 'ext' });
  assert.equal(open.action, 'open');
  assert.deepEqual(calls[0], ['update', 1, { url: 'https://my1.s4hana.cloud.sap/ui#Shell-home' }]);
  assert.deepEqual(await send({ type: MSG.OPEN_URL, url: 'javascript:alert(1)', host: 'x' }, { id: 'ext' }), { error: 'bad url' });
  calls.length = 0;
  assert.equal((await send({ type: MSG.NAVIGATE, text: '', disposition: 'currentTab' }, { id: 'ext' })).action, 'home'); // popup: empty Enter
  assert.deepEqual(calls[0], ['update', 1, { url: 'https://my1.s4hana.cloud.sap/ui#Shell-home' }]);
  calls.length = 0;
  assert.equal((await send({ type: MSG.NAVIGATE, text: 'list', disposition: 'currentTab' }, { id: 'ext' })).action, 'options');
  assert.deepEqual(calls[0], ['options']);
});

test('custom hosts get dynamic content scripts once access is granted', async () => {
  const systems = (await sync.get('systems')).systems;
  await sync.set({ systems: [...systems, { key: 'fin', name: 'Finteq', customer: 'finteq', host: 'acd.finteq.io:8443', launchpadPath: '/sap/bc/ui2/flp', launchpadQuery: 'sap-client=600', env: 'TST', isDefault: false }] });
  L.storageChanged({ systems: {} }, 'sync');
  await tick();
  assert.deepEqual(chrome.scripting.registered, []); // no permission yet
  chrome.permissions.granted.add('https://acd.finteq.io:8443/*');
  L.permAdded();
  await tick();
  assert.deepEqual(chrome.scripting.registered.map((s) => [s.id, s.world || 'ISOLATED', s.matches[0]]), [
    ['sapqs-main-acd.finteq.io:8443', 'MAIN', 'https://acd.finteq.io:8443/*'],
    ['sapqs-iso-acd.finteq.io:8443', 'ISOLATED', 'https://acd.finteq.io:8443/*'],
  ]);
  calls.length = 0;
  L.onInputEntered('fin me21n', 'currentTab');
  await tick(80);
  assert.deepEqual(calls[0], ['create', { url: 'https://acd.finteq.io:8443/sap/bc/ui2/flp?sap-client=600#PurchaseOrder-create', active: true }]);
  L.permAdded();
  await tick();
  assert.equal(chrome.scripting.registered.length, 2); // idempotent
  const r = await send({ type: MSG.PAGE_READY, host: 'acd.finteq.io:8443' });
  assert.equal(r.scan, true);
  await sync.set({ systems });
  L.storageChanged({ systems: {} }, 'sync');
  await tick();
  assert.deepEqual(chrome.scripting.registered, []);
});

test('suggestions respect the system edition', async () => {
  const seed = (await local.get('seedAliases')).seedAliases;
  await local.set({ seedAliases: [...seed,
    { alias: 'pubonly', semanticObject: 'Zeta', action: 'pub', intent: 'Zeta-pub', title: 'Zeta public', editions: ['public'], source: 'library', tcodes: [] },
    { alias: 'oponly', semanticObject: 'Zeta', action: 'op', intent: 'Zeta-op', title: 'Zeta onprem', editions: ['private', 'onprem'], source: 'library', tcodes: [] }] });
  const systems = (await sync.get('systems')).systems;
  await sync.set({ systems: [...systems, { key: 'op', name: 'On-prem', customer: 'x', host: 'erp.example:8443', launchpadPath: '/sap/bc/ui2/flp', env: 'TST', edition: 'onprem', isDefault: false }] });
  L.storageChanged({ systems: {} }, 'sync');
  await tick();
  assert.deepEqual((await changed('acd zeta')).map((x) => x.content), ['acd pubonly']);
  assert.deepEqual((await changed('op zeta')).map((x) => x.content), ['op oponly']);
  await sync.set({ systems });
  L.storageChanged({ systems: {} }, 'sync');
  await tick();
});

test('queries without a system key go to the current tab\'s system', async () => {
  activeTab.url = 'https://my2.s4hana.cloud.sap/ui#Shell-home';
  L.onInputStarted();
  await tick();
  assert.equal((await changed('me21n'))[0].content, 'tst me21n');
  assert.ok((await changed('acd me21n'))[0].content.startsWith('acd '), 'explicit key still wins');
  calls.length = 0;
  L.onInputEntered('me23n 42', 'currentTab');
  await tick(80);
  assert.deepEqual(calls[0], ['update', 1, { url: 'https://my2.s4hana.cloud.sap/ui#PurchaseOrder-displayFactSheet?PurchaseOrder=42' }]);
  L.onInputCancelled();
  activeTab.url = 'https://my1.s4hana.cloud.sap/ui#Shell-home';
  L.onInputStarted();
  await tick();
  assert.ok((await changed('me21n'))[0].content.startsWith('acd '), 'the current tab is acd');
  const r = await send({ type: MSG.RESOLVE, text: 'me21n', contextHost: 'my2.s4hana.cloud.sap' }, { id: 'ext' });
  assert.equal(r.system.key, 'tst');
  calls.length = 0;
  await send({ type: MSG.NAVIGATE, text: 'me21n', disposition: 'newForegroundTab', contextHost: 'my2.s4hana.cloud.sap' }, { id: 'ext' });
  assert.deepEqual(calls[0], ['create', { url: 'https://my2.s4hana.cloud.sap/ui#PurchaseOrder-create', active: true }]);
});

test('availability: scan marks absent intents; popup launch is blocked once and forced on retry', async () => {
  // my1 was scanned above with PurchaseOrder-manage, ZCustom-run, SalesContract-manage; PurchaseRequisition-create is absent
  // (ME21N is no longer a pure "absent" case: the t-code → app table maps it to the present Manage Purchase Orders app).
  openTabs = [];
  const s = await changed('acd me51n');
  assert.ok(s[0].description.includes('not found on acd'));
  assert.ok(lastDefault.includes('not found on acd in the last scan'));
  assert.ok((await changed('acd po'))[0].description.includes('on tenant'));
  const me21n = await changed('acd me21n');
  assert.ok(me21n[0].description.includes('Manage Purchase Orders') && me21n[0].description.includes('on tenant'), 'a present successor app outranks the absent alias target');
  assert.ok(me21n.some((x) => x.content === 'acd me21n' && x.description.includes('not found on acd')));
  const r = await send({ type: MSG.RESOLVE, text: 'acd me51n' }, { id: 'ext' });
  assert.equal(r.matches[0].missing, true);
  assert.equal(r.matches[0].onTenant, false);
  assert.ok(r.scannedAt);
  assert.equal(r.filtered, false);
  // the popup's "available only" filter: scanned system → only rows the scan found
  const only = await send({ type: MSG.RESOLVE, text: 'acd me21n', availableOnly: true }, { id: 'ext' });
  assert.equal(only.filtered, true);
  assert.ok(only.matches.length && only.matches.every((m) => m.onTenant), 'the absent PurchaseOrder-create row is gone; the mapped Manage Purchase Orders app (present) stays');
  const none = await send({ type: MSG.RESOLVE, text: 'acd zq9x', availableOnly: true }, { id: 'ext' });
  assert.deepEqual(none.matches, []);
  assert.match(none.hint, /No app found in the last scan of acd/);
  const po = await send({ type: MSG.RESOLVE, text: 'acd po', availableOnly: true }, { id: 'ext' });
  assert.ok(po.matches.length && po.matches.every((m) => m.onTenant), 'every row shown is on the tenant');
  // unscanned system → the filter is ignored and the hint says so
  const tst = await send({ type: MSG.RESOLVE, text: 'tst me21n', availableOnly: true }, { id: 'ext' });
  assert.equal(tst.filtered, false);
  assert.equal(tst.matches[0].content, 'tst me21n');
  assert.match(tst.hint, /tst has not been scanned yet/);
  calls.length = 0;
  const blocked = await send({ type: MSG.NAVIGATE, text: 'acd me51n', disposition: 'newForegroundTab' }, { id: 'ext' });
  assert.equal(blocked.action, 'blocked');
  assert.equal(blocked.basis, 'scan');
  assert.ok(!calls.some((c) => c[0] === 'create'));
  const forced = await send({ type: MSG.NAVIGATE, text: 'acd me51n', disposition: 'newForegroundTab', force: true }, { id: 'ext' });
  assert.equal(forced.action, 'open');
  assert.ok(calls.some((c) => c[0] === 'create'));
  // the omnibox never blocks
  calls.length = 0;
  L.onInputEntered('acd me21n', 'newForegroundTab');
  await tick(80);
  assert.ok(calls.some((c) => c[0] === 'create'));
  // unscanned host: nothing is claimed
  const t = await send({ type: MSG.RESOLVE, text: 'tst me21n' }, { id: 'ext' });
  assert.equal(t.matches[0].missing, false);
  assert.equal(await (await send({ type: MSG.NAVIGATE, text: 'tst me21n', disposition: 'newForegroundTab' }, { id: 'ext' })).action, 'open');
});

test('availability: live check through an open launchpad tab overrides the scan', async () => {
  openTabs = [{ id: 7, url: 'https://my1.s4hana.cloud.sap/ui#Shell-home' }];
  liveReply = (intents) => ({ intents, supported: intents.map((i) => i === 'PurchaseOrder-create' || i === 'PurchaseRequisition-create') });
  const live = await send({ type: MSG.LIVE_CHECK, host: 'my1.s4hana.cloud.sap', intents: ['PurchaseOrder-create', 'PurchaseOrder-manage', 'Shell-home'] }, { id: 'ext' });
  assert.deepEqual(live.available, { 'PurchaseOrder-create': true, 'PurchaseOrder-manage': false });
  assert.equal(live.tabId, 7);
  // both answers contradict the scan → rescan is scheduled for the next load
  assert.equal((await session.get('pendingRescan')).pendingRescan['my1.s4hana.cloud.sap'], true);
  calls.length = 0;
  const open = await send({ type: MSG.NAVIGATE, text: 'acd me51n', disposition: 'newForegroundTab' }, { id: 'ext' });
  assert.equal(open.action, 'open'); // scan said absent, live says available
  assert.equal(open.basis, 'live');
  const blocked = await send({ type: MSG.NAVIGATE, text: 'acd po', disposition: 'newForegroundTab' }, { id: 'ext' });
  assert.equal(blocked.action, 'blocked'); // scan said present, live says no
  assert.equal(blocked.basis, 'live');
  // tab without a content script (pre-install) → fall back to the scan
  liveReply = null;
  openTabs = [{ id: 99, url: 'https://my1.s4hana.cloud.sap/ui' }];
  const none = await send({ type: MSG.LIVE_CHECK, host: 'my1.s4hana.cloud.sap', intents: ['PurchaseOrder-create'] }, { id: 'ext' });
  assert.equal(none.available, null);
  assert.equal((await send({ type: MSG.NAVIGATE, text: 'acd me51n', disposition: 'newForegroundTab' }, { id: 'ext' })).basis, 'scan');
  openTabs = [];
});

// ---------------------------------------------------------------- on-premise systems (port, path, query, http)

const FIN = { key: 'fin', name: 'Finteq ACD', customer: 'finteq', host: 'acd.finteq.io:8443', scheme: 'https', launchpadPath: '/sap/bc/ui2/flp', launchpadQuery: 'sap-client=600', env: 'TST', edition: 'onprem', isDefault: false };
const ERP = { key: 'erp', name: 'Internal ERP', customer: 'internal', host: 'erp.internal.example:8000', scheme: 'http', launchpadPath: '/sap/bc/ui2/flp', launchpadQuery: 'sap-client=100', env: 'DEV', edition: 'onprem', isDefault: false };
const FIN_HOME = 'https://acd.finteq.io:8443/sap/bc/ui2/flp?sap-client=600#Shell-home';
let cloudSystems = null;

test('on-prem: register systems with port, path, query and http scheme', async () => {
  cloudSystems = (await sync.get('systems')).systems;
  await sync.set({ systems: [...cloudSystems, FIN, ERP] });
  L.storageChanged({ systems: {} }, 'sync');
  await tick();
  const sys = await changed('list');
  assert.deepEqual(sys.map((x) => x.content), ['acd', 'tst', 'fin', 'erp']);
  assert.ok(sys[2].description.includes('acd.finteq.io:8443'));
});

test('on-prem: launches compose scheme, port, launchpad path, query and intent', async () => {
  let c = await entered('fin me21n', 'newForegroundTab');
  assert.deepEqual(c[0], ['create', { url: 'https://acd.finteq.io:8443/sap/bc/ui2/flp?sap-client=600#PurchaseOrder-create', active: true }]);
  c = await entered('fin me23n 4500001234', 'newForegroundTab');
  assert.deepEqual(c[0], ['create', { url: 'https://acd.finteq.io:8443/sap/bc/ui2/flp?sap-client=600#PurchaseOrder-displayFactSheet?PurchaseOrder=4500001234', active: true }]);
  c = await entered('fin', 'newForegroundTab');
  assert.deepEqual(c[0], ['create', { url: FIN_HOME, active: true }]);
  c = await entered('fin zzzqqq', 'newForegroundTab');
  assert.deepEqual(c[0], ['create', { url: 'https://acd.finteq.io:8443/sap/bc/ui2/flp?sap-client=600#Shell-appfinder', active: true }], 'an unknown word opens the app finder');
  c = await entered('fin zzzq', 'newForegroundTab');
  assert.deepEqual(c[0], ['create', { url: 'https://acd.finteq.io:8443/sap/bc/ui2/flp?sap-client=600#Shell-startGUI?sap-ui2-tcode=ZZZQ', active: true }], 'an unknown short code on an on-prem system is tried as a GUI transaction');
  c = await entered('erp me21n', 'newForegroundTab');
  assert.deepEqual(c[0], ['create', { url: 'http://erp.internal.example:8000/sap/bc/ui2/flp?sap-client=100#PurchaseOrder-create', active: true }]);
  const recent = (await local.get('recent')).recent;
  assert.equal(recent[0].host, 'erp.internal.example:8000', 'recent launches are keyed by host:port so the popup can filter by the current tab');
  assert.equal(recent[0].url, 'http://erp.internal.example:8000/sap/bc/ui2/flp?sap-client=100#PurchaseOrder-create');
  assert.equal(recent[1].host, 'acd.finteq.io:8443');
  assert.equal((await local.get('lastUsedSystemKey')).lastUsedSystemKey, 'erp');
});

test('on-prem: the active tab is recognised by host:port, so plain Enter reuses it and bare aliases target it', async () => {
  activeTab.url = 'https://acd.finteq.io:8443/sap/bc/ui2/flp?sap-client=600#Shell-home';
  L.onInputStarted();
  await tick();
  assert.ok(lastDefault.includes('acd.finteq.io:8443'), 'default suggestion names the current system');
  assert.equal((await changed('me21n'))[0].content, 'fin me21n');
  let c = await entered('me23n 42', 'currentTab');
  assert.deepEqual(c[0], ['update', 1, { url: 'https://acd.finteq.io:8443/sap/bc/ui2/flp?sap-client=600#PurchaseOrder-displayFactSheet?PurchaseOrder=42' }]);
  c = await entered('erp me21n', 'currentTab');
  assert.deepEqual(c[0], ['create', { url: 'http://erp.internal.example:8000/sap/bc/ui2/flp?sap-client=100#PurchaseOrder-create', active: true }], 'another system: new tab');
  L.onInputCancelled();
  // same hostname on the default port is a different system (or none): never reuse that tab
  activeTab.url = 'https://acd.finteq.io/sap/bc/ui2/flp?sap-client=600#Shell-home';
  L.onInputStarted();
  await tick();
  assert.ok((await changed('me21n'))[0].content.startsWith('acd '), 'unregistered host: falls back to the default system');
  c = await entered('fin me21n', 'currentTab');
  assert.equal(c[0][0], 'create');
  L.onInputCancelled();
  activeTab.url = 'https://my1.s4hana.cloud.sap/ui#Shell-home';
  L.onInputStarted();
  await tick();
});

test('on-prem: the launchpad handshake uses the host the content script sends (hostname + port)', async () => {
  // content-isolated.js sends location.host, which for a non-default port is "hostname:port" – the stored host.
  assert.deepEqual(await send({ type: MSG.PAGE_READY, host: 'acd.finteq.io' }), { scan: false, reason: 'unregistered host' }, 'the bare hostname is not a registered system');
  assert.deepEqual(await send({ type: MSG.PAGE_READY, host: 'acd.finteq.io:8443' }), { scan: true, reason: 'never scanned' });
  const stored = await send({ type: MSG.DISCOVERY_RESULT, host: 'acd.finteq.io:8443', ui5Version: '1.108.0', methods: { links: 'CAN.getLinks({})' }, system: { productVersion: 'SAP SCREEN PERSONAS 3.0\r\nSAP S/4HANA 2025\r\nABAP PLATFORM 2025\r\nSAP FIORI FOR SAP S/4HANA 2025', systemRole: 1, clientRole: 'D', appVersion: '2025.0.23' }, entries: [
    { intent: 'PurchaseOrder-manage', title: 'Manage Purchase Orders' },
    { intent: 'Shell-startGUI', title: 'SAP GUI' },
    { intent: 'ZFIN_Report-display', title: 'Finteq Report', appId: 'ZFIN01' },
  ] });
  assert.deepEqual(stored, { stored: 3 });
  assert.deepEqual(await send({ type: MSG.DISCOVERY_RESULT, host: 'acd.finteq.io', entries: [{ intent: 'A-b', title: 'x' }] }), { stored: 0, error: 'unregistered host' });
  assert.deepEqual(await send({ type: MSG.DISCOVERY_RESULT, host: 'acd.finteq.io:8443', entries: [] }, { id: 'ext' }), { stored: 0, error: 'not from a tab' }, 'only content scripts report scans');
  assert.deepEqual(await send({ type: MSG.DISCOVERY_RESULT, host: 'acd.finteq.io:8443', entries: [] }, { id: 'ext', tab: { id: 7, url: 'https://evil.example/ui' } }), { stored: 0, error: 'host mismatch' }, 'and only for the host their tab is on');
  const meta = (await local.get('scanMeta')).scanMeta;
  assert.equal(meta['acd.finteq.io:8443'].appCount, 3);
  assert.equal(meta['acd.finteq.io:8443'].detectedEdition, 'onprem');
  assert.deepEqual(meta['acd.finteq.io:8443'].system, { productVersion: 'SAP S/4HANA 2025', productVersions: 'SAP SCREEN PERSONAS 3.0 · SAP S/4HANA 2025 · ABAP PLATFORM 2025 · SAP FIORI FOR SAP S/4HANA 2025', systemRole: '1', clientRole: 'D', appVersion: '2025.0.23' });
  assert.equal(meta['acd.finteq.io'], undefined);
  assert.deepEqual(await send({ type: MSG.PAGE_READY, host: 'acd.finteq.io:8443' }), { scan: false, reason: 'fresh' });
  // discovered apps are suggested for fin only, with the on-prem URL
  const s = await changed('fin finteq rep');
  assert.equal(s[0].content, 'fin zfin01');
  assert.ok(s[0].description.includes('on tenant'));
  assert.equal((await changed('erp finteq rep')).length, 0);
  assert.equal((await changed('acd finteq rep')).length, 0);
  const c = await entered('fin zfin01', 'newForegroundTab');
  assert.deepEqual(c[0], ['create', { url: 'https://acd.finteq.io:8443/sap/bc/ui2/flp?sap-client=600#ZFIN_Report-display', active: true }]);
  // ME21N maps to PurchaseOrder-create (absent here) and, via the t-code → app table, to Manage Purchase Orders (present):
  // the present Fiori app comes first, the GUI transaction is offered after it, the absent app sinks
  const me21n = await changed('fin me21n');
  assert.equal(me21n[0].content, 'fin f0842a');
  assert.ok(me21n[0].description.includes('Manage Purchase Orders') && me21n[0].description.includes('on tenant'));
  assert.ok(me21n.some((x) => x.content === 'fin /nme21n' && x.description.includes('Transaction ME21N')));
  assert.ok(me21n.some((x) => x.content === 'fin me21n' && x.description.includes('not found on fin')));
  const po = await changed('fin po');
  assert.ok(po[0].description.includes('on tenant'), 'a present Fiori app stays first');
  assert.ok(!po.some((x) => x.content === 'fin /npo'), 'letters-only heads with a match get no GUI row');
  const c2 = await entered('fin me21n', 'newForegroundTab');
  assert.deepEqual(c2[0], ['create', { url: 'https://acd.finteq.io:8443/sap/bc/ui2/flp?sap-client=600#PurchaseOrder-manage', active: true }]);
  assert.equal((await local.get('recent')).recent[0].matchType, 'tcode');
  const c3 = await entered('fin /nme21n', 'newForegroundTab');
  assert.deepEqual(c3[0], ['create', { url: 'https://acd.finteq.io:8443/sap/bc/ui2/flp?sap-client=600#Shell-startGUI?sap-ui2-tcode=ME21N', active: true }]);
  assert.equal((await local.get('recent')).recent[0].matchType, 'gui');
  const forced = await entered('fin /nSE16', 'newForegroundTab');
  assert.deepEqual(forced[0], ['create', { url: 'https://acd.finteq.io:8443/sap/bc/ui2/flp?sap-client=600#Shell-startGUI?sap-ui2-tcode=SE16', active: true }]);
  assert.equal((await changed('fin manage purchase')).some((x) => x.content.includes('/n')), false, 'title searches get no GUI row');
  // the unscanned http system: the Fiori match is unverified, so it stays first and the GUI transaction is offered second
  const su01 = await changed('erp su01');
  assert.equal(su01[0].content, 'erp users'); // the seed alias carrying t-code SU01
  assert.equal(su01[1].content, 'erp /nsu01');
  const spro = await changed('erp spro');
  assert.equal(spro[0].content, 'erp spro', 'the library knows SPRO as a Fiori app on-prem: that wins and no GUI row is added for a letters-only head');
  assert.equal(spro.some((x) => x.content === 'erp /nspro'), false);
  assert.deepEqual((await changed('erp stms')).map((x) => x.content), ['erp /nstms'], 'letters-only code with no other match');
  // public cloud: no GUI rows, and /n yields nothing (Enter opens the app finder)
  assert.equal((await changed('acd me21n')).some((x) => x.content.includes('/n')), false);
  assert.deepEqual(await changed('acd /nse16'), []);
  // a scanned on-prem system without Shell-startGUI never offers GUI transactions
  await send({ type: MSG.DISCOVERY_RESULT, host: 'erp.internal.example:8000', entries: [{ intent: 'PurchaseOrder-manage', title: 'Manage Purchase Orders' }] });
  assert.deepEqual(await changed('erp /nse16'), []);
  assert.equal((await changed('erp su01')).some((x) => x.content.includes('/n')), false);
  const r = await send({ type: MSG.RESOLVE, text: 'me21n', contextHost: 'acd.finteq.io:8443' }, { id: 'ext' });
  assert.equal(r.matches[0].gui, false);
  assert.equal(r.matches[0].onTenant, true, 'ME21N → Manage Purchase Orders, present on fin, comes first');
  assert.ok(r.matches.some((m) => m.gui && m.alias === '/nme21n'), 'the GUI transaction is still offered');
});

test('on-prem: live check and rescan find launchpad tabs by scheme, host and port', async () => {
  openTabs = [{ id: 8, url: 'https://acd.finteq.io/sap/bc/ui2/flp?sap-client=600#Shell-home' }]; // default port: not our system
  let live = await send({ type: MSG.LIVE_CHECK, host: 'acd.finteq.io:8443', intents: ['PurchaseOrder-create'] }, { id: 'ext' });
  assert.equal(live.available, null);
  assert.equal(live.reason, 'no launchpad tab open');
  openTabs = [{ id: 9, url: FIN_HOME, windowId: 1 }];
  liveReply = (intents) => ({ intents, supported: intents.map(() => true) });
  live = await send({ type: MSG.LIVE_CHECK, host: 'acd.finteq.io:8443', intents: ['PurchaseOrder-create'] }, { id: 'ext' });
  assert.deepEqual(live, { available: { 'PurchaseOrder-create': true }, reason: 'live', tabId: 9 });
  assert.deepEqual(await send({ type: MSG.LIVE_CHECK, host: 'acd.finteq.io', intents: ['PurchaseOrder-create'] }, { id: 'ext' }), { available: null, reason: 'unregistered host' });
  liveReply = null;
  calls.length = 0;
  assert.equal((await send({ type: MSG.RESCAN_HOST, host: 'acd.finteq.io:8443' }, { id: 'ext' })).status, 'messaged');
  assert.deepEqual(calls[0], ['tabMessage', 9, { type: MSG.RESCAN_TAB }]);
  openTabs = [];
  calls.length = 0;
  assert.equal((await send({ type: MSG.RESCAN_HOST, host: 'erp.internal.example:8000' }, { id: 'ext' })).status, 'opened');
  assert.deepEqual(calls[0], ['create', { url: 'http://erp.internal.example:8000/sap/bc/ui2/flp?sap-client=100#Shell-home', active: true, windowId: 1 }]);
  assert.equal((await session.get('pendingRescan')).pendingRescan['erp.internal.example:8000'], true);
});

test('on-prem: popup messages resolve and open http URLs only for registered http systems', async () => {
  const r = await send({ type: MSG.RESOLVE, text: 'me23n 7', contextHost: 'acd.finteq.io:8443' }, { id: 'ext' });
  assert.equal(r.system.key, 'fin');
  assert.equal(r.system.host, 'acd.finteq.io:8443');
  assert.equal(r.matches[0].content, 'fin f0842a 7', 'ME23N → Manage Purchase Orders is present on fin, so it comes first with the value');
  assert.ok(r.matches.some((m) => m.content === 'fin /nme23n' && m.gui), 'the GUI transaction is still offered (the value cannot be passed to it)');
  calls.length = 0;
  // erp was scanned above with PurchaseOrder-manage only: ME21N now resolves to that (present) app through the t-code → app table instead of being blocked on the absent create app
  const me21nErp = await send({ type: MSG.NAVIGATE, text: 'me21n', disposition: 'newForegroundTab', contextHost: 'erp.internal.example:8000' }, { id: 'ext' });
  assert.equal(me21nErp.action, 'open');
  assert.ok(me21nErp.url.endsWith('#PurchaseOrder-manage'), JSON.stringify(me21nErp));
  assert.equal((await send({ type: MSG.NAVIGATE, text: 'me51n', disposition: 'newForegroundTab', contextHost: 'erp.internal.example:8000' }, { id: 'ext' })).action, 'blocked', 'a code whose apps are all absent is still blocked');
  const nav = await send({ type: MSG.NAVIGATE, text: 'po', disposition: 'newForegroundTab', contextHost: 'erp.internal.example:8000' }, { id: 'ext' });
  assert.equal(nav.action, 'open');
  assert.equal(nav.url, 'http://erp.internal.example:8000/sap/bc/ui2/flp?sap-client=100#PurchaseOrder-manage');
  assert.deepEqual(calls[0], ['create', { url: nav.url, active: true }]);
  calls.length = 0;
  const open = await send({ type: MSG.OPEN_URL, url: nav.url, host: 'erp.internal.example:8000', disposition: 'newForegroundTab' }, { id: 'ext' });
  assert.equal(open.action, 'open', 'a recent http launch can be reopened from the popup');
  assert.deepEqual(calls[0], ['create', { url: nav.url, active: true }]);
  assert.deepEqual(await send({ type: MSG.OPEN_URL, url: 'http://acd.finteq.io:8443/sap/bc/ui2/flp#Shell-home', host: 'acd.finteq.io:8443' }, { id: 'ext' }), { error: 'bad url' }, 'http to an https system is refused');
  assert.deepEqual(await send({ type: MSG.OPEN_URL, url: 'http://evil.example/', host: 'erp.internal.example:8000' }, { id: 'ext' }), { error: 'bad url' }, 'http to an unregistered host is refused whatever host the popup claims');
  assert.deepEqual(await send({ type: MSG.OPEN_URL, url: 'javascript:alert(1)', host: 'erp.internal.example:8000' }, { id: 'ext' }), { error: 'bad url' });
  assert.deepEqual(await send({ type: MSG.OPEN_URL, url: 'not a url', host: 'erp.internal.example:8000' }, { id: 'ext' }), { error: 'bad url' });
  assert.equal((await send({ type: MSG.OPEN_URL, url: FIN_HOME, host: 'acd.finteq.io:8443', disposition: 'newForegroundTab' }, { id: 'ext' })).action, 'open');
  await sync.set({ systems: cloudSystems });
  L.storageChanged({ systems: {} }, 'sync');
  await tick();
});

// ---------------------------------------------------------------- system-info dialog

test('system-info dialog opens as a popup window once and is focused afterwards', async () => {
  calls.length = 0;
  openContexts = [];
  const r = await send({ type: MSG.OPEN_SYSTEM_INFO, host: 'my1.s4hana.cloud.sap' }, { id: 'ext' });
  assert.deepEqual(r, { windowId: 77, action: 'opened' });
  const [name, opts] = calls.find((c) => c[0] === 'window');
  assert.equal(name, 'window');
  assert.equal(opts.type, 'popup', 'a popup-type window: no tabs, no address bar');
  assert.equal(opts.focused, true);
  assert.ok(opts.width > 300 && opts.height > 300);
  assert.ok(opts.url.endsWith('/src/sysinfo/sysinfo.html?host=my1.s4hana.cloud.sap'));
  openContexts = [{ contextType: 'TAB', documentUrl: opts.url, windowId: 77 }];
  calls.length = 0;
  assert.deepEqual(await send({ type: MSG.OPEN_SYSTEM_INFO, host: 'my1.s4hana.cloud.sap' }, { id: 'ext' }), { windowId: 77, action: 'focused' });
  assert.deepEqual(calls, [['windowUpdate', 77, { focused: true }]]);
  calls.length = 0;
  const other = await send({ type: MSG.OPEN_SYSTEM_INFO, host: 'my2.s4hana.cloud.sap' }, { id: 'ext' });
  assert.equal(other.action, 'opened', 'another system gets its own window');
  assert.ok(calls.find((c) => c[0] === 'window')[1].url.endsWith('?host=my2.s4hana.cloud.sap'));
  assert.deepEqual(await send({ type: MSG.OPEN_SYSTEM_INFO, host: 'nope.example' }, { id: 'ext' }), { error: 'unregistered host' });
  openContexts = [];
});

test('system-info probe reads the About getters from an open launchpad tab and stores them', async () => {
  openTabs = [];
  assert.deepEqual(await send({ type: MSG.PROBE_SYSTEM, host: 'my2.s4hana.cloud.sap' }, { id: 'ext' }), { launchpad: false, reason: 'no tab' });
  assert.deepEqual(await send({ type: MSG.PROBE_SYSTEM, host: 'nope.example' }, { id: 'ext' }), { error: 'unregistered host' });
  // a tab that is open but not a launchpad (or not loaded yet)
  openTabs = [{ id: 12, url: 'https://my2.s4hana.cloud.sap/ui#Shell-home' }];
  probeResult = { launchpad: false, system: null, ui5Version: null };
  assert.deepEqual(await send({ type: MSG.PROBE_SYSTEM, host: 'my2.s4hana.cloud.sap' }, { id: 'ext' }), { launchpad: false, reason: 'no shell' });
  // a tab the extension may not script (pre-install) is skipped, the next one answers
  openTabs = [{ id: 99, url: 'https://my2.s4hana.cloud.sap/ui' }, { id: 13, url: 'https://my2.s4hana.cloud.sap/ui#Shell-home', active: true }];
  probeResult = { launchpad: true, ui5Version: '1.130.2', system: { productName: 'SAP S/4HANA Cloud', productVersion: 'SAP S/4HANA CLOUD 2508', systemName: 'ABC', tenantRole: 'Test', client: '100', junk: 'x', systemRole: { nested: true }, appVersion: '2025.0.23', appIntent: 'Shell-home' } };
  calls.length = 0;
  const r = await send({ type: MSG.PROBE_SYSTEM, host: 'my2.s4hana.cloud.sap' }, { id: 'ext' });
  assert.deepEqual(r, { launchpad: true, tabId: 13, ui5Version: '1.130.2', system: { productName: 'SAP S/4HANA Cloud', productVersion: 'SAP S/4HANA CLOUD 2508', systemName: 'ABC', tenantRole: 'Test', client: '100', appVersion: '2025.0.23', appIntent: 'Shell-home' } });
  assert.deepEqual(calls.filter((c) => c[0] === 'executeScript').map((c) => c.slice(1, 4)), [[13, 'MAIN', 'readLogonSystemInPage']], 'the active tab is tried first and answers');
  const meta = (await local.get('scanMeta')).scanMeta['my2.s4hana.cloud.sap'];
  assert.deepEqual(meta, { lastScanned: null, appCount: 0, ui5Version: '1.130.2', detectedEdition: 'public', system: r.system }, 'stored without pretending a scan happened');
  // on a scanned host the scan date and app count survive, only the About fields and UI5 version change
  openTabs = [{ id: 14, url: 'https://my1.s4hana.cloud.sap/ui#Shell-home' }];
  const before = (await local.get('scanMeta')).scanMeta['my1.s4hana.cloud.sap'];
  await send({ type: MSG.PROBE_SYSTEM, host: 'my1.s4hana.cloud.sap' }, { id: 'ext' });
  const after = (await local.get('scanMeta')).scanMeta['my1.s4hana.cloud.sap'];
  assert.equal(after.lastScanned, before.lastScanned);
  assert.equal(after.appCount, before.appCount);
  assert.equal(after.system.productVersion, 'SAP S/4HANA CLOUD 2508');
  assert.equal((await local.get('discovered')).discovered['my1.s4hana.cloud.sap'].system.productVersion, 'SAP S/4HANA CLOUD 2508');
  // the options snapshot sees the new fields (cache invalidated)
  const state = await send({ type: MSG.GET_STATE }, { id: 'ext' });
  assert.equal(state.snapshot.scanMeta['my1.s4hana.cloud.sap'].detectedEdition, 'public');
  openTabs = [];
  probeResult = null;
});

// ---------------------------------------------------------------- shell debug window

test('shell debug: window opens per host and calls run in an open launchpad tab', async () => {
  calls.length = 0;
  openContexts = [];
  const w = await send({ type: MSG.OPEN_DEBUG, host: 'my1.s4hana.cloud.sap' }, { id: 'ext' });
  assert.equal(w.action, 'opened');
  const opts = calls.find((c) => c[0] === 'window')[1];
  assert.equal(opts.type, 'popup');
  assert.ok(opts.url.endsWith('/src/debug/debug.html?host=my1.s4hana.cloud.sap'));
  calls.length = 0;
  assert.ok((await send({ type: MSG.OPEN_DEBUG }, { id: 'ext' })).windowId, 'no host: opens with the page choosing the default system');
  assert.ok(calls.find((c) => c[0] === 'window')[1].url.endsWith('/src/debug/debug.html'));

  assert.deepEqual(await send({ type: MSG.DEBUG_CALL, host: 'nope.example', call: 'logon.all' }, { id: 'ext' }), { error: 'unregistered host' });
  assert.deepEqual(await send({ type: MSG.DEBUG_CALL, host: 'my1.s4hana.cloud.sap', call: 'evil' }, { id: 'ext' }), { error: 'unknown call evil' });
  openTabs = [];
  assert.deepEqual(await send({ type: MSG.DEBUG_CALL, host: 'my1.s4hana.cloud.sap', call: 'logon.all' }, { id: 'ext' }), { launchpad: false, reason: 'no tab' });
  openTabs = [{ id: 99, url: 'https://my1.s4hana.cloud.sap/ui' }];
  const blocked = await send({ type: MSG.DEBUG_CALL, host: 'my1.s4hana.cloud.sap', call: 'logon.all' }, { id: 'ext' });
  assert.equal(blocked.launchpad, false);
  assert.match(blocked.reason, /cannot access/);
  openTabs = [{ id: 99, url: 'https://my1.s4hana.cloud.sap/ui' }, { id: 21, url: 'https://my1.s4hana.cloud.sap/ui#Shell-home', active: true }];
  probeResult = { ok: true, ms: 3, result: { 'getClient()': '100' } };
  calls.length = 0;
  const r = await send({ type: MSG.DEBUG_CALL, host: 'my1.s4hana.cloud.sap', call: 'app.getInfo', params: ['appVersion'] }, { id: 'ext' });
  assert.deepEqual(r, { ok: true, ms: 3, result: { 'getClient()': '100' }, tabId: 21 });
  const exec = calls.filter((c) => c[0] === 'executeScript');
  assert.deepEqual(exec.map((c) => c.slice(1)), [[21, 'MAIN', 'runDebugCallInPage', ['app.getInfo', ['appVersion']]]], 'the active tab is tried first and the call plus params are passed as args');
  probeResult = null;
  openTabs = [];
});

test('toolbar button: greyed out off SAP pages by default, kept on registered hosts and launchpad-looking pages, switchable', async () => {
  calls.length = 0;
  await L.tabUpdated(5, { status: 'loading', url: 'https://news.example.com/' }, { id: 5, url: 'https://news.example.com/' });
  await tick();
  assert.ok(calls.some((c) => c[0] === 'actionDisable' && c[1] === 5), 'a non-SAP page disables the button for that tab');
  assert.ok(calls.some((c) => c[0] === 'actionTitle' && c[1] === 5 && /address bar/.test(c[2])), 'the tooltip says how to launch anyway');
  assert.ok(calls.some((c) => c[0] === 'actionIcon' && c[1] === 5 && c[2] === 'icons/icon-off16.png'), 'and the grey icon is shown');
  calls.length = 0;
  await L.tabUpdated(6, { url: 'https://my1.s4hana.cloud.sap/ui#Shell-home' }, { id: 6, url: 'https://my1.s4hana.cloud.sap/ui#Shell-home' });
  await tick();
  assert.ok(calls.some((c) => c[0] === 'actionEnable' && c[1] === 6), 'a registered system keeps it on');
  assert.ok(calls.some((c) => c[0] === 'actionIcon' && c[1] === 6 && c[2] === 'icons/icon16.png'), 'with the blue icon');
  calls.length = 0;
  await L.tabUpdated(7, { url: 'https://erp.example.com:8443/sap/bc/ui2/flp#Shell-home' }, { id: 7, url: 'https://erp.example.com:8443/sap/bc/ui2/flp#Shell-home' });
  await tick();
  assert.ok(calls.some((c) => c[0] === 'actionEnable' && c[1] === 7), 'an unregistered launchpad keeps it on so "Add as system" is reachable');
  calls.length = 0;
  await L.tabUpdated(8, { status: 'complete' }, { id: 8, url: 'https://news.example.com/' });
  await tick();
  assert.ok(calls.some((c) => c[0] === 'actionDisable' && c[1] === 8), '"complete" re-applies the state (Chrome resets it when the navigation commits)');
  calls.length = 0;
  await L.tabUpdated(8, { title: 'x' }, { id: 8, url: 'https://news.example.com/' });
  await tick();
  assert.ok(!calls.some((c) => c[0].startsWith('action')), 'other tab changes do not');
  // activating a tab re-applies it too
  openTabs = [{ id: 9, url: 'chrome://extensions' }];
  calls.length = 0;
  await L.tabActivated({ tabId: 9 });
  await tick();
  assert.ok(calls.some((c) => c[0] === 'actionDisable' && c[1] === 9));
  // the setting turned off: global enable and every open tab enabled
  calls.length = 0;
  await sync.set({ settings: { suggestionLimit: 6, autoScanDays: 7, reuseTabOnSameHost: true, actionOnlyOnSap: false } });
  L.storageChanged({ settings: {} }, 'sync');
  await tick(80);
  assert.ok(calls.some((c) => c[0] === 'actionEnable' && c[1] === 'global'));
  assert.ok(calls.some((c) => c[0] === 'actionIcon' && c[1] === 'global' && c[2] === 'icons/icon16.png'), 'the default icon follows the setting');
  assert.ok(calls.some((c) => c[0] === 'actionEnable' && c[1] === 9), 'the chrome:// tab is enabled once the setting is off');
  // back on: global disable, open tabs judged again
  calls.length = 0;
  await sync.set({ settings: { suggestionLimit: 6, autoScanDays: 7, reuseTabOnSameHost: true, actionOnlyOnSap: true } });
  L.storageChanged({ settings: {} }, 'sync');
  await tick(80);
  assert.ok(calls.some((c) => c[0] === 'actionDisable' && c[1] === 'global'));
  assert.ok(calls.some((c) => c[0] === 'actionIcon' && c[1] === 'global' && c[2] === 'icons/icon-off16.png'));
  assert.ok(calls.some((c) => c[0] === 'actionDisable' && c[1] === 9));
  openTabs = [];
});

test('launcher: the keyboard command opens one centred window carrying the focused tab; launches target that tab', async () => {
  // an ordinary page: the overlay is injected into it (activeTab), no window
  calls.length = 0;
  await L.command('open-launcher');
  await tick();
  const inj = calls.find((c) => c[0] === 'executeScript');
  assert.ok(inj && inj[1] === 32 && inj[3] === 'showLauncherOverlay', 'the overlay function is injected into the focused tab');
  assert.equal(inj[4][3], false, 'the page blur is off unless the setting says so');
  assert.match(inj[4][0], /popup\.html\?mode=overlay&tab=32&nonce=[0-9a-f-]{36}$/);
  assert.ok(!calls.some((c) => c[0] === 'window'), 'no window when the overlay works');
  // the frame proves it was opened by the worker: the nonce in its URL is the one in session storage, nothing else passes
  const nonce = new URL(inj[4][0]).searchParams.get('nonce');
  assert.deepEqual(await send({ type: MSG.LAUNCHER_HELLO, nonce }, { id: 'ext' }), { ok: true });
  assert.deepEqual(await send({ type: MSG.LAUNCHER_HELLO, nonce: 'guess' }, { id: 'ext' }), { ok: false });
  assert.deepEqual(await send({ type: MSG.LAUNCHER_HELLO }, { id: 'ext' }), { ok: false });
  // the toolbar button does the same, for the tab it was clicked on
  calls.length = 0;
  await L.actionClicked({ id: 31, windowId: 1, url: 'https://example.com/' });
  await tick();
  const clk = calls.find((c) => c[0] === 'executeScript');
  assert.ok(clk && clk[1] === 31 && clk[3] === 'showLauncherOverlay', 'a click injects the overlay into the clicked tab');
  assert.match(clk[4][0], /mode=overlay&tab=31&nonce=[0-9a-f-]{36}$/);
  assert.deepEqual(await send({ type: MSG.LAUNCHER_HELLO, nonce }, { id: 'ext' }), { ok: false }, 'each open mints a new nonce; the previous frame no longer passes');
  // a page that cannot be scripted (injection throws) → the window
  focusedWindow = { ...focusedWindow, tabs: [{ id: 99, active: true, windowId: 1, url: 'https://cannot.script.example/' }] };
  calls.length = 0;
  await L.command('open-launcher');
  await tick();
  assert.ok(calls.some((c) => c[0] === 'window'), 'falls back to the window');
  assert.match(calls.find((c) => c[0] === 'window')[1].url, /popup\.html\?mode=launcher&nonce=[0-9a-f-]{36}&tab=99$/);
  // a chrome:// page: never scripted, straight to the window
  focusedWindow = { ...focusedWindow, tabs: [{ id: 32, active: true, windowId: 1, url: 'chrome://extensions/' }] };
  calls.length = 0;
  openContexts = [{ documentUrl: chrome.runtime.getURL('src/popup/popup.html') + '?mode=launcher&tab=9', windowId: 70 }];
  await L.command('open-launcher');
  await tick();
  assert.ok(!calls.some((c) => c[0] === 'executeScript'));
  assert.ok(calls.some((c) => c[0] === 'windowRemove' && c[1] === 70), 'a stale launcher is closed first');
  const w = calls.find((c) => c[0] === 'window');
  assert.ok(w, 'a window is created');
  assert.equal(w[1].type, 'popup');
  assert.match(w[1].url, /popup\.html\?mode=launcher&nonce=[0-9a-f-]{36}&tab=32$/, 'the active tab of the focused window rides along');
  assert.equal(w[1].width, 640);
  assert.equal(w[1].left, 100 + (1400 - 640) / 2, 'centred horizontally over the browser window');
  assert.equal(w[1].top, 50 + Math.round((900 - 620) / 6));
  openContexts = [];
  calls.length = 0;
  await L.command('something-else');
  await tick();
  assert.ok(!calls.some((c) => c[0] === 'window'), 'other commands are ignored');
  // a launch from the launcher names the tab it was opened over: that tab is reused even though it is not "the active tab"
  calls.length = 0;
  const prevUrl = activeTab.url;
  activeTab.url = 'https://unrelated.example/';
  openTabs = [{ id: 32, url: 'https://my1.s4hana.cloud.sap/ui#Shell-home', windowId: 1 }];
  const r = await send({ type: MSG.NAVIGATE, text: 'acd po', disposition: 'currentTab', contextTabId: 32 }, { id: 'ext' });
  assert.equal(r.action, 'open');
  assert.ok(calls.some((c) => c[0] === 'update' && c[1] === 32), 'the context tab is reused');
  assert.ok(calls.some((c) => c[0] === 'windowUpdate' && c[1] === 1 && c[2].focused), 'and its window focused');
  calls.length = 0;
  await send({ type: MSG.NAVIGATE, text: 'acd po', disposition: 'newForegroundTab', contextTabId: 32 }, { id: 'ext' });
  const created = calls.find((c) => c[0] === 'create');
  assert.equal(created[1].windowId, 1, 'new tabs open in the context tab\'s window');
  calls.length = 0;
  await send({ type: MSG.NAVIGATE, text: 'acd po', disposition: 'currentTab', contextTabId: 999 }, { id: 'ext' });
  assert.ok(calls.some((c) => c[0] === 'create' && !('windowId' in c[1])), 'a vanished context tab falls back to the old behaviour');
  openTabs = [];
  activeTab.url = prevUrl;
});

test('launcher: a scan started from the launcher reopens it in the tab once the discovery result lands', async () => {
  openTabs = [{ id: 44, url: 'https://my2.s4hana.cloud.sap/ui#Shell-home', windowId: 1 }];
  calls.length = 0;
  const r = await send({ type: MSG.RESCAN_HOST, host: 'my2.s4hana.cloud.sap', reopenLauncher: true }, { id: 'ext' });
  assert.equal(r.status, 'messaged');
  assert.equal((await session.get('reopenLauncher')).reopenLauncher.host, 'my2.s4hana.cloud.sap');
  calls.length = 0;
  await send({ type: MSG.DISCOVERY_RESULT, host: 'my2.s4hana.cloud.sap', entries: [{ intent: 'SalesOrder-manage', title: 'Manage Sales Orders' }] }, { id: 'ext', tab: { id: 44, windowId: 1, url: 'https://my2.s4hana.cloud.sap/ui#Shell-home' } });
  await tick();
  const inj = calls.find((c) => c[0] === 'executeScript' && c[3] === 'showLauncherOverlay');
  assert.ok(inj && inj[1] === 44, 'the overlay is injected into the tab that reported the scan');
  assert.match(decodeURIComponent(inj[4][0]).replace(/\+/g, ' '), /note=Scanned tst: 1 apps$/);
  assert.equal((await session.get('reopenLauncher')).reopenLauncher, null, 'one reopen only');
  // a scan not started from the launcher does nothing of the sort
  calls.length = 0;
  await send({ type: MSG.RESCAN_HOST, host: 'my2.s4hana.cloud.sap' }, { id: 'ext' });
  await send({ type: MSG.DISCOVERY_RESULT, host: 'my2.s4hana.cloud.sap', entries: [] }, { id: 'ext', tab: { id: 44, windowId: 1, url: 'https://my2.s4hana.cloud.sap/ui' } });
  await tick();
  assert.ok(!calls.some((c) => c[0] === 'executeScript' && c[3] === 'showLauncherOverlay'));
  openTabs = [];
});

test('rescan runs in the window it was asked from: a launchpad tab in another window is left alone', async () => {
  // options page in window 1 asks; the only launchpad tab of the system sits in window 2
  openTabs = [{ id: 61, url: 'https://my1.s4hana.cloud.sap/ui#Shell-home', windowId: 2, active: true }];
  calls.length = 0;
  let r = await send({ type: MSG.RESCAN_HOST, host: 'my1.s4hana.cloud.sap' }, { id: 'ext', tab: { id: 60, windowId: 1, url: 'chrome-extension://ext/src/options/options.html' } });
  assert.equal(r.status, 'opened');
  assert.ok(!calls.some((c) => (c[0] === 'tabMessage' || c[0] === 'reload') && c[1] === 61), 'the tab in the other window is neither messaged nor reloaded');
  assert.deepEqual(calls.find((c) => c[0] === 'create')[1], { url: 'https://my1.s4hana.cloud.sap/ui#Shell-home', active: true, windowId: 1 });
  // the same window: the active launchpad tab wins over a background one
  openTabs = [{ id: 62, url: 'https://my1.s4hana.cloud.sap/ui', windowId: 1, active: false }, { id: 63, url: 'https://my1.s4hana.cloud.sap/ui#Shell-home', windowId: 1, active: true }, { id: 61, url: 'https://my1.s4hana.cloud.sap/ui', windowId: 2, active: true }];
  calls.length = 0;
  r = await send({ type: MSG.RESCAN_HOST, host: 'my1.s4hana.cloud.sap' }, { id: 'ext', tab: { id: 60, windowId: 1 } });
  assert.equal(r.status, 'messaged');
  assert.deepEqual(calls[0], ['tabMessage', 63, { type: MSG.RESCAN_TAB }]);
  // from the launcher: the tab it was opened on is scanned, whichever window holds it
  calls.length = 0;
  r = await send({ type: MSG.RESCAN_HOST, host: 'my1.s4hana.cloud.sap', reopenLauncher: true, contextTabId: 61 }, { id: 'ext', tab: { id: 70, windowId: 3 } });
  assert.equal(r.status, 'messaged');
  assert.deepEqual(calls[0], ['tabMessage', 61, { type: MSG.RESCAN_TAB }]);
  // a context tab that is not on the system (stale id) falls back to the window rule
  calls.length = 0;
  r = await send({ type: MSG.RESCAN_HOST, host: 'my1.s4hana.cloud.sap', contextTabId: 31 }, { id: 'ext', tab: { id: 70, windowId: 3 } });
  assert.equal(r.status, 'opened');
  assert.equal(calls.find((c) => c[0] === 'create')[1].windowId, 3);
  openTabs = [];
});

test('popup source filter: the RESOLVE message narrows by origin and says so when nothing is left', async () => {
  const lib = await send({ type: MSG.RESOLVE, text: 'acd po', source: 'library' }, { id: 'ext' });
  assert.equal(lib.source, 'library');
  assert.ok(lib.matches.length && lib.matches.every((m) => m.content !== 'acd po'), 'the seed alias "po" is not a library row');
  const disc = await send({ type: MSG.RESOLVE, text: 'acd purchase', source: 'discovered' }, { id: 'ext' });
  assert.ok(disc.matches.length && disc.matches.every((m) => m.onTenant), 'discovered rows are on the tenant by definition: ' + JSON.stringify(disc.matches.map((m) => m.content)));
  assert.ok(disc.matches.every((m) => m.content !== 'acd po'), 'the seed alias row is a different origin');
  const none = await send({ type: MSG.RESOLVE, text: 'acd zq9x', source: 'discovered' }, { id: 'ext' });
  assert.deepEqual(none.matches, []);
  assert.match(none.hint, /Nothing from "discovered" matches/);
  const bogus = await send({ type: MSG.RESOLVE, text: 'acd po', source: 'whatever' }, { id: 'ext' });
  assert.equal(bogus.source, 'all', 'unknown values mean no filter');
  assert.ok(bogus.matches.some((m) => m.content === 'acd po'));
});

test('popup hints: default descriptions are marked so the popup can hide them; notices are marked as such', async () => {
  const plain = await send({ type: MSG.RESOLVE, text: 'acd po' }, { id: 'ext' });
  assert.equal(plain.hintKind, 'default');
  assert.match(plain.hint, /^Open /);
  const notice = await send({ type: MSG.RESOLVE, text: 'tst po', availableOnly: true }, { id: 'ext' });
  assert.equal(notice.hintKind, 'notice');
  assert.match(notice.hint, /not been scanned|No app found in the last scan/);
});

test('popup rows carry what the popup needs to highlight the match: type, t-codes and the typed terms', async () => {
  const r = await send({ type: MSG.RESOLVE, text: 'acd manage purchase' }, { id: 'ext' });
  assert.deepEqual(r.terms, { head: 'manage', query: 'manage purchase' });
  assert.ok(r.matches.every((m) => typeof m.matchType === 'string' && Array.isArray(m.tcodes)));
  assert.ok(r.matches.some((m) => /^title/.test(m.matchType)), 'title words match by title');
  const t = await send({ type: MSG.RESOLVE, text: 'acd me23n' }, { id: 'ext' });
  assert.ok(t.matches.some((m) => m.matchType === 'tcode' && m.tcodes.includes('me23n')), 'the t-code row names the code that matched');
});

test('ranking: a launch makes its app come first among equal-tier matches next time', async () => {
  // two library/seed rows matched by the same title word on acd; launch one, then it leads
  const before = await send({ type: MSG.RESOLVE, text: 'acd purchase', source: 'all' }, { id: 'ext' });
  assert.ok(before.matches.length >= 2);
  const target = before.matches[before.matches.length - 1];
  await local.set({ recent: [{ ts: Date.now(), systemKey: 'acd', host: 'my1.s4hana.cloud.sap', intent: target.intent, alias: target.alias, title: target.title, url: 'x', input: target.content }] });
  L.storageChanged({ recent: {} }, 'local');
  await tick();
  const after = await send({ type: MSG.RESOLVE, text: 'acd purchase', source: 'all' }, { id: 'ext' });
  const pos = after.matches.findIndex((m) => m.intent === target.intent);
  assert.ok(pos >= 0 && pos < before.matches.length - 1, `moved up from last: now at ${pos}`);
  await local.set({ recent: [] });
  L.storageChanged({ recent: {} }, 'local');
});

test('popup rows name their source, so an untitled row can show it instead of repeating the intent', async () => {
  const r = await send({ type: MSG.RESOLVE, text: 'acd po' }, { id: 'ext' });
  assert.ok(r.matches.every((m) => ['user', 'import', 'discovered', 'seed', 'library', 'gui'].includes(m.source)), JSON.stringify(r.matches.map((m) => m.source)));
});
