// Typed storage layer. Storage areas are injectable so the pure parts run under `node --test`.
// Only chromeAreas() touches the chrome.* namespace, and only when called.
import { aliasesFromCsv, tcodesFromCsv } from './csv.js';
import { applyTcodeTable, applyAppMap } from './tcodes.js';
import { normalizeEntry, DEFAULT_LAUNCHPAD_PATH, EDITIONS } from './resolver.js';

export const SCHEMA_VERSION = 1;
export const SYNC_ITEM_BUDGET = 7000; // bytes; chrome.storage.sync QUOTA_BYTES_PER_ITEM is 8192 (key + value)
export const RECENT_LIMIT = 20;

export const KEYS = Object.freeze({
  // sync
  SCHEMA: 'schemaVersion',
  SYSTEMS: 'systems',
  USER_ALIASES: 'userAliases',
  HIDDEN: 'hiddenAliases',
  SETTINGS: 'settings',
  // local
  SEED: 'seedAliases',
  SEED_VERSION: 'seedVersion',
  IMPORTED: 'importedAliases',
  DISCOVERED: 'discovered',
  SCAN_META: 'scanMeta',
  RECENT: 'recent',
  LAST_SYSTEM: 'lastUsedSystemKey',
  // session
  PENDING_RESCAN: 'pendingRescan',
  REOPEN_LAUNCHER: 'reopenLauncher', // session: { host, ts } – reopen the launcher in the tab once that host's scan lands
  LAUNCHER_NONCE: 'launcherNonce', // session: the nonce the launcher page must present before it renders (see openLauncher)
});

export const DEFAULT_SETTINGS = Object.freeze({ suggestionLimit: 6, autoScanDays: 7, reuseTabOnSameHost: true, actionOnlyOnSap: true, copyUnresolved: false, overlayBlur: false });

/** Settings as stored or imported → the known keys only, each coerced and clamped; unknown keys are dropped. */
export function sanitizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const num = (v, lo, hi, dflt) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : dflt);
  const bool = (v, dflt) => (typeof v === 'boolean' ? v : dflt);
  return {
    suggestionLimit: num(r.suggestionLimit, 1, 10, DEFAULT_SETTINGS.suggestionLimit),
    autoScanDays: num(r.autoScanDays, 0, 365, DEFAULT_SETTINGS.autoScanDays),
    reuseTabOnSameHost: bool(r.reuseTabOnSameHost, DEFAULT_SETTINGS.reuseTabOnSameHost),
    actionOnlyOnSap: bool(r.actionOnlyOnSap, DEFAULT_SETTINGS.actionOnlyOnSap),
    copyUnresolved: bool(r.copyUnresolved, DEFAULT_SETTINGS.copyUnresolved),
    overlayBlur: bool(r.overlayBlur, DEFAULT_SETTINGS.overlayBlur),
  };
}

// ---------------------------------------------------------------- discovery payloads (from the page, or from an import file)

const INTENT_RE = /^[A-Za-z0-9_]+-[A-Za-z0-9_]+$/;
const MAX_DISCOVERED_ENTRIES = 5000;
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);

/** Entries reported by a scan (or read from a backup): intent-shaped rows only, every field bounded. */
export function sanitizeDiscoveredEntries(entries) {
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const e of entries.slice(0, MAX_DISCOVERED_ENTRIES)) {
    if (!e || typeof e.intent !== 'string') continue;
    const intent = e.intent.replace(/^#/, '').split('?')[0];
    if (!INTENT_RE.test(intent)) continue;
    const [semanticObject, action] = intent.split(/-(.*)/s);
    out.push({
      intent,
      semanticObject,
      action,
      title: str(e.title, 200) ?? intent,
      appId: str(e.appId, 40),
      paramKey: str(e.paramKey, 80),
    });
  }
  return out;
}

/**
 * One system's scan record as stored under discovered[host]: the page (or a backup file) supplies it, so every field
 * is bounded here. `methods` keeps scalar values under short keys only (what the scan reports: service, links, searchable, cdm).
 */
