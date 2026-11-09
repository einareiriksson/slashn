import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLogonSystemInPage, systemInfoRows, SYSTEM_INFO_LABELS, HIDDEN_INFO_FIELDS, describeClientRole } from '../src/probe.js';
import { normalizeSystem } from '../src/storage.js';

const logon = (over = {}) => ({
  getProductName: () => 'SAP S/4HANA', getProductVersion: () => 'SAP S/4HANA 2023 FPS02', getSystemName: () => 'ACD',
  getSystemRole: () => 'Development System', getTenantRole: () => { throw new Error('not on this release'); }, getClient: () => '600', getClientRole: () => 'D', ...over,
});

const appLifeCycle = (info) => ({ getCurrentApplication: () => ({ getInfo: async (keys) => Object.fromEntries(Object.entries(info).filter(([k]) => keys.includes(k))) }) });

test('readLogonSystemInPage reads the About getters defensively', async () => {
  globalThis.window = { sap: { ui: { version: '1.108.4' }, ushell: { Container: { getLogonSystem: () => logon() } } } };
  assert.deepEqual(readLogonSystemInPage(), {
    launchpad: true, ui5Version: '1.108.4',
    system: { productName: 'SAP S/4HANA', productVersion: 'SAP S/4HANA 2023 FPS02', systemName: 'ACD', systemRole: 'Development System', client: '600', clientRole: 'D' },
  }, 'without getServiceAsync the result is synchronous');
  globalThis.window = { sap: { ushell: { Container: {} } } }; // very old shell: no getLogonSystem, no sap.ui
  assert.deepEqual(readLogonSystemInPage(), { launchpad: true, system: {}, ui5Version: null });
  globalThis.window = { sap: { ushell: { Container: { getLogonSystem: () => { throw new Error('boom'); } } } } };
  assert.deepEqual(readLogonSystemInPage(), { launchpad: true, system: {}, ui5Version: null });
  globalThis.window = { sap: { ushell: { Container: { getLogonSystem: () => logon({ getClient: () => 600 }) } } } };
  assert.equal(readLogonSystemInPage().system.client, '600', 'numeric logon values (getSystemRole() returns 1 on some releases) are reported as strings');
  globalThis.window = { sap: { ushell: { Container: { getLogonSystem: () => logon({ getClient: () => ({ nested: 1 }) }) } } } };
  assert.equal(readLogonSystemInPage().system.client, undefined, 'objects are not reported');
  globalThis.window = {};
  assert.deepEqual(readLogonSystemInPage(), { launchpad: false, system: null, ui5Version: null });

  // Application tab via AppLifeCycle: the running app's version (the S/4HANA stack version), id, intent; wrapped { value } forms unwrapped
  const info = { appVersion: '2025.0.23', appId: 'F0842', appIntent: { value: 'PurchaseOrder-manage', label: 'Intent' }, appTitle: 'Manage Purchase Orders', technicalAppComponentId: 'MM_PO_MANAGE', appSupportInfo: 'MM-FIO-PUR-PO', appFrameworkVersion: '1.136.3', productVersion: 'from app info, ignored when the logon system has one', theme: 'sap_horizon' };
  globalThis.window = { sap: { ui: { version: '1.136.3' }, ushell: { Container: { getLogonSystem: () => logon(), getServiceAsync: async (name) => { if (name !== 'AppLifeCycle') throw new Error(name); return appLifeCycle(info); } } } } };
  const r = await readLogonSystemInPage();
  assert.equal(r.launchpad, true);
  assert.equal(r.system.appVersion, '2025.0.23');
  assert.equal(r.system.appIntent, 'PurchaseOrder-manage');
  assert.equal(r.system.appTitle, 'Manage Purchase Orders');
  assert.equal(r.system.technicalAppComponentId, 'MM_PO_MANAGE');
  assert.equal(r.system.appFrameworkVersion, '1.136.3');
  assert.equal(r.system.productVersion, 'SAP S/4HANA 2023 FPS02', 'logon-system values win over the app info copy');
  assert.equal(r.system.theme, undefined, 'only the requested keys are asked for');
  // the dialog's own source wins: getAllAppInfo(true) then (false), getInfo only when they yield no version, the manifest last
  const allInfo = (first, second) => ({ getCurrentApplication: () => ({
    getAllAppInfo: async (flag) => (flag ? first : second),
    getInfo: async () => ({ appVersion: 'from getInfo', appId: 'from getInfo' }),
    componentInstance: { getManifestEntry: (p) => (p === '/sap.app/applicationVersion/version' ? 'from manifest' : null) },
  }) });
  globalThis.window = { sap: { ushell: { Container: { getLogonSystem: () => logon(), getServiceAsync: async () => allInfo({ appVersion: '2025.0.23', appId: 'F0842', transaction: 'ME21N', contentProviderLabel: 'Local' }, { customField: 'x' }) } } } };
  let a = await readLogonSystemInPage();
  assert.equal(a.system.appVersion, '2025.0.23');
  assert.equal(a.system.appId, 'F0842', 'getInfo is not consulted once getAllAppInfo answered');
  assert.equal(a.system.transaction, 'ME21N');
  assert.equal(a.system.contentProviderLabel, 'Local');
  assert.equal(a.system.customField, 'x', 'custom entries (getAllAppInfo(false)) are merged too; sanitizeSystemInfo bounds them later');
  globalThis.window = { sap: { ushell: { Container: { getLogonSystem: () => logon(), getServiceAsync: async () => allInfo({ appId: 'F0842' }, null) } } } };
  a = await readLogonSystemInPage();
  assert.equal(a.system.appVersion, 'from getInfo', 'no version from getAllAppInfo: getInfo fills it');
  assert.equal(a.system.appId, 'F0842', 'but values already read are kept');
  globalThis.window = { sap: { ushell: { Container: { getLogonSystem: () => logon(), getServiceAsync: async () => ({ getCurrentApplication: () => ({ getAllAppInfo: async () => { throw new Error('nope'); }, componentInstance: { getManifestEntry: () => 'from manifest' } }) }) } } } };
  a = await readLogonSystemInPage();
  assert.equal(a.system.appVersion, 'from manifest', 'neither call available or working: the component manifest is read directly');
  // a logon system without product fields: the app info fills them
  globalThis.window = { sap: { ushell: { Container: { getLogonSystem: () => null, getServiceAsync: async () => appLifeCycle({ productName: 'SAP S/4HANA', productVersion: 'SAP S/4HANA 2025' }) } } } };
  assert.equal((await readLogonSystemInPage()).system.productVersion, 'SAP S/4HANA 2025');
  // AppLifeCycle missing, broken or without a current app: the System fields still come back
  for (const svc of [async () => { throw new Error('no such service'); }, async () => ({}), async () => ({ getCurrentApplication: () => null }), async () => ({ getCurrentApplication: () => ({ getInfo: async () => { throw new Error('nope'); } }) })]) {
    globalThis.window = { sap: { ushell: { Container: { getLogonSystem: () => logon(), getServiceAsync: svc } } } };
    const x = await readLogonSystemInPage();
    assert.equal(x.system.productVersion, 'SAP S/4HANA 2023 FPS02');
    assert.equal(x.system.appVersion, undefined);
  }
  delete globalThis.window;
  // must be self-contained: executeScript serialises it, so no free identifiers besides window
  assert.ok(!/\b(sanitizeSystemInfo|SYSTEM_INFO_FIELDS|import|require)\b/.test(readLogonSystemInPage.toString()));
});

