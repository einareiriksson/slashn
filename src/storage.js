// Typed storage layer. Storage areas are injectable so the pure parts run under `node --test`.
// Only chromeAreas() touches the chrome.* namespace, and only when called.
import { aliasesFromCsv, tcodesFromCsv } from './csv.js';
import { applyTcodeTable } from './tcodes.js';
import { normalizeEntry, DEFAULT_LAUNCHPAD_PATH } from './resolver.js';

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
  DISCOVERED: 'discovered',
  SCAN_META: 'scanMeta',
  RECENT: 'recent',
  LAST_SYSTEM: 'lastUsedSystemKey',
  // session
  PENDING_RESCAN: 'pendingRescan',
});

export const DEFAULT_SETTINGS = Object.freeze({ suggestionLimit: 6, autoScanDays: 7, reuseTabOnSameHost: true });
export const ENVS = Object.freeze(['DEV', 'TST', 'PRD']);
export const HOST_RE = /^[a-z0-9.-]+$/;
export const KEY_RE = /^[a-z0-9][a-z0-9_-]*$/;
export const ALIAS_RE = /^[a-z0-9][a-z0-9_./-]*$/;

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
  return {
    key: String(r.key ?? '').trim().toLowerCase(),
    name: String(r.name ?? '').trim(),
    customer: String(r.customer ?? '').trim(),
    host: String(r.host ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
    launchpadPath: String(r.launchpadPath || DEFAULT_LAUNCHPAD_PATH).trim() || DEFAULT_LAUNCHPAD_PATH,
    env: ENVS.includes(env) ? env : 'TST',
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
    if (keys.has(s.key)) errors.push(`${row}: duplicate key "${s.key}"`);
    keys.add(s.key);
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
  sync[KEYS.SETTINGS] = { ...DEFAULT_SETTINGS, ...(sync[KEYS.SETTINGS] || {}) };
  sync[KEYS.SCHEMA] = SCHEMA_VERSION;
  local[KEYS.DISCOVERED] = local[KEYS.DISCOVERED] && typeof local[KEYS.DISCOVERED] === 'object' ? local[KEYS.DISCOVERED] : {};
  local[KEYS.SCAN_META] = local[KEYS.SCAN_META] && typeof local[KEYS.SCAN_META] === 'object' ? local[KEYS.SCAN_META] : {};
  local[KEYS.RECENT] = Array.isArray(local[KEYS.RECENT]) ? local[KEYS.RECENT].slice(0, RECENT_LIMIT) : [];
  local[KEYS.SCHEMA] = SCHEMA_VERSION;
  return { sync, local };
}

/** Build the seed alias list from the bundled CSV texts. */
export function buildSeedEntries({ aliasesCsv = '', libraryCsv = '', tcodesCsv = '' } = {}) {
  const errors = [];
  const a = aliasesFromCsv(aliasesCsv, { source: 'seed' });
  const l = aliasesFromCsv(libraryCsv, { source: 'library' });
  const t = tcodesFromCsv(tcodesCsv);
  errors.push(...a.errors.map((e) => ({ file: 'aliases.csv', ...e })), ...l.errors.map((e) => ({ file: 'library.csv', ...e })), ...t.errors.map((e) => ({ file: 'tcodes.csv', ...e })));
  const entries = applyTcodeTable([...a.entries, ...l.entries].map(normalizeEntry), t.rows).map(normalizeEntry);
  return { entries, errors };
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

    // discovery
    async getDiscovered(host) { const all = await one(local, KEYS.DISCOVERED, {}); return host ? all[host] ?? null : all; },
    async setDiscovered(host, record) {
      const all = await one(local, KEYS.DISCOVERED, {});
      all[host] = record;
      const meta = await one(local, KEYS.SCAN_META, {});
      meta[host] = { lastScanned: record.scannedAt, appCount: (record.entries || []).length };
      await local.set({ [KEYS.DISCOVERED]: all, [KEYS.SCAN_META]: meta });
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
    async setPendingRescan(host, flag) {
      const all = await one(session, KEYS.PENDING_RESCAN, {});
      if (flag) all[host] = true; else delete all[host];
      await session.set({ [KEYS.PENDING_RESCAN]: all });
    },

    /** One read of everything the resolver needs. */
    async loadSnapshot() {
      const [systems, userAliases, hiddenAliases, seedAliases, discovered, scanMeta, lastUsedKey, settings] = await Promise.all([
        api.getSystems(), api.getUserAliases(), api.getHiddenAliases(), api.getSeedAliases(), api.getDiscovered(), api.getScanMeta(), api.getLastUsedSystemKey(), api.getSettings(),
      ]);
      return { systems, userAliases, hiddenAliases, seedAliases, discovered, scanMeta, lastUsedKey, settings };
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
    async applySeed({ aliasesCsv, libraryCsv, tcodesCsv, version, force = false }) {
      if (!force && (await api.getSeedVersion()) === version) return { applied: false, count: (await api.getSeedAliases()).length, errors: [] };
      const { entries, errors } = buildSeedEntries({ aliasesCsv, libraryCsv, tcodesCsv });
      await api.setSeedAliases(entries, version);
      return { applied: true, count: entries.length, errors };
    },

    async exportJson({ includeDiscovered = false } = {}) {
      const snap = await api.loadSnapshot();
      const out = {
        format: 'sap-quickstart-config',
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
      if (!obj || obj.format !== 'sap-quickstart-config') throw new Error('Not a SAP QuickStart config export');
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