export function sanitizeDiscoveredRecord(rec) {
  const r = rec && typeof rec === 'object' ? rec : {};
  const methods = {};
  if (r.methods && typeof r.methods === 'object') {
    for (const [k, v] of Object.entries(r.methods).slice(0, 20)) {
      if (k.length > 40) continue;
      if (typeof v === 'string') methods[k] = v.slice(0, 200);
      else if (typeof v === 'number' || typeof v === 'boolean') methods[k] = v;
    }
  }
  return {
    scannedAt: str(r.scannedAt, 40) ?? new Date().toISOString(),
    ui5Version: str(r.ui5Version, 40),
    system: sanitizeSystemInfo(r.system),
    methods,
    errors: Array.isArray(r.errors) ? r.errors.slice(0, 20).map((x) => String(x).slice(0, 300)) : [],
    entries: sanitizeDiscoveredEntries(r.entries),
  };
}

/** scanMeta[host] as the options page and the resolver read it. */
export function sanitizeScanMeta(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const info = sanitizeSystemInfo(m.system);
  return {
    lastScanned: str(m.lastScanned, 40),
    appCount: Number.isFinite(Number(m.appCount)) ? Math.max(0, Math.round(Number(m.appCount))) : 0,
    system: info,
    detectedEdition: EDITIONS.includes(m.detectedEdition) ? m.detectedEdition : editionFromSystemInfo(info),
    ...(str(m.ui5Version, 40) ? { ui5Version: str(m.ui5Version, 40) } : {}),
  };
}

/** A map keyed by host (discovered, scanMeta): valid host keys only, each value through `each`. */
const sanitizeHostMap = (map, each) => {
  const out = {};
  if (!map || typeof map !== 'object') return out;
  for (const [host, v] of Object.entries(map)) if (HOST_RE.test(host) && v && typeof v === 'object') out[host] = each(v);
  return out;
};
export const ENVS = Object.freeze(['DEV', 'TST', 'PRD']);
export { EDITIONS };
export const EDITION_LABELS = Object.freeze({ public: 'Public Cloud', private: 'Private Cloud', onprem: 'On-Premise' });
/** Public Cloud is recognisable from the host; private cloud and on-premise are not, so default to on-premise and let the user switch. */
export function guessEdition(host) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
  return /\.s4hana\.cloud\.sap$|\.s4hana\.ondemand\.com$/.test(h) ? 'public' : 'onprem';
}
/** System tab of the launchpad's About dialog (sap.ushell.Container.getLogonSystem()). */
export const LOGON_INFO_FIELDS = Object.freeze(['productName', 'productVersion', 'productVersions', 'systemName', 'systemRole', 'tenantRole', 'client', 'clientRole']);
/** Fields that may legitimately be long (the installed-products list); everything else is capped at 120 characters. */
const LONG_INFO_FIELDS = new Set(['productVersions']);
/** Application tab (AppLifeCycle.getCurrentApplication().getInfo()): the running app's version carries the S/4HANA stack version, e.g. 2025.0.23. */
export const APP_INFO_FIELDS = Object.freeze(['appVersion', 'appTitle', 'appId', 'transaction', 'appIntent', 'appSupportInfo', 'technicalAppComponentId', 'appFrameworkId', 'appFrameworkVersion', 'contentProviderLabel']);
export const SYSTEM_INFO_FIELDS = Object.freeze([...LOGON_INFO_FIELDS, ...APP_INFO_FIELDS]);
/** The fields the launchpad's About dialog shows, as reported by discovery; strings only, bounded. */
export function sanitizeSystemInfo(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const k of SYSTEM_INFO_FIELDS) {
    const v = typeof raw[k] === 'number' ? String(raw[k]) : raw[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, LONG_INFO_FIELDS.has(k) ? 600 : 120);
  }
  // On-premise systems answer getProductVersion() with every installed product, one per line ("SAP SCREEN PERSONAS 3.0\r\nSAP S/4HANA 2025\r\n…").
  // Keep the product line as productVersion and the whole list as productVersions.
  const lines = splitProductLines(raw.productVersion);
  if (lines.length > 1) {
    out.productVersion = pickProductLine(lines);
    if (!out.productVersions) out.productVersions = lines.join(' · ').slice(0, 600);
  }
  return Object.keys(out).length ? out : null;
}

export const splitProductLines = (text) => String(text ?? '').split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);

