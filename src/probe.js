// slashn — reading the launchpad's "About" fields from a live tab, and shaping them for the system-info dialog.
// readLogonSystemInPage is serialised into the page by chrome.scripting.executeScript, so it must not reference
// anything outside its own body. Everything else here is plain data shaping; probeTab is the only chrome.* caller.
import { sanitizeSystemInfo, describeSystemInfo, editionFromSystemInfo, EDITION_LABELS, LOGON_INFO_FIELDS, APP_INFO_FIELDS } from './storage.js';
import { homeUrl } from './resolver.js';

/**
 * Runs inside the page (MAIN world). The same sources the launchpad's About dialog prints:
 * System tab = sap.ushell.Container.getLogonSystem() getters; Application tab = AppLifeCycle.getCurrentApplication().getInfo().
 * Keep in sync with readSystemInfo in src/content-main.js, which cannot import this module.
 */
export function readLogonSystemInPage() {
  const c = window.sap && window.sap.ushell && window.sap.ushell.Container;
  if (!c) return { launchpad: false, system: null, ui5Version: null };
  const out = {};
  try {
    const sys = c.getLogonSystem && c.getLogonSystem();
    const getters = [['productName', 'getProductName'], ['productVersion', 'getProductVersion'], ['systemName', 'getSystemName'], ['systemRole', 'getSystemRole'], ['tenantRole', 'getTenantRole'], ['client', 'getClient'], ['clientRole', 'getClientRole']];
    for (let i = 0; i < getters.length; i++) {
      try {
        const v = sys && typeof sys[getters[i][1]] === 'function' ? sys[getters[i][1]]() : undefined;
        if (typeof v === 'string' || typeof v === 'number') out[getters[i][0]] = String(v);
      } catch (e) { /* optional getter */ }
    }
  } catch (e) { /* no logon system */ }
  let ui5Version = null;
  try { ui5Version = typeof window.sap.ui.version === 'string' ? window.sap.ui.version : null; } catch (e) { ui5Version = null; }
  const merge = (info) => {
    for (const k in info || {}) {
      const raw = info[k];
      const v = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw; // some releases wrap values as { value, label }
      if (((typeof v === 'string' && v.trim()) || typeof v === 'number') && !(k in out)) out[k] = String(v).trim(); // the System tab's values win
    }
  };
  const done = () => ({ launchpad: true, system: out, ui5Version });
  if (typeof c.getServiceAsync !== 'function') return done();
  const keys = ['appVersion', 'appTitle', 'appId', 'transaction', 'appIntent', 'appSupportInfo', 'technicalAppComponentId', 'appFrameworkId', 'appFrameworkVersion', 'contentProviderLabel', 'productName', 'productVersion'];
  // The About dialog's Application section is getAllAppInfo(); getInfo(keys) is the older entry point; the running component's
  // manifest is where the shell itself takes appVersion from (/sap.app/applicationVersion/version).
  const read = c.getServiceAsync('AppLifeCycle').then(async (svc) => {
    const app = svc && typeof svc.getCurrentApplication === 'function' ? svc.getCurrentApplication() : null;
    if (!app) return;
    if (typeof app.getAllAppInfo === 'function') {
      try { merge(await app.getAllAppInfo(true)); } catch (e) { /* next source */ }
      try { merge(await app.getAllAppInfo(false)); } catch (e) { /* next source */ }
    }
    if (typeof app.getInfo === 'function' && !out.appVersion) {
      try { merge(await app.getInfo(keys)); } catch (e) { /* next source */ }
    }
    if (!out.appVersion) {
      try {
        const comp = app.componentInstance;
        const v = comp && typeof comp.getManifestEntry === 'function' ? comp.getManifestEntry('/sap.app/applicationVersion/version') : null;
        if (typeof v === 'string' && v) out.appVersion = v;
      } catch (e) { /* no component */ }
    }
  });
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 3000));
  return Promise.race([read, timeout]).then(done, done);
}

/** { launchpad, system, ui5Version } for a tab, or launchpad:false when the page is not a launchpad or cannot be scripted. */
export async function probeTab(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: readLogonSystemInPage });
    const res = r?.result || {};
    return { launchpad: Boolean(res.launchpad), system: sanitizeSystemInfo(res.system), ui5Version: typeof res.ui5Version === 'string' ? res.ui5Version : null };
  } catch {
    return { launchpad: false, system: null, ui5Version: null };
  }
}

