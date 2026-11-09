// slashn — embedding API for hosts without chrome.* (the macOS app runs it inside JavaScriptCore).
// Pure and synchronous: no storage, no timers, no URL()/TextEncoder. The host keeps the configuration (the same
// `slashn-config` shape the extension exports, plus `recent`) and hands it over with setConfig(); this module ranks and
// resolves against it. `json` wraps every function so a host can pass and receive JSON strings only.
import {
  parseInput, mergeEntries, buildIndex, rank, buildUrl, homeUrl, appFinderUrl, formatSuggestion, formatDefaultDescription,
  tcodeLike, MATCH, GUI_INTENT, GUI_TCODE_PARAM,
} from './resolver.js';
import { makeGuesser } from './tcodes.js';
import {
  buildSeedEntries, migrateSnapshot, normalizeSystem, validateSystems, systemFromParts, sanitizeSettings, KEYS, RECENT_LIMIT, SCHEMA_VERSION,
} from './storage.js';

export const CORE_VERSION = '1.1.0'; // kept equal to package.json by test/embed.test.mjs

const guesser = makeGuesser();
const SOURCE_FILTERS = Object.freeze({ mine: ['user', 'import'], discovered: ['discovered'], seed: ['seed'], library: ['library'] });
const lc = (v) => String(v ?? '').trim().toLowerCase();
const plainText = (s) => String(s).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const state = { seed: [], seedErrors: [], config: emptyConfig(), index: new Map() };

function emptyConfig() {
  return {
    format: 'slashn-config', schemaVersion: SCHEMA_VERSION, systems: [], userAliases: [], hiddenAliases: [], settings: sanitizeSettings({}),
    lastUsedSystemKey: null, discovered: {}, scanMeta: {}, recent: [],
  };
}

/** Any `slashn-config`-shaped object (an extension export, the app's config file) → normalised, every field present. */
export function normalizeConfig(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const m = migrateSnapshot({
    sync: { [KEYS.SYSTEMS]: Array.isArray(o.systems) ? o.systems : [], [KEYS.USER_ALIASES]: Array.isArray(o.userAliases) ? o.userAliases : [], [KEYS.HIDDEN]: o.hiddenAliases, [KEYS.SETTINGS]: o.settings },
    local: { [KEYS.DISCOVERED]: o.discovered, [KEYS.SCAN_META]: o.scanMeta, [KEYS.RECENT]: o.recent },
  });
  return {
    format: 'slashn-config',
    schemaVersion: SCHEMA_VERSION,
    systems: m.sync[KEYS.SYSTEMS],
    userAliases: m.sync[KEYS.USER_ALIASES],
    hiddenAliases: m.sync[KEYS.HIDDEN],
    settings: m.sync[KEYS.SETTINGS],
    lastUsedSystemKey: typeof o.lastUsedSystemKey === 'string' && o.lastUsedSystemKey ? o.lastUsedSystemKey : null,
    discovered: m.local[KEYS.DISCOVERED],
    scanMeta: m.local[KEYS.SCAN_META],
    recent: m.local[KEYS.RECENT].filter((r) => r && typeof r === 'object'),
  };
}

// ---------------------------------------------------------------- lifecycle

/** Load the bundled seed files (as text) and the configuration. Returns counts and the seed problems worth logging. */
export function init(seedTexts, config) {
  const { entries, errors } = buildSeedEntries(seedTexts || {});
  state.seed = entries;
  state.seedErrors = errors.filter((e) => !e.info);
  const { errors: configErrors } = setConfig(config);
  return { coreVersion: CORE_VERSION, entryCount: entries.length, seedErrors: state.seedErrors, configErrors };
}

/** Replace the configuration; the per-system indexes are rebuilt lazily. Returns the normalised config and validation problems. */
export function setConfig(config) {
  state.config = normalizeConfig(config);
  state.index.clear();
  return { config: state.config, errors: validateSystems(state.config.systems) };
}

export function getConfig() {
  return state.config;
}

/** Tests only. */
export function reset() {
  state.seed = [];
  state.seedErrors = [];
  state.config = emptyConfig();
  state.index.clear();
}

export const version = () => ({ slashn: CORE_VERSION, schemaVersion: SCHEMA_VERSION });

// ---------------------------------------------------------------- ranking inputs

function indexFor(system) {
  const cfg = state.config;
  if (!state.index.has(system.key)) {
    const entries = mergeEntries({
      user: cfg.userAliases,
      seed: state.seed,
      hidden: cfg.hiddenAliases,
      discovered: system.host ? cfg.discovered?.[system.host]?.entries || [] : [],
      edition: system.edition || null,
    });
    state.index.set(system.key, buildIndex(entries));
  }
  return state.index.get(system.key);
}