/** The line that names the product itself: "SAP S/4HANA 2025" before "SAP FIORI FOR SAP S/4HANA 2025" or "SAP S/4HANA FOUNDATION 2025". */
export function pickProductLine(lines) {
  const list = Array.isArray(lines) ? lines : splitProductLines(lines);
  if (!list.length) return '';
  const s4 = (l) => /S\/?4\s?HANA/i.test(l);
  const secondary = (l) => /\b(FOUNDATION|FIORI|FES|FRONT-?END|UI FOR|ANALYTICS|PERSONAS|SMART BUSINESS|PLATFORM)\b/i.test(l);
  return list.find((l) => s4(l) && !secondary(l) && /^SAP S\/?4\s?HANA\b/i.test(l))
    ?? list.find((l) => s4(l) && !secondary(l))
    ?? list.find((l) => s4(l))
    ?? list[0];
}
/** One line like the About dialog's "Product version" plus the Application tab's version: "SAP S/4HANA 2025 · 2025.0.23". */
export function describeSystemInfo(info) {
  if (!info) return '';
  const v = info.productVersion || '';
  const n = info.productName || '';
  const product = v.toLowerCase().includes(n.toLowerCase()) ? v : [n, v].filter(Boolean).join(' ');
  const app = info.appVersion && !product.includes(info.appVersion) ? info.appVersion : '';
  return [product, app].filter(Boolean).join(' · ');
}
/**
 * Edition from the About dialog's product name/version. Conservative: Public Cloud needs "cloud" plus either "public"
 * or a YYMM release (2508); "private" wins over "cloud"; a year release (2023, 1909) or FPS/SP marks the classic
 * stack, which is private cloud or on-premise – the two cannot be told apart, so 'onprem' here means "not Public Cloud".
 */
export function editionFromSystemInfo(info) {
  const text = [info?.productName, info?.productVersion].filter((x) => typeof x === 'string').join(' ');
  if (!text) return null;
  if (/private/i.test(text)) return 'private';
  const yymm = /\b2\d(0[1-9]|1[0-2])\b/.test(text);
  if (/cloud/i.test(text)) return /public/i.test(text) || yymm ? 'public' : null;
  if (/S\/?4\s?HANA/i.test(text) && /\b(19|20)\d\d\b|\bFPS?\s?\d|\bSPS?\s?\d/i.test(text)) return 'onprem';
  return null;
}
export const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$/;
export const KEY_RE = /^[a-z0-9][a-z0-9_-]*$/i; // the key keeps the case it was typed in; matching is case-insensitive
export const ALIAS_RE = /^[a-z0-9][a-z0-9_./-]*$/;
export const DEFAULT_HOST_SUFFIX = '.s4hana.cloud.sap';
/** Hosts covered by the static manifest permissions; anything else needs a runtime grant + dynamic content scripts. */
export const isDefaultHost = (host) => String(host || '').toLowerCase().replace(/:\d+$/, '').endsWith(DEFAULT_HOST_SUFFIX);
/** Match pattern for a system's origin; Chrome accepts an explicit port and treats a port-less pattern as any port. */
export const originPattern = (hostOrSystem) => { const sys = typeof hostOrSystem === 'string' ? { host: hostOrSystem } : hostOrSystem; return `${sys.scheme === 'http' ? 'http' : 'https'}://${String(sys.host).toLowerCase()}/*`; };

