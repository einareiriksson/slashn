// Drives the service worker through a minimal fake chrome.* API.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { memoryArea } from '../src/storage.js';
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

globalThis.chrome = {
  runtime: {
    id: 'ext',
    getManifest: () => ({ version: '0.1.0' }),
    getURL: (p) => url.pathToFileURL(path.join(root, p)).href,
    onInstalled: listener('onInstalled'),
    onStartup: listener('onStartup'),
    onMessage: listener('onMessage'),
    openOptionsPage: async () => { calls.push(['options']); },
    getContexts: async () => [],
    sendMessage: async (m) => { calls.push(['sendMessage', m]); return { ok: true }; },
  },
  omnibox: {
    onInputStarted: listener('onInputStarted'),
    onInputChanged: listener('onInputChanged'),
    onInputEntered: listener('onInputEntered'),
    onInputCancelled: listener('onInputCancelled'),
    setDefaultSuggestion: (s) => { lastDefault = s.description; },
  },
  storage: { sync, local, session, onChanged: listener('storageChanged') },
  tabs: {
    query: async (q) => (q.active ? [activeTab] : openTabs.filter((t) => !q.url || t.url.startsWith(q.url.replace('/*', '')))),
    create: async (o) => { calls.push(['create', o]); return { id: 2 }; },
    update: async (id, o) => { calls.push(['update', id, o]); return { id }; },
    reload: async (id) => { calls.push(['reload', id]); },
    sendMessage: async (id, m) => { calls.push(['tabMessage', id, m]); if (id === 99) throw new Error('no receiver'); return {}; },
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
  scripting: {
    registered: [],
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

test('unknown alias opens the app finder and copies the text', async () => {
  const c = await entered('acd zzzq');
  assert.deepEqual(c[0], ['update', 1, { url: 'https://my1.s4hana.cloud.sap/ui#Shell-appfinder' }]);
  assert.ok(c.some((x) => x[0] === 'offscreen'));
  assert.ok(c.some((x) => x[0] === 'sendMessage' && x[1].type === MSG.COPY && x[1].text === 'zzzq'));
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
  openTabs = [{ id: 5, url: 'https://my1.s4hana.cloud.sap/ui#Shell-home' }];
  r = await send({ type: MSG.RESCAN_HOST, host: 'my1.s4hana.cloud.sap' }, { id: 'ext' });
  assert.equal(r.status, 'messaged');
  openTabs = [{ id: 99, url: 'https://my1.s4hana.cloud.sap/ui' }];
  r = await send({ type: MSG.RESCAN_HOST, host: 'my1.s4hana.cloud.sap' }, { id: 'ext' });
  assert.equal(r.status, 'reloaded');
  assert.deepEqual(await send({ type: 'nope' }), { ignored: true });
  assert.deepEqual(await send({ type: MSG.PAGE_READY, host: 'x' }, { id: 'other' }), { error: 'foreign sender' });
});

test('popup messages: resolve, navigate, open url', async () => {
  const r = await send({ type: MSG.RESOLVE, text: 'acd me23n 4500001234' }, { id: 'ext' });
  assert.equal(r.kind, 'query');
  assert.equal(r.system.key, 'acd');
  assert.equal(r.matches[0].content, 'acd me23n 4500001234');
  assert.equal(r.matches[0].param, '4500001234');
  assert.ok(r.hint.includes('me23n') && !r.hint.includes('<'));
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
  await sync.set({ systems: [...systems, { key: 'fin', name: 'Finteq', customer: 'finteq', host: 'acd.finteq.io', launchpadPath: '/ui', env: 'TST', isDefault: false }] });
  L.storageChanged({ systems: {} }, 'sync');
  await tick();
  assert.deepEqual(chrome.scripting.registered, []); // no permission yet
  chrome.permissions.granted.add('https://acd.finteq.io/*');
  L.permAdded();
  await tick();
  assert.deepEqual(chrome.scripting.registered.map((s) => [s.id, s.world || 'ISOLATED', s.matches[0]]), [
    ['sapqs-main-acd.finteq.io', 'MAIN', 'https://acd.finteq.io/*'],
    ['sapqs-iso-acd.finteq.io', 'ISOLATED', 'https://acd.finteq.io/*'],
  ]);
  L.permAdded();
  await tick();
  assert.equal(chrome.scripting.registered.length, 2); // idempotent
  const r = await send({ type: MSG.PAGE_READY, host: 'acd.finteq.io' });
  assert.equal(r.scan, true);
  await sync.set({ systems });
  L.storageChanged({ systems: {} }, 'sync');
  await tick();
  assert.deepEqual(chrome.scripting.registered, []);
});