/** Classic transactions are offered off Public Cloud, and always where the host can open SAP GUI itself. */
function guiFor(system) {
  const entries = system.host ? state.config.discovered?.[system.host]?.entries || [] : [];
  let available = entries.length ? entries.some((e) => /^shell-startgui$/i.test(String(e.intent || ''))) : null;
  if (system.gui && available === false) available = null; // the WebGUI runtime may be missing; SAP GUI for Java is not
  return { enabled: (system.edition || 'onprem') !== 'public' || Boolean(system.gui), available };
}

function recentIntentsFor(system) {
  return (state.config.recent || []).filter((r) => r.systemKey === system.key && r.intent && !/^Shell-/i.test(r.intent)).map((r) => r.intent);
}

const systemSummary = (s) => (s ? {
  key: s.key, name: s.name, host: s.host, env: s.env, edition: s.edition, isDefault: Boolean(s.isDefault),
  launchpad: s.launchpad !== false, gui: Boolean(s.gui), browserBundleId: s.browserBundleId || null,
} : null);

/** The transaction code a SAP GUI launch of this match would start, or null. */
function tcodeFor(match, parsed) {
  const e = match.entry;
  if (match.type === MATCH.TCODE || e.tcodes.includes(parsed.head)) return parsed.head; // the code the user typed, also when it matched as an alias
  if (match.type === MATCH.GUI) return e.tcodes[0] || null;
  if (lc(e.intent) === lc(GUI_INTENT)) return lc(e.fixedParams?.[GUI_TCODE_PARAM]) || e.tcodes[0] || null;
  return e.tcodes[0] || null;
}

const urlFor = (system, entry, param) => (system.launchpad === false ? null : buildUrl(system, entry, param));

function describeMatch(m, parsed) {
  const system = parsed.system;
  const e = m.entry;
  return {
    content: formatSuggestion(m, system).content,
    alias: e.alias ?? e.intent,
    title: e.title,
    intent: e.intent,
    appId: e.appId || null,
    tcodes: e.tcodes || [],
    source: e.source || null, // user | import | discovered | seed | library | gui
    matchType: m.type, // alias | tcode | appId | intent | tcodeGuess | keyPrefix | titlePrefix | titleFuzzy | gui
    param: m.param,
    systemKey: system.key,
    guess: m.type === MATCH.TCODE_GUESS || e.confidence === 'low',
    gui: m.type === MATCH.GUI || lc(e.intent) === lc(GUI_INTENT),
    onTenant: e.onTarget === true,
    missing: e.onTarget === false,
    url: urlFor(system, e, m.param),
    tcode: tcodeFor(m, parsed),
  };
}

// ---------------------------------------------------------------- suggest / resolve

/**
 * Rows for the launcher list as the user types. Mirrors the extension's resolveForPopup, plus `url` and `tcode` per row so
 * the host can open either target without a second call.
 */
export function suggest(text, { limit = 8, preferredKey = null, availableOnly = false, source = 'all' } = {}) {
  const cfg = state.config;
  const parsed = parseInput(text, cfg.systems, { lastUsedKey: cfg.lastUsedSystemKey, preferredKey });
  const system = systemSummary(parsed.system);
  if (parsed.kind === 'systems') {
    return {
      kind: 'systems', system, hint: 'Pick a system',
      matches: cfg.systems.map((s) => ({ content: s.key, alias: s.key, title: s.name || s.host || s.key, intent: '', systemKey: s.key, tag: [s.env, s.host || 'SAP GUI'].join(' · ') })),
    };
  }
  if (!system || parsed.kind !== 'query') return { kind: parsed.kind, system, hint: plainText(formatDefaultDescription(parsed)), matches: [] };
  const scannedAt = parsed.system.host ? cfg.scanMeta?.[parsed.system.host]?.lastScanned || null : null;
  const filtered = Boolean(availableOnly && scannedAt);
  const sources = SOURCE_FILTERS[source] || null;
  const matches = rank(parsed, indexFor(parsed.system), { limit, guesser, gui: guiFor(parsed.system), availableOnly: filtered, sources, recentIntents: recentIntentsFor(parsed.system) });
  const notice = availableOnly && !scannedAt ? `${parsed.system.key} has not been scanned yet – showing all apps`
    : filtered && !matches.length ? `No app found in the last scan of ${parsed.system.key} – turn the filter off to see everything`
    : sources && !matches.length ? `Nothing from "${source}" matches – set the source to all`
    : null;
  return {
    kind: 'query',
    system,
    hint: notice || plainText(formatDefaultDescription(parsed, matches[0] ?? null)),
    hintKind: notice ? 'notice' : 'default',
    terms: { head: parsed.head, query: parsed.query },
    filtered,
    source: sources ? source : 'all',
    matches: matches.map((m) => describeMatch(m, parsed)),
    scannedAt,
  };
}