/** parseLaunchpadUrl("https://acd.finteq.io/ui#Shell-home") → { host:'acd.finteq.io', launchpadPath:'/ui' } | null */
export function parseLaunchpadUrl(input) {
  let text = String(input ?? '').trim();
  if (!text) return null;
  if (!/^[a-z]+:\/\//i.test(text)) text = 'https://' + text;
  let u;
  try { u = new URL(text); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.host.toLowerCase(); // includes an explicit non-default port
  if (!HOST_RE.test(host) || !u.hostname.includes('.')) return null;
  let path = u.pathname.replace(/\/+$/, '');
  if (!path || path === '/') path = DEFAULT_LAUNCHPAD_PATH;
  // keep launchpad query parameters such as sap-client=600; drop empty ones
  const params = [...new URLSearchParams(u.search)].filter(([k]) => k);
  const launchpadQuery = new URLSearchParams(params).toString();
  return { scheme: u.protocol === 'http:' ? 'http' : 'https', host, launchpadPath: path, launchpadQuery };
}

/** Heuristic: does this URL look like an SAP Fiori launchpad? (SAP cloud hosts, FLP paths, intent-style hashes, sap-client) */
export function looksLikeLaunchpad(url) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (/\.s4hana\.cloud\.sap$|\.s4hana\.ondemand\.com$/i.test(u.hostname)) return true;
  if (/^\/sap\/bc\/ui2\/flp(\/|$)|^\/sap\/bc\/ui5_ui5\/ui2\/ushell\//i.test(u.pathname)) return true;
  if (/^\/ui\/?$/.test(u.pathname) && /^#[A-Za-z0-9_]+-[A-Za-z0-9_]+/.test(u.hash)) return true;
  if (u.searchParams.has('sap-client') && /^#[A-Za-z0-9_]+-[A-Za-z0-9_]+/.test(u.hash)) return true;
  return false;
}

function guessEnv(host) {
  const labels = host.split(/[.-]/);
  const first = labels[0] || '';
  if (/^(dev|develop|development|sbx|sandbox|d\d*)$/.test(first) || /(^|[.-])(dev|sandbox|sbx)([.-]|$)/.test(host)) return 'DEV';
  if (/^(prd|prod|production|p\d*)$/.test(first) || /(^|[.-])(prd|prod|production)([.-]|$)/.test(host)) return 'PRD';
  return 'TST';
}

/** Builds a system row from a pasted URL; key is the first host label, made unique against `existing`. */
export function systemFromUrl(input, existing = []) {
  const parsed = parseLaunchpadUrl(input);
  if (!parsed) return null;
  const { scheme, host, launchpadPath, launchpadQuery } = parsed;
  const labels = host.replace(/:\d+$/, '').split('.');
  const base = (labels[0] || 'sys').toLowerCase().replace(/[^a-z0-9_-]/g, '').replace(/^[^a-z0-9]+/, '') || 'sys';
  const keys = new Set((existing || []).map((s) => String(s.key).toLowerCase()));
  let key = base;
  for (let n = 2; keys.has(key); n++) key = `${base}${n}`;
  const customer = isDefaultHost(host) ? '' : (labels.length >= 3 ? labels[labels.length - 2] : '');
  return normalizeSystem({ key, name: host, customer, host, scheme, launchpadPath, launchpadQuery, env: guessEnv(host), isDefault: !(existing || []).some((s) => s.isDefault) });
}

// ---------------------------------------------------------------- pure helpers

export function byteSize(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Greedy JSON-size-aware split; an oversized single item still gets its own chunk. */
export function chunkArray(items, maxBytes = SYNC_ITEM_BUDGET) {
  const chunks = [];
  let current = [];
  let size = 2; // "[]"
  for (const item of items || []) {
    const s = byteSize(item) + 1;
    if (current.length && size + s > maxBytes) {
      chunks.push(current);
      current = [];
      size = 2;
    }
    current.push(item);
    size += s;
  }
  if (current.length || !chunks.length) chunks.push(current);
  return chunks;
}

export async function readChunked(area, key) {
  const metaKey = `${key}.meta`;
  const meta = (await area.get(metaKey))[metaKey];
  if (!meta || !Number.isInteger(meta.chunks)) {
    const legacy = (await area.get(key))[key];
    return Array.isArray(legacy) ? legacy : [];
  }
  const names = Array.from({ length: meta.chunks }, (_, i) => `${key}.${i}`);
  const got = names.length ? await area.get(names) : {};
  return names.flatMap((n) => (Array.isArray(got[n]) ? got[n] : []));
}

export async function writeChunked(area, key, items, maxBytes = SYNC_ITEM_BUDGET) {
  const metaKey = `${key}.meta`;
  const old = (await area.get(metaKey))[metaKey];
  const chunks = chunkArray(items, maxBytes);
  const obj = { [metaKey]: { chunks: chunks.length } };
  chunks.forEach((c, i) => { obj[`${key}.${i}`] = c; });
  await area.set(obj);
  const stale = [key];
  if (old && Number.isInteger(old.chunks)) for (let i = chunks.length; i < old.chunks; i++) stale.push(`${key}.${i}`);
  await area.remove(stale);
}

export function normalizeSystem(raw) {
  const r = raw || {};
  const env = String(r.env || 'TST').toUpperCase();
  const scheme = String(r.scheme || '').toLowerCase() === 'http' ? 'http' : 'https';
  // URL.host (tabs, content scripts) omits the default port, so the stored host must too or lookups never match.
  const host = String(r.host ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(scheme === 'http' ? /:80$/ : /:443$/, '');
  // A pasted "…/flp?sap-client=600#Shell-home" in the card editor must not leave "#Shell-home" in the path or query:
  // the generated URL would then carry two hashes and the shell rejects "Shell-home#Shell-startGUI?…" as unparsable.
  let launchpadPath = String(r.launchpadPath || '').trim().replace(/#.*$/, '');
  let launchpadQuery = String(r.launchpadQuery ?? '').trim().replace(/#.*$/, '').replace(/^\?/, '');
  const qInPath = launchpadPath.indexOf('?');
  if (qInPath >= 0) {
    const fromPath = launchpadPath.slice(qInPath + 1);
    launchpadPath = launchpadPath.slice(0, qInPath);
    launchpadQuery = [fromPath, launchpadQuery].filter(Boolean).join('&');
  }
  return {
    key: String(r.key ?? '').trim(),
    name: String(r.name ?? '').trim(),
    customer: String(r.customer ?? '').trim(),
    host,
    scheme,
    launchpadPath: launchpadPath || DEFAULT_LAUNCHPAD_PATH,
    launchpadQuery,
    env: ENVS.includes(env) ? env : 'TST',
    edition: EDITIONS.includes(String(r.edition || '').toLowerCase()) ? String(r.edition).toLowerCase() : guessEdition(r.host),
    isDefault: Boolean(r.isDefault),
  };
}

/** Returns [] when valid, else human-readable problems. */
export function validateSystems(systems) {
  const errors = [];
  const keys = new Set();
  let defaults = 0;
  (systems || []).forEach((s, i) => {
    const row = `row ${i + 1}`;
    if (!KEY_RE.test(s.key)) errors.push(`${row}: key must match ${KEY_RE}`);
    if (keys.has(s.key.toLowerCase())) errors.push(`${row}: duplicate key "${s.key}"`);
    keys.add(s.key.toLowerCase());
    if (!HOST_RE.test(s.host)) errors.push(`${row}: host must match ${HOST_RE}`);
    if (!s.launchpadPath.startsWith('/')) errors.push(`${row}: launchpadPath must start with /`);
    if (s.isDefault) defaults++;
  });
  if ((systems || []).length && defaults !== 1) errors.push(`exactly one system must be default (found ${defaults})`);
  return errors;
}

/** Idempotent migration of a { sync, local } snapshot to SCHEMA_VERSION. */
export function migrateSnapshot(snapshot) {
  const sync = { ...(snapshot?.sync || {}) };
  const local = { ...(snapshot?.local || {}) };
  // v0 → v1
  if (Array.isArray(sync[KEYS.SYSTEMS])) sync[KEYS.SYSTEMS] = sync[KEYS.SYSTEMS].map(normalizeSystem);
  if (Array.isArray(sync.aliases)) { // pre-overlay single table
    sync[KEYS.USER_ALIASES] = [...(sync[KEYS.USER_ALIASES] || []), ...sync.aliases.map((a) => ({ ...a, source: 'user' }))];
    delete sync.aliases;
  }
  if (Array.isArray(sync[KEYS.USER_ALIASES])) sync[KEYS.USER_ALIASES] = sync[KEYS.USER_ALIASES].map((a) => normalizeEntry({ ...a, source: 'user' }));
  sync[KEYS.HIDDEN] = Array.isArray(sync[KEYS.HIDDEN]) ? sync[KEYS.HIDDEN] : [];
  sync[KEYS.SETTINGS] = sanitizeSettings(sync[KEYS.SETTINGS]);
  sync[KEYS.SCHEMA] = SCHEMA_VERSION;
  local[KEYS.DISCOVERED] = sanitizeHostMap(local[KEYS.DISCOVERED], sanitizeDiscoveredRecord);
  local[KEYS.SCAN_META] = sanitizeHostMap(local[KEYS.SCAN_META], sanitizeScanMeta);
  local[KEYS.RECENT] = Array.isArray(local[KEYS.RECENT]) ? local[KEYS.RECENT].slice(0, RECENT_LIMIT) : [];
  local[KEYS.SCHEMA] = SCHEMA_VERSION;
  return { sync, local };
}

/** Build the seed alias list from the bundled CSV texts. */
export function buildSeedEntries({ aliasesCsv = '', libraryCsv = '', tcodesCsv = '', tcodeAppsJson = '' } = {}) {
  const errors = [];
  const empty = { entries: [], rows: [], errors: [] };
  const a = aliasesCsv.trim() ? aliasesFromCsv(aliasesCsv, { source: 'seed' }) : empty;
  const l = libraryCsv.trim() ? aliasesFromCsv(libraryCsv, { source: 'library' }) : empty;
  const t = tcodesCsv.trim() ? tcodesFromCsv(tcodesCsv) : empty;
  errors.push(...a.errors.map((e) => ({ file: 'aliases.csv', ...e })), ...l.errors.map((e) => ({ file: 'library.csv', ...e })), ...t.errors.map((e) => ({ file: 'tcodes.csv', ...e })));
  let appRows = [];
  if (String(tcodeAppsJson).trim()) {
    try {
      const parsed = JSON.parse(tcodeAppsJson);
      appRows = Array.isArray(parsed) ? parsed.filter((r) => r && typeof r === 'object' && r.tcode) : [];
    } catch (e) {
      errors.push({ file: 'tcode-apps.json', line: 0, message: `invalid JSON: ${e.message}` });
    }
  }
  const tabled = applyTcodeTable([...a.entries, ...l.entries].map(normalizeEntry), t.rows);
  const { entries: mapped, unmapped } = applyAppMap(tabled, appRows);
  for (const u of unmapped) errors.push({ file: 'tcode-apps.json', line: 0, message: `${u.tcode}: no library app for ${u.appId || 'no app ID'} / "${u.app}"`, info: true });
  return { entries: mapped.map(normalizeEntry), errors };
}

// ---------------------------------------------------------------- areas

export function memoryArea(initial = {}) {
  const data = { ...initial };
  const pickKeys = (keys) => (keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys));
  return {
    data,
    async get(keys) { const out = {}; for (const k of pickKeys(keys)) if (k in data) out[k] = structuredClone(data[k]); return out; },
    async set(obj) { for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v); },
    async remove(keys) { for (const k of pickKeys(keys)) delete data[k]; },
    async clear() { for (const k of Object.keys(data)) delete data[k]; },
  };
}

export function chromeAreas() {
  const wrap = (a) => ({
    get: (keys) => a.get(keys),
    set: (obj) => a.set(obj),
    remove: (keys) => a.remove(keys),
    clear: () => a.clear(),
  });
  return { sync: wrap(chrome.storage.sync), local: wrap(chrome.storage.local), session: wrap(chrome.storage.session) };
}

// ---------------------------------------------------------------- typed api

export function createStorage(areas = null) {
  const { sync, local, session } = areas || chromeAreas();
  const one = async (area, key, fallback) => { const v = (await area.get(key))[key]; return v === undefined ? fallback : v; };

  const api = {
    areas: { sync, local, session },

    // systems
    async getSystems() { return (await one(sync, KEYS.SYSTEMS, [])).map(normalizeSystem); },
    async setSystems(systems) {
      const list = (systems || []).map(normalizeSystem);
      const errors = validateSystems(list);
      if (errors.length) throw new Error(errors.join('; '));
      await sync.set({ [KEYS.SYSTEMS]: list });
      return list;
    },

    // aliases
    async getUserAliases() { return (await readChunked(sync, KEYS.USER_ALIASES)).map((a) => normalizeEntry({ ...a, source: 'user' })); },
    async setUserAliases(list) { await writeChunked(sync, KEYS.USER_ALIASES, (list || []).map((a) => normalizeEntry({ ...a, source: 'user' }))); },
    async getHiddenAliases() { return one(sync, KEYS.HIDDEN, []); },
    async setHiddenAliases(list) { await sync.set({ [KEYS.HIDDEN]: [...new Set((list || []).map((s) => String(s).toLowerCase()))] }); },
    async getSeedAliases() { return one(local, KEYS.SEED, []); },
    async setSeedAliases(list, version) { await local.set({ [KEYS.SEED]: list || [], [KEYS.SEED_VERSION]: version ?? null }); },
    async getSeedVersion() { return one(local, KEYS.SEED_VERSION, null); },
    async getImportedAliases() { return (await one(local, KEYS.IMPORTED, [])).map((a) => normalizeEntry({ ...a, source: 'import' })); },
    async setImportedAliases(list) { await local.set({ [KEYS.IMPORTED]: (list || []).map((a) => normalizeEntry({ ...a, source: 'import' })) }); },

    // discovery
    async getDiscovered(host) { const all = await one(local, KEYS.DISCOVERED, {}); return host ? all[host] ?? null : all; },
    async setDiscovered(host, record) {
      const all = await one(local, KEYS.DISCOVERED, {});
      all[host] = record;
      const meta = await one(local, KEYS.SCAN_META, {});
      // Edition comes from the About-dialog product version, never from the intents (Shell-startGUI exists on Public Cloud too).
      const info = sanitizeSystemInfo(record.system);
      meta[host] = { lastScanned: record.scannedAt, appCount: (record.entries || []).length, system: info, detectedEdition: editionFromSystemInfo(info), ...(record.ui5Version ? { ui5Version: record.ui5Version } : {}) };
      await local.set({ [KEYS.DISCOVERED]: all, [KEYS.SCAN_META]: meta });
    },
    /** Record About-dialog fields read live from a tab, without touching the discovered apps or the scan date. */
    async setScanSystemInfo(host, rawInfo, ui5Version = null) {
      const info = sanitizeSystemInfo(rawInfo);
      const meta = await one(local, KEYS.SCAN_META, {});
      const prev = meta[host] || { lastScanned: null, appCount: 0 };
      meta[host] = { ...prev, system: info, detectedEdition: editionFromSystemInfo(info), ...(ui5Version ? { ui5Version } : {}) };
      const all = await one(local, KEYS.DISCOVERED, {});
      if (all[host]) all[host] = { ...all[host], system: info, ...(ui5Version ? { ui5Version } : {}) };
      await local.set({ [KEYS.SCAN_META]: meta, ...(all[host] ? { [KEYS.DISCOVERED]: all } : {}) });
      return meta[host];
    },
    async clearDiscovered(host) {
      const all = await one(local, KEYS.DISCOVERED, {});
      const meta = await one(local, KEYS.SCAN_META, {});
      delete all[host]; delete meta[host];
      await local.set({ [KEYS.DISCOVERED]: all, [KEYS.SCAN_META]: meta });
    },
    async getScanMeta() { return one(local, KEYS.SCAN_META, {}); },

    // misc
    async getRecent() { return one(local, KEYS.RECENT, []); },
    async pushRecent(launch) {
      const list = [launch, ...(await one(local, KEYS.RECENT, []))].slice(0, RECENT_LIMIT);
      await local.set({ [KEYS.RECENT]: list });
    },
    async getLastUsedSystemKey() { return one(local, KEYS.LAST_SYSTEM, null); },
    async setLastUsedSystemKey(key) { await local.set({ [KEYS.LAST_SYSTEM]: key ?? null }); },
    async getSettings() { return { ...DEFAULT_SETTINGS, ...(await one(sync, KEYS.SETTINGS, {})) }; },
    async setSettings(patch) { const next = { ...(await api.getSettings()), ...(patch || {}) }; await sync.set({ [KEYS.SETTINGS]: next }); return next; },
    async getPendingRescan(host) { return Boolean((await one(session, KEYS.PENDING_RESCAN, {}))[host]); },
    async getReopenLauncher() { return (await one(session, KEYS.REOPEN_LAUNCHER, null)) || null; },
    async setReopenLauncher(host) { await session.set({ [KEYS.REOPEN_LAUNCHER]: host ? { host, ts: Date.now() } : null }); },
    async getLauncherNonce() { return (await one(session, KEYS.LAUNCHER_NONCE, null)) || null; },
    async setLauncherNonce(nonce) { await session.set({ [KEYS.LAUNCHER_NONCE]: nonce || null }); },
    async setPendingRescan(host, flag) {
      const all = await one(session, KEYS.PENDING_RESCAN, {});
      if (flag) all[host] = true; else delete all[host];
      await session.set({ [KEYS.PENDING_RESCAN]: all });
    },

    /** One read of everything the resolver needs. */
    async loadSnapshot() {
      const [systems, userAliases, hiddenAliases, seedAliases, importedAliases, discovered, scanMeta, lastUsedKey, settings, recent] = await Promise.all([
        api.getSystems(), api.getUserAliases(), api.getHiddenAliases(), api.getSeedAliases(), api.getImportedAliases(), api.getDiscovered(), api.getScanMeta(), api.getLastUsedSystemKey(), api.getSettings(), api.getRecent(),
      ]);
      return { systems, userAliases, hiddenAliases, seedAliases, importedAliases, discovered, scanMeta, lastUsedKey, settings, recent };
    },

    async migrate() {
      const [s, l] = await Promise.all([sync.get(null), local.get(null)]);
      const sv = s[KEYS.SCHEMA] ?? 0;
      const lv = l[KEYS.SCHEMA] ?? 0;
      if (sv >= SCHEMA_VERSION && lv >= SCHEMA_VERSION) return false;
      // userAliases may be chunked already; migrate through the flat form
      const flatUser = await readChunked(sync, KEYS.USER_ALIASES);
      const migrated = migrateSnapshot({ sync: { ...s, [KEYS.USER_ALIASES]: flatUser }, local: l });
      const user = migrated.sync[KEYS.USER_ALIASES] || [];
      delete migrated.sync[KEYS.USER_ALIASES];
      for (const k of Object.keys(migrated.sync)) if (k.startsWith(`${KEYS.USER_ALIASES}.`)) delete migrated.sync[k];
      await sync.set(migrated.sync);
      await writeChunked(sync, KEYS.USER_ALIASES, user);
      await local.set(migrated.local);
      return true;
    },

    /** Loads the bundled seed when the bundled version differs from the stored one (or when forced). */
    async applySeed({ aliasesCsv, libraryCsv, tcodesCsv, tcodeAppsJson, version, force = false }) {
      if (!force && (await api.getSeedVersion()) === version) return { applied: false, count: (await api.getSeedAliases()).length, errors: [] };
      const { entries, errors } = buildSeedEntries({ aliasesCsv, libraryCsv, tcodesCsv, tcodeAppsJson });
      await api.setSeedAliases(entries, version);
      return { applied: true, count: entries.length, errors };
    },

    async exportJson({ includeDiscovered = false } = {}) {
      const snap = await api.loadSnapshot();
      const out = {
        format: 'slashn-config',
        schemaVersion: SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        systems: snap.systems,
        userAliases: snap.userAliases,
        hiddenAliases: snap.hiddenAliases,
        settings: snap.settings,
        lastUsedSystemKey: snap.lastUsedKey,
      };
      if (includeDiscovered) { out.discovered = snap.discovered; out.scanMeta = snap.scanMeta; }
      return out;
    },

    async importJson(obj, { replace = true } = {}) {
      if (!obj || obj.format !== 'slashn-config') throw new Error('Not a slashn config export');
      const migrated = migrateSnapshot({
        sync: { [KEYS.SYSTEMS]: obj.systems || [], [KEYS.USER_ALIASES]: obj.userAliases || [], [KEYS.HIDDEN]: obj.hiddenAliases || [], [KEYS.SETTINGS]: obj.settings || {} },
        local: { [KEYS.DISCOVERED]: obj.discovered, [KEYS.SCAN_META]: obj.scanMeta, [KEYS.RECENT]: [] },
      });
      const systems = replace ? migrated.sync[KEYS.SYSTEMS] : mergeBy([...(await api.getSystems()), ...migrated.sync[KEYS.SYSTEMS]], (s) => s.key);
      const user = replace ? migrated.sync[KEYS.USER_ALIASES] : mergeBy([...(await api.getUserAliases()), ...migrated.sync[KEYS.USER_ALIASES]], (a) => a.alias);
      const hidden = replace ? migrated.sync[KEYS.HIDDEN] : [...new Set([...(await api.getHiddenAliases()), ...migrated.sync[KEYS.HIDDEN]])];
      await api.setSystems(systems);
      await api.setUserAliases(user);
      await api.setHiddenAliases(hidden);
      await api.setSettings(migrated.sync[KEYS.SETTINGS]);
      if (obj.lastUsedSystemKey) await api.setLastUsedSystemKey(obj.lastUsedSystemKey);
      if (obj.discovered && replace) await local.set({ [KEYS.DISCOVERED]: migrated.local[KEYS.DISCOVERED], [KEYS.SCAN_META]: migrated.local[KEYS.SCAN_META] });
      return { systems: systems.length, userAliases: user.length };
    },
  };
  return api;
}

/** Later items win. */
function mergeBy(items, keyFn) {
  const m = new Map();
  for (const it of items) m.set(keyFn(it), it);
  return [...m.values()];
}