export const SYSTEM_INFO_LABELS = Object.freeze({
  productName: 'Product name',
  productVersion: 'Product version',
  productVersions: 'Installed products',
  systemName: 'System name',
  systemRole: 'System role',
  tenantRole: 'Tenant role',
  client: 'Client',
  clientRole: 'Client role',
  appVersion: 'Version',
  appTitle: 'Title',
  appId: 'Application ID',
  transaction: 'Transaction',
  appIntent: 'Intent',
  appSupportInfo: 'Support component',
  technicalAppComponentId: 'Technical component',
  appFrameworkId: 'Framework',
  appFrameworkVersion: 'Framework version',
  contentProviderLabel: 'Content provider',
});

/** Client category from T000-CCCATEGORY (SCC4), which the launchpad passes through getClientRole() as the bare letter. */
export const CLIENT_ROLES = Object.freeze({ P: 'Production', T: 'Test', C: 'Customizing', D: 'Demo', E: 'Training / Education', S: 'SAP reference' });

/** "D" → "D · Demo"; anything the domain does not define (or a role already spelled out) is shown as is. */
export function describeClientRole(code) {
  const c = String(code ?? '').trim();
  const text = CLIENT_ROLES[c.toUpperCase()];
  return c.length === 1 && text ? `${c.toUpperCase()} · ${text}` : c || null;
}

/** Fields the dialog does not list: still read and stored (the product list feeds edition detection), but noise on the card. */
export const HIDDEN_INFO_FIELDS = Object.freeze(new Set(['productName', 'productVersions', 'systemName', 'appTitle', 'transaction', 'contentProviderLabel']));

/**
 * Rows for the system-info dialog: [{ section, label, value, source? }].
 * `meta` is scanMeta[host]; `live` is a fresh probeTab() result and takes precedence over the scan, row by row.
 */
export function systemInfoRows({ system, meta = null, live = null } = {}) {
  if (!system) return [];
  const rows = [];
  const add = (section, label, value, source) => rows.push({ section, label, value: value == null || value === '' ? null : String(value), ...(source ? { source } : {}) });
  add('System', 'Key', system.key);
  add('System', 'Name', system.name);
  add('System', 'Customer', system.customer);
  add('System', 'Environment', system.env);
  const detected = live?.system ? editionFromSystemInfo(live.system) : meta?.detectedEdition || null;
  const editionLabel = EDITION_LABELS[system.edition] || system.edition;
  const conflict = detected && (detected === 'public') !== (system.edition === 'public');
  add('System', 'Edition', conflict ? `${editionLabel} (launchpad reports ${detected === 'public' ? 'Public Cloud' : 'not Public Cloud'})` : editionLabel);
  add('System', 'Launchpad', homeUrl(system));
  const scanInfo = meta?.system || null;
  const liveInfo = live?.system || null;
  const field = (section, name) => {
    if (HIDDEN_INFO_FIELDS.has(name)) return;
    const fromLive = liveInfo?.[name];
    const fromScan = scanInfo?.[name];
    const raw = fromLive ?? fromScan ?? null;
    add(section, SYSTEM_INFO_LABELS[name], name === 'clientRole' ? describeClientRole(raw) : raw, fromLive != null ? 'live' : fromScan != null ? 'scan' : undefined);
  };
  for (const name of LOGON_INFO_FIELDS) field('About · System', name);
  add('About · System', 'Product', describeSystemInfo(liveInfo || scanInfo), liveInfo ? 'live' : scanInfo ? 'scan' : undefined);
  add('About · System', 'UI5 version', live?.ui5Version ?? meta?.ui5Version ?? null, live?.ui5Version ? 'live' : meta?.ui5Version ? 'scan' : undefined);
  // the Application tab describes whichever app was running when the fields were read; on S/4HANA its version is the stack version
  for (const name of APP_INFO_FIELDS) field('About · Application', name);
  add('Scan', 'Last scanned', meta?.lastScanned || null);
  add('Scan', 'Apps found', meta?.lastScanned ? meta.appCount ?? 0 : null);
  return rows;
}