test('describeClientRole: the T000 client categories, unknown codes and spelled-out roles pass through', () => {
  assert.equal(describeClientRole('D'), 'D · Demo');
  assert.equal(describeClientRole('p'), 'P · Production');
  assert.equal(describeClientRole('C'), 'C · Customizing');
  assert.equal(describeClientRole('T'), 'T · Test');
  assert.equal(describeClientRole('E'), 'E · Training / Education');
  assert.equal(describeClientRole('S'), 'S · SAP reference');
  assert.equal(describeClientRole('X'), 'X');
  assert.equal(describeClientRole('Development'), 'Development');
  assert.equal(describeClientRole(''), null);
  assert.equal(describeClientRole(undefined), null);
});

test('systemInfoRows: scan values, live values win row by row, edition conflict is spelled out', () => {
  const system = normalizeSystem({ key: 'fin', name: 'Finteq ACD', customer: 'finteq', host: 'acd.finteq.io:8443', launchpadPath: '/sap/bc/ui2/flp', launchpadQuery: 'sap-client=600', env: 'TST', edition: 'public' });
  const meta = { lastScanned: '2026-10-30T09:00:00Z', appCount: 412, ui5Version: '1.108.4', detectedEdition: 'onprem', system: { productName: 'SAP S/4HANA', productVersion: 'SAP S/4HANA 2023 FPS02', systemName: 'ACD', client: '600' } };
  const by = (rows, label) => rows.find((r) => r.label === label);
  const rows = systemInfoRows({ system, meta });
  assert.deepEqual(by(rows, 'Client role'), { section: 'About · System', label: 'Client role', value: null }, 'the on-premise client role has a row');
  assert.equal(by(systemInfoRows({ system, meta: { ...meta, system: { ...meta.system, clientRole: 'D' } } }), 'Client role').value, 'D · Demo', 'T000 client category decoded');
  for (const name of HIDDEN_INFO_FIELDS) assert.equal(by(rows, SYSTEM_INFO_LABELS[name]), undefined, `${name} is read but not listed`);
  assert.deepEqual([...new Set(rows.map((r) => r.section))], ['System', 'About · System', 'About · Application', 'Scan']);
  assert.equal(by(rows, 'Key').value, 'fin');
  assert.equal(by(rows, 'Launchpad').value, 'https://acd.finteq.io:8443/sap/bc/ui2/flp?sap-client=600#Shell-home');
  assert.equal(by(rows, 'Edition').value, 'Public Cloud (launchpad reports not Public Cloud)');
  for (const [name, label] of Object.entries(SYSTEM_INFO_LABELS)) if (!HIDDEN_INFO_FIELDS.has(name)) assert.ok(by(rows, label), `row ${label} is always present`);
  assert.deepEqual(by(rows, 'Product version'), { section: 'About · System', label: 'Product version', value: 'SAP S/4HANA 2023 FPS02', source: 'scan' });
  assert.deepEqual(by(rows, 'Tenant role'), { section: 'About · System', label: 'Tenant role', value: null }, 'fields the launchpad did not report are null without a source');
  assert.deepEqual(by(rows, 'Version'), { section: 'About · Application', label: 'Version', value: null }, 'Application tab rows are always listed');
  assert.equal(by(rows, 'Product').value, 'SAP S/4HANA 2023 FPS02');
  assert.equal(by(rows, 'UI5 version').value, '1.108.4');
  assert.equal(by(rows, 'Last scanned').value, '2026-10-30T09:00:00Z');
  assert.equal(by(rows, 'Apps found').value, '412');

  const live = { system: { productVersion: 'SAP S/4HANA CLOUD 2508', productVersions: 'A · B', tenantRole: 'Quality', appVersion: '2025.0.23', appTitle: 'Home', transaction: 'SESSION_MANAGER', contentProviderLabel: 'Local', appIntent: 'Shell-home' }, ui5Version: '1.130.0' };
  const fresh = systemInfoRows({ system, meta, live });
  assert.deepEqual(by(fresh, 'Product version'), { section: 'About · System', label: 'Product version', value: 'SAP S/4HANA CLOUD 2508', source: 'live' });
  assert.deepEqual(by(fresh, 'Tenant role'), { section: 'About · System', label: 'Tenant role', value: 'Quality', source: 'live' });
  assert.deepEqual(by(fresh, 'Client'), { section: 'About · System', label: 'Client', value: '600', source: 'scan' }, 'a field missing live falls back to the scan');
  assert.equal(by(fresh, 'UI5 version').source, 'live');
  assert.deepEqual(by(fresh, 'Version'), { section: 'About · Application', label: 'Version', value: '2025.0.23', source: 'live' });
  assert.equal(by(fresh, 'Intent').value, 'Shell-home');
  assert.ok(!fresh.some((r) => ['Product name', 'System name', 'Installed products', 'Title', 'Transaction', 'Content provider'].includes(r.label)), 'hidden fields stay hidden even when the launchpad reports them');
  assert.equal(by(fresh, 'Product').value, 'SAP S/4HANA CLOUD 2508 · 2025.0.23', 'the product line carries the application version');
  assert.equal(by(fresh, 'Edition').value, 'Public Cloud', 'the live product version agrees with the configured edition');

  const unscanned = systemInfoRows({ system: { ...system, edition: 'onprem' } });
  assert.equal(by(unscanned, 'Edition').value, 'On-Premise');
  assert.equal(by(unscanned, 'Last scanned').value, null);
  assert.equal(by(unscanned, 'Apps found').value, null);
  assert.ok(unscanned.filter((r) => r.section === 'About').every((r) => r.value === null && !r.source));
  assert.deepEqual(systemInfoRows({ system: null }), []);
  assert.deepEqual(systemInfoRows(), []);
});