/**
 * What Enter does for `text`: { kind: 'none' | 'systems' | 'home' | 'appfinder' | 'open', system, url, tcode, ... }.
 * `url` is null on a system without a launchpad; `tcode` is the transaction a SAP GUI launch would start, when known.
 */
export function resolve(text, { preferredKey = null } = {}) {
  const cfg = state.config;
  const parsed = parseInput(text, cfg.systems, { lastUsedKey: cfg.lastUsedSystemKey, preferredKey });
  const system = systemSummary(parsed.system);
  if (!parsed.system) return { kind: 'none', system: null, hint: plainText(formatDefaultDescription(parsed)), url: null, tcode: null };
  if (parsed.kind === 'systems') return { kind: 'systems', system, url: null, tcode: null };
  if (parsed.kind !== 'query') return { kind: 'home', system, url: parsed.system.launchpad === false ? null : homeUrl(parsed.system), tcode: null };
  const top = rank(parsed, indexFor(parsed.system), { limit: 1, guesser, gui: guiFor(parsed.system), recentIntents: recentIntentsFor(parsed.system) })[0];
  if (!top) {
    const shape = tcodeLike(parsed.head);
    return {
      kind: 'appfinder', system, query: parsed.query, head: parsed.head,
      url: parsed.system.launchpad === false ? null : appFinderUrl(parsed.system),
      tcode: shape && !parsed.rest.length ? parsed.head : null, // "zmm01": nothing known, but it may still be a transaction
    };
  }
  const entry = describeMatch(top, parsed);
  return { kind: 'open', system, entry, param: top.param, matchType: top.type, url: entry.url, tcode: entry.tcode };
}

// ---------------------------------------------------------------- launches, systems, import

/** Remember a launch (most recent first, RECENT_LIMIT kept) and the system used. Returns what the host should persist. */
export function recordLaunch(launch) {
  const l = launch && typeof launch === 'object' ? launch : {};
  const cfg = state.config;
  cfg.recent = [{ ts: Number.isFinite(l.ts) ? l.ts : Date.now(), ...l }, ...(cfg.recent || [])].slice(0, RECENT_LIMIT);
  if (l.systemKey) cfg.lastUsedSystemKey = String(l.systemKey);
  return { recent: cfg.recent, lastUsedSystemKey: cfg.lastUsedSystemKey };
}

export { normalizeSystem, validateSystems, systemFromParts };

/**
 * Merge an extension export (or another config file) into the current configuration, as the extension's importJson does:
 * replace, or merge systems by key and aliases by alias (incoming wins) and union the hidden list. Scan data is taken per
 * host from the incoming file in both modes. Throws on anything that is not a slashn-config export.
 */
export function importConfig(current, incoming, { replace = true } = {}) {
  if (!incoming || incoming.format !== 'slashn-config') throw new Error('Not a slashn config export');
  const cur = normalizeConfig(current);
  const inc = normalizeConfig(incoming);
  const mergeBy = (items, keyFn) => { const m = new Map(); for (const it of items) m.set(keyFn(it), it); return [...m.values()]; };
  return normalizeConfig({
    systems: replace ? inc.systems : mergeBy([...cur.systems, ...inc.systems], (s) => lc(s.key)),
    userAliases: replace ? inc.userAliases : mergeBy([...cur.userAliases, ...inc.userAliases], (a) => a.alias ?? `#${lc(a.intent)}`),
    hiddenAliases: replace ? inc.hiddenAliases : [...new Set([...cur.hiddenAliases, ...inc.hiddenAliases])],
    settings: inc.settings,
    lastUsedSystemKey: inc.lastUsedSystemKey ?? cur.lastUsedSystemKey,
    discovered: replace ? inc.discovered : { ...cur.discovered, ...inc.discovered },
    scanMeta: replace ? inc.scanMeta : { ...cur.scanMeta, ...inc.scanMeta },
    recent: replace ? [] : cur.recent,
  });
}

// ---------------------------------------------------------------- JSON facade

const api = { init, setConfig, getConfig, reset, version, suggest, resolve, recordLaunch, normalizeSystem, validateSystems, systemFromParts, normalizeConfig, importConfig };

const parseArg = (a) => (typeof a === 'string' ? JSON.parse(a) : a);

/** Every function above taking JSON strings (or plain values) and returning a JSON string; `null` for undefined results. */
export const json = Object.fromEntries(Object.entries(api).map(([name, fn]) => [name, (...args) => JSON.stringify(fn(...args.map(parseArg)) ?? null)]));
