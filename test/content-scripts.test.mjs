// Runs the two content scripts (plain IIFEs, no modules) inside a vm sandbox with a fake window/location/chrome,
// to pin down what they report to the service worker. The host they send must equal URL.host of the page
// (hostname plus a non-default port), because that is how systems are stored and looked up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const ISOLATED = fs.readFileSync(path.join(root, 'src/content-isolated.js'), 'utf8');
const MAIN = fs.readFileSync(path.join(root, 'src/content-main.js'), 'utf8');

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
/** Objects born inside the vm realm have foreign prototypes; clone them before strict deep-equal. */
const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** A page: one window shared by both worlds, with postMessage delivered asynchronously like a browser does. */
function makePage(href, { sap = undefined } = {}) {
  const loc = new URL(href);
  const location = { href: loc.href, host: loc.host, hostname: loc.hostname, origin: loc.origin, port: loc.port, protocol: loc.protocol };
  const listeners = [];
  const window = {
    location,
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    postMessage: (data, targetOrigin) => {
      assert.equal(targetOrigin, location.origin, 'postMessage is pinned to the page origin');
      deliver(data, location.origin);
    },
  };
  /** Deliver a message event as if posted from `origin` (another frame when it differs from the page origin). */
  const deliver = (data, origin) => setTimeout(() => { for (const fn of listeners.slice()) fn({ source: window, origin, data }); }, 0);
  if (sap) window.sap = sap;
  const workerMessages = [];
  let workerReply = () => ({});
  const runtimeListeners = [];
  const chrome = {
    runtime: {
      sendMessage: async (msg) => { workerMessages.push(plain(msg)); return workerReply(msg); },
      onMessage: { addListener: (fn) => runtimeListeners.push(fn) },
    },
  };
  const sandbox = {
    window, location, chrome, console: { debug: () => {}, warn: () => {}, log: () => {} },
    setTimeout, clearTimeout, Date, Promise, Array, Object, String, Boolean, Number, Error, Map, Set, RegExp, JSON, Math,
    performance: { now: () => Date.now() },
    requestIdleCallback: (fn) => setTimeout(fn, 0),
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  return {
    window, location, chrome, workerMessages, deliver,
    setWorkerReply: (fn) => { workerReply = fn; },
    runIsolated: () => vm.runInContext(ISOLATED, ctx, { filename: 'content-isolated.js' }),
    runMain: () => vm.runInContext(MAIN, ctx, { filename: 'content-main.js' }),
    /** Deliver a chrome.runtime message to the isolated script, resolving with its sendResponse payload. */
    fromWorker: (msg) => new Promise((resolve) => { for (const fn of runtimeListeners) fn(msg, { id: 'ext' }, (r) => resolve(plain(r))); }),
    /** Collects every window message posted on the page, cloned. */
    tap: () => { const out = []; window.addEventListener('message', (ev) => out.push(plain(ev.data))); return out; },
  };
}

const fakeShell = ({ links, supported = () => true, logon = null, renderer = true, appInfo = null }) => ({
  ui: { version: '1.120.0' },
  ushell: {
    Container: {
      getRenderer: () => (renderer ? {} : null),
      getLogonSystem: () => logon,
      getServiceAsync: async (name) => {
        if (name === 'AppLifeCycle' && appInfo) return { getCurrentApplication: () => ({ getAllAppInfo: async (flag) => (flag ? appInfo : { custom: 'entry' }), getInfo: async () => ({ appVersion: 'never: getAllAppInfo answered' }) }) };
        if (name === 'Navigation') {
          return {
            getLinks: async (args) => (Array.isArray(args) ? args.map(() => links) : links),
            getSemanticObjects: async () => [...new Set(links.map((l) => l.intent.replace(/^#/, '').split('-')[0]))],
            isNavigationSupported: async (targets) => targets.map((t) => ({ supported: supported(`${t.target.semanticObject}-${t.target.action}`) })),
          };
        }
        throw new Error(`no service ${name}`);
      },
    },
  },
});

test('isolated script reports host with port on PAGE_READY and forwards discovery for that host', async () => {
  const page = makePage('https://acd.finteq.io:8443/sap/bc/ui2/flp?sap-client=600#Shell-home');
  page.setWorkerReply((m) => (m.type === 'SAPQS_PAGE_READY' ? { scan: true, reason: 'never scanned' } : { stored: 1 }));
  page.runIsolated();
  await tick();
  const ready = page.workerMessages.find((m) => m.type === 'SAPQS_PAGE_READY');
  assert.ok(ready);
  assert.equal(ready.host, 'acd.finteq.io:8443', 'host carries the non-default port, like URL.host and the stored system');
  assert.equal(ready.url, page.location.href);
  // the page (MAIN world) answers the RESCAN with a discovery result; the isolated script forwards it with the same host
  page.window.postMessage({ ns: 'SAPQS', type: 'SAPQS_DISCOVERY', host: page.location.host, entries: [
    { intent: 'PurchaseOrder-manage', title: 'Manage Purchase Orders', appId: 'F0842' },
    { intent: 'bad intent', title: 'dropped' },
    { intent: 'Zcustom-run' },
  ], ui5Version: '1.120.0', system: { productVersion: 'SAP S/4HANA 2023 FPS02', junk: 'x' }, methods: { links: 'x' }, errors: [] }, page.location.origin);
  await tick();
  const disc = page.workerMessages.find((m) => m.type === 'SAPQS_DISCOVERY_RESULT');
  assert.ok(disc);
  assert.equal(disc.host, 'acd.finteq.io:8443');
  assert.deepEqual(disc.entries.map((e) => e.intent), ['PurchaseOrder-manage', 'Zcustom-run']);
  assert.deepEqual(disc.entries[1], { intent: 'Zcustom-run', semanticObject: 'Zcustom', action: 'run', title: 'Zcustom-run', appId: null, paramKey: null });
  assert.deepEqual(disc.system, { productVersion: 'SAP S/4HANA 2023 FPS02' });
  assert.equal(disc.ui5Version, '1.120.0');
});

test('isolated script: default ports and public cloud hosts are reported without a port', async () => {
  for (const [href, host] of [
    ['https://my1.s4hana.cloud.sap/ui#Shell-home', 'my1.s4hana.cloud.sap'],
    ['https://erp.example.com:443/sap/bc/ui2/flp', 'erp.example.com'],
    ['http://erp.internal.example:8000/sap/bc/ui2/flp?sap-client=100', 'erp.internal.example:8000'],
    ['http://erp.internal.example:80/sap/bc/ui2/flp', 'erp.internal.example'],
  ]) {
    const page = makePage(href);
    page.runIsolated();
    await tick();
    assert.equal(page.workerMessages[0].host, host, href);
  }
});

test('isolated script ignores messages from other origins and foreign namespaces', async () => {
  const page = makePage('https://acd.finteq.io:8443/sap/bc/ui2/flp');
  page.runIsolated();
  await tick();
  page.workerMessages.length = 0;
  // a lookalike payload under another namespace, and a genuine payload arriving from another origin
  page.window.postMessage({ ns: 'OTHER', type: 'SAPQS_DISCOVERY', entries: [{ intent: 'A-b' }] }, page.location.origin);
  page.deliver({ ns: 'SAPQS', type: 'SAPQS_DISCOVERY', entries: [{ intent: 'A-b' }] }, 'https://evil.example');
  page.deliver({ ns: 'SAPQS', type: 'SAPQS_DISCOVERY', entries: [{ intent: 'A-b' }] }, 'https://acd.finteq.io');
  await tick();
  assert.equal(page.workerMessages.length, 0, 'nothing forwarded');
  page.deliver({ ns: 'SAPQS', type: 'SAPQS_DISCOVERY', entries: [{ intent: 'A-b' }] }, page.location.origin);
  await tick();
  assert.equal(page.workerMessages.length, 1, 'the same payload from the page origin is forwarded');
});

test('main script: discovery result posts host with port and the About-dialog fields', async () => {
  const links = [
    { intent: '#PurchaseOrder-manage', text: 'Manage Purchase Orders' },
    { intent: '#PurchaseOrder-displayFactSheet?PurchaseOrder=1', text: 'Purchase Order' },
    { intent: '#PurchaseOrder-displayFactSheet?PurchaseOrder=2&sap-ushell-navmode=explace', text: 'Purchase Order' },
    { intent: '#Shell-startGUI?sap-ui-tech-hint=GUI', text: 'GUI' },
    { intent: 'not an intent', text: 'x' },
  ];
  const logon = { getProductName: () => 'SAP S/4HANA', getProductVersion: () => 'SAP S/4HANA 2023 FPS02', getSystemName: () => 'ACD', getClient: () => '600', getSystemRole: () => { throw new Error('n/a'); }, getClientRole: () => 'D' };
  const page = makePage('http://erp.internal.example:8000/sap/bc/ui2/flp?sap-client=600#Shell-home', { sap: fakeShell({ links, logon, appInfo: { appVersion: '2025.0.23', appIntent: 'Shell-home', appId: { value: 'sap.ushell.components.pages' }, theme: 'sap_horizon', productVersion: 'ignored: the logon system has one' } }) });
  const posted = page.tap();
  page.runMain();
  await tick();
  assert.ok(posted.some((m) => m.type === 'SAPQS_MAIN_READY'));
  page.window.postMessage({ ns: 'SAPQS', type: 'SAPQS_RESCAN' }, page.location.origin);
  await tick(50);
  const disc = posted.find((m) => m.type === 'SAPQS_DISCOVERY');
  assert.ok(disc, 'discovery ran');
  assert.equal(disc.host, 'erp.internal.example:8000');
  assert.deepEqual(disc.entries.map((e) => e.intent).sort(), ['PurchaseOrder-displayFactSheet', 'PurchaseOrder-manage', 'Shell-startGUI']);
  const fs = disc.entries.find((e) => e.intent === 'PurchaseOrder-displayFactSheet');
  assert.equal(fs.paramKey, 'PurchaseOrder', 'sap-* parameters are ignored when deriving the single parameter key');
  assert.equal(disc.entries.find((e) => e.intent === 'Shell-startGUI').paramKey, null, 'sap-ui-tech-hint is not a business key');
  assert.deepEqual(disc.system, { productName: 'SAP S/4HANA', productVersion: 'SAP S/4HANA 2023 FPS02', systemName: 'ACD', client: '600', clientRole: 'D', appVersion: '2025.0.23', appIntent: 'Shell-home', appId: 'sap.ushell.components.pages', theme: 'sap_horizon', custom: 'entry' }, 'System tab fields plus everything getAllAppInfo returns; the isolated script bounds the list before it reaches the worker');
  assert.equal(disc.ui5Version, '1.120.0');
  assert.equal(disc.methods.service, 'Navigation');
  assert.ok(Array.isArray(disc.errors));
});

test('main script: live check answers in input order, false for malformed intents', async () => {
  const page = makePage('https://acd.finteq.io:8443/sap/bc/ui2/flp', { sap: fakeShell({ links: [], supported: (i) => i === 'PurchaseOrder-manage' }) });
  const posted = page.tap();
  page.runMain();
  page.window.postMessage({ ns: 'SAPQS', type: 'SAPQS_CHECK', id: 7, intents: ['PurchaseOrder-create', 'garbage', '#PurchaseOrder-manage'] }, page.location.origin);
  await tick(20);
  const res = posted.find((m) => m.type === 'SAPQS_CHECK_RESULT');
  assert.deepEqual(res, { ns: 'SAPQS', type: 'SAPQS_CHECK_RESULT', id: 7, supported: [false, false, true] });
});

test('both worlds together: CHECK_INTENTS from the worker round-trips through the page', async () => {
  const page = makePage('https://acd.finteq.io:8443/sap/bc/ui2/flp', { sap: fakeShell({ links: [{ intent: '#PurchaseOrder-manage', text: 'Manage Purchase Orders' }], supported: (i) => i !== 'PurchaseOrder-create', logon: { getProductVersion: () => 'SAP SCREEN PERSONAS 3.0\r\nSAP SMART BUSINESS FOR FND 1.0\r\nSAP SMART BUSINESS FOR ERP 1.0\r\nSAP ANALYTICS FOUNDATION 1.0\r\nSAP S/4HANA 2025\r\nABAP PLATFORM 2025\r\nSAP S/4HANA FOUNDATION 2025\r\nSAP FIORI FOR SAP S/4HANA 2025\r\nSAP FIORI FES 2025 FOR S/4HANA', getClient: () => '600', getSystemRole: () => 1 }, appInfo: { appVersion: '2025.0.23', appTitle: 'Home', transaction: 42, theme: 'sap_horizon', nested: { no: 1 } } }) });
  page.runMain();
  page.runIsolated();
  await tick();
  const reply = await page.fromWorker({ type: 'SAPQS_CHECK_INTENTS', intents: ['PurchaseOrder-create', 'PurchaseOrder-manage', 'bad intent'] });
  assert.deepEqual(reply, { intents: ['PurchaseOrder-create', 'PurchaseOrder-manage'], supported: [false, true] });
  // RESCAN_TAB from the worker triggers a scan whose result reaches the worker with the ported host
  page.setWorkerReply(() => ({ stored: 0 }));
  assert.deepEqual(await page.fromWorker({ type: 'SAPQS_RESCAN_TAB' }), { ok: true });
  await tick(50);
  const disc = page.workerMessages.find((m) => m.type === 'SAPQS_DISCOVERY_RESULT');
  assert.ok(disc);
  assert.equal(disc.host, 'acd.finteq.io:8443');
  assert.deepEqual(disc.entries.map((e) => e.intent), ['PurchaseOrder-manage']);
  assert.equal(disc.system.productVersion.split('\r\n').length, 9, 'the bridge forwards the whole installed-products list (longer than 120 characters) for the worker to split');
  assert.equal(disc.system.systemRole, '1');
  assert.deepEqual(Object.keys(disc.system).sort(), ['appTitle', 'appVersion', 'client', 'productVersion', 'systemRole', 'transaction'], 'System and Application fields forwarded, numbers as strings, unknown or nested keys dropped');
  assert.equal(disc.system.transaction, '42');
});

test('main script: a shell with no navigation links reports an error instead of an empty scan', async () => {
  const page = makePage('https://acd.finteq.io:8443/sap/bc/ui2/flp', { sap: fakeShell({ links: [] }) });
  const posted = page.tap();
  page.runMain();
  page.window.postMessage({ ns: 'SAPQS', type: 'SAPQS_RESCAN' }, page.location.origin);
  await tick(50);
  assert.equal(posted.find((m) => m.type === 'SAPQS_DISCOVERY'), undefined, 'an empty result must not overwrite a previous scan');
  const err = posted.find((m) => m.type === 'SAPQS_DISCOVERY_ERROR');
  assert.equal(err.host, 'acd.finteq.io:8443');
  assert.match(err.error, /no navigation links/);
});
