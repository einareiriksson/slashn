// slashn — resolver. Pure module: no imports, no chrome.* access.
// Parses omnibox input, merges alias tiers, ranks candidates, builds URLs and
// formats omnibox suggestions. Everything here is covered by test/resolver.test.mjs.

export const MATCH = Object.freeze({
  ALIAS: 'alias',
  TCODE: 'tcode',
  APP_ID: 'appId',
  INTENT: 'intent',
  TCODE_GUESS: 'tcodeGuess',
  KEY_PREFIX: 'keyPrefix',
  TITLE_PREFIX: 'titlePrefix',
  TITLE_FUZZY: 'titleFuzzy',
  GUI: 'gui', // classic transaction via #Shell-startGUI?sap-ui2-tcode= (On-Premise / Private Cloud)
});

export const TIER = Object.freeze({
  [MATCH.ALIAS]: 7,
  [MATCH.TCODE]: 6,
  [MATCH.APP_ID]: 5,
  [MATCH.INTENT]: 4,
  [MATCH.TCODE_GUESS]: 3.5,
  [MATCH.GUI]: 3.4,
  [MATCH.KEY_PREFIX]: 3,
  [MATCH.TITLE_PREFIX]: 2,
  [MATCH.TITLE_FUZZY]: 1,
});

const EXACT_KEYED = new Set([MATCH.ALIAS, MATCH.TCODE, MATCH.APP_ID, MATCH.INTENT]);
const KEYED = new Set([...EXACT_KEYED, MATCH.TCODE_GUESS, MATCH.KEY_PREFIX]);

export const SOURCE_RANK = Object.freeze({ user: 4, discovered: 3, import: 2.5, seed: 2, library: 1 });

export const DEFAULT_LAUNCHPAD_PATH = '/ui';
export const HOME_INTENT = 'Shell-home';
export const APP_FINDER_INTENT = 'Shell-appfinder';
export const GUI_INTENT = 'Shell-startGUI';
export const GUI_TCODE_PARAM = 'sap-ui2-tcode';
export const MIN_PREFIX_LENGTH = 2;
/** First tokens that list systems / open options instead of resolving an alias ("?" is special in Chrome's omnibox). */
export const EDITIONS = Object.freeze(['public', 'private', 'onprem']);
export const SYSTEMS_WORDS = Object.freeze(['?', 'list', 'systems', 'options', 'settings', 'setup', 'config']);

const str = (v) => (v == null ? '' : String(v).trim());
const lc = (v) => str(v).toLowerCase();

// ---------------------------------------------------------------- parsing

export function tokenize(text) {
  return str(text).toLowerCase().split(/\s+/).filter(Boolean);
}

export function findSystem(systems, token) {
  const t = lc(token);
  if (!t) return null;
  return (systems || []).find((s) => lc(s.key) === t) ?? null;
}

export function pickDefaultSystem(systems, lastUsedKey) {
  const list = systems || [];
  return list.find((s) => s.isDefault) ?? findSystem(list, lastUsedKey) ?? list[0] ?? null;
}

/**
 * parseInput("acd me23n 4500001234", systems) →
 *   { kind:'query', system, systemExplicit:true, head:'me23n', rest:['4500001234'], query:'me23n 4500001234' }
 * kinds: 'empty' | 'systems' (input "?") | 'home' (system only) | 'query'
 */
export function parseInput(text, systems, { lastUsedKey, preferredKey } = {}) {
  const raw = String(text ?? '');
  const tokens = tokenize(raw);
  const base = { raw, tokens, system: null, systemExplicit: false, head: null, rest: [], query: '' };
  // preferredKey = the system of the tab the user is looking at; it beats the configured default
  const fallback = findSystem(systems, preferredKey) ?? pickDefaultSystem(systems, lastUsedKey);
  if (tokens.length === 0) return { ...base, kind: 'empty', system: fallback };
  if (SYSTEMS_WORDS.includes(tokens[0])) return { ...base, kind: 'systems', system: fallback };
  let system = findSystem(systems, tokens[0]);
  let systemExplicit = false;
  let rest = tokens;
  if (system) {
    systemExplicit = true;
    rest = tokens.slice(1);
  } else {
    system = fallback;
  }
  if (rest.length === 0) return { ...base, kind: 'home', system, systemExplicit };
  return { ...base, kind: 'query', system, systemExplicit, head: rest[0], rest: rest.slice(1), query: rest.join(' ') };
}

// ---------------------------------------------------------------- entries

export function splitIntent(intent) {
  const s = str(intent).replace(/^#/, '').split('?')[0].split('&')[0];
  const i = s.indexOf('-');
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}

export function normalizeEntry(raw) {
  const r = raw || {};
  let semanticObject = str(r.semanticObject);
  let action = str(r.action);
  let intent = str(r.intent).replace(/^#/, '').split('?')[0];
  if (!intent && semanticObject && action) intent = `${semanticObject}-${action}`;
  if (intent && (!semanticObject || !action)) [semanticObject, action] = splitIntent(intent);
  const tcodesRaw = Array.isArray(r.tcodes) ? r.tcodes : str(r.tcodes).split(/[;,\s]+/);
  const tcodes = [...new Set(tcodesRaw.map(lc).filter(Boolean))];
  const editionsRaw = Array.isArray(r.editions) ? r.editions : str(r.editions).split(/[;,\s]+/);
  const editions = [...new Set(editionsRaw.map(lc).filter((e) => EDITIONS.includes(e)))];
  const alias = lc(r.alias) || null;
  return {
    alias,
    semanticObject,
    action,
    intent,
    appId: str(r.appId) || null,
    tcodes,
    title: str(r.title) || intent,
    paramKey: str(r.paramKey) || null,
    editions,
    source: r.source || 'seed',
    confidence: r.confidence || null,
    discoveredOnTarget: Boolean(r.discoveredOnTarget),
    fixedParams: r.fixedParams && typeof r.fixedParams === 'object' && Object.keys(r.fixedParams).length ? { ...r.fixedParams } : null,
    // true = the last scan of the target offers this intent, false = scanned and absent, null = unknown (no scan / Shell intent)
    onTarget: r.onTarget === true ? true : r.onTarget === false ? false : null,
  };
}

/** Shell-* intents (home, app finder) are never listed by getLinks; their presence cannot be judged from a scan. */
export const isShellIntent = (intent) => /^shell-/i.test(str(intent));

function union(...lists) {
  return [...new Set(lists.flat().filter(Boolean))];
}

/**
 * Merge alias tiers for ONE target host.
 * Precedence by alias: user > discovered (auto-alias from appId) > seed > library.
 * `hidden` holds aliases of seed/library rows the user deleted.
 * Discovered rows inherit tcodes / paramKey / appId from static rows with the same intent.
 * Once a tenant has been scanned, low-confidence static rows whose intent the tenant does not offer are dropped.
 */
/** Identity of an entry in user/hidden lists: its alias, or "#intent" for alias-less rows. */
/** `edition` ('public' | 'private' | 'onprem') drops static rows tagged for other editions; untagged rows always apply. */
export const appliesToEdition = (entry, edition) => !edition || !entry.editions?.length || entry.editions.includes(edition);

export const entryKey = (e) => (e.alias ? lc(e.alias) : `#${lc(e.intent)}`);

export function mergeEntries({ user = [], seed = [], hidden = [], discovered = [], edition = null } = {}) {
  const hiddenSet = new Set(hidden.map(lc));
  const discoveredIntents = new Set(discovered.map((d) => lc(normalizeEntry(d).intent)).filter(Boolean));
  const scanned = discoveredIntents.size > 0;
  const onTarget = (intent) => (!scanned || isShellIntent(intent) ? null : discoveredIntents.has(lc(intent)));
  const judged = (e) => ({ ...e, onTarget: onTarget(e.intent) }); // after normalizeEntry, which derives intent from semanticObject/action
  const userEntries = user.map((e) => judged(normalizeEntry({ ...e, source: 'user', discoveredOnTarget: false })));
  const staticEntries = seed
    .map((e) => judged(normalizeEntry(e)))
    .filter((e) => e.intent && !hiddenSet.has(entryKey(e)) && appliesToEdition(e, edition))
    .filter((e) => !(discoveredIntents.size && e.confidence === 'low' && !discoveredIntents.has(lc(e.intent))))
    .sort((a, b) => (SOURCE_RANK[b.source] ?? 0) - (SOURCE_RANK[a.source] ?? 0));

  const byIntent = new Map();
  for (const e of [...userEntries, ...staticEntries]) {
    const k = e.intent.toLowerCase();
    if (!byIntent.has(k)) byIntent.set(k, []);
    byIntent.get(k).push(e);
  }

  const discoveredEntries = discovered
    .map((d) => normalizeEntry({ ...d, source: 'discovered', discoveredOnTarget: true, onTarget: true }))
    .filter((e) => e.intent)
    .map((e) => {
      const sibs = byIntent.get(e.intent.toLowerCase()) || [];
      if (!e.appId) e.appId = sibs.find((s) => s.appId)?.appId ?? null;
      e.alias = e.appId ? e.appId.toLowerCase() : null; // never invent aliases from titles
      e.tcodes = union(e.tcodes, ...sibs.map((s) => s.tcodes));
      if (!e.paramKey) e.paramKey = sibs.find((s) => s.paramKey)?.paramKey ?? null;
      return e;
    });

  const out = [];
  const seenAlias = new Set();
  for (const e of [...userEntries, ...discoveredEntries, ...staticEntries]) {
    if (e.alias) {
      if (seenAlias.has(e.alias)) continue;
      seenAlias.add(e.alias);
    }
    out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------- classic transactions (SAP GUI)

/**
 * Does the typed head look like a transaction code rather than an English word?
 * 'strong': carries a digit, underscore or namespace (ME21N, SE16, S_ALR_87012357, /SAPAPO/SDP94) – always offered.
 * 'weak': letters only, at most four (SPRO, PFCG, STMS) – offered only when nothing else matches, since "sale" or "cost" are words too.
 * false: anything else (manage, purchase, 123).
 */
export function tcodeLike(head) {
  const h = lc(head);
  if (h.length < 2 || h.length > 40) return false;
  if (!/^(\/[a-z0-9_]+\/)?[a-z][a-z0-9_]*$/.test(h)) return false;
  if (/\d|[_/]/.test(h)) return 'strong';
  return h.length <= 4 ? 'weak' : false;
}

/** "/nme21n" (SAP GUI command field) → "me21n"; null when the head carries no /n prefix. */
export function forcedTcode(head) {
  const m = /^\/n(.+)$/i.exec(str(head));
  return m && tcodeLike(m[1]) ? lc(m[1]) : null;
}

/** Synthetic entry that opens transaction `tcode` in the launchpad's SAP GUI (WebGUI) runtime. */
export function guiEntry(tcode, available = null) {
  const t = lc(tcode);
  const T = t.toUpperCase();
  return normalizeEntry({
    alias: `/n${t}`, intent: GUI_INTENT, title: `Transaction ${T} in SAP GUI`, source: 'gui', tcodes: [t],
    fixedParams: { [GUI_TCODE_PARAM]: T }, onTarget: available,
  });
}

// ---------------------------------------------------------------- matching

/**
 * Words of a title for prefix matching. Underscores split too, and camel-case words contribute their parts as well as
 * themselves, so an untitled discovered app shown by its intent ("NYH_AIDocument-process") is found by "aidocu" or
 * "process", and "SalesOrder-manage" by "order".
 */
export function titleWords(title) {
  const raw = String(title ?? '').split(/[\s\-_/(),.:;&+]+/).filter(Boolean);
  const out = [];
  for (const w of raw) {
    out.push(lc(w));
    const parts = w.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(' ');
    if (parts.length > 1) for (const p of parts) out.push(lc(p));
  }
  return [...new Set(out)];
}

export function buildIndex(entries) {
  return (entries || []).map((entry) => ({
    entry,
    alias: entry.alias,
    tcodes: new Set(entry.tcodes || []),
    appId: lc(entry.appId),
    intent: lc(entry.intent),
    keys: [entry.alias, ...(entry.tcodes || []), lc(entry.appId)].filter(Boolean),
    titleLower: lc(entry.title),
    titleWords: titleWords(entry.title),
  }));
}

/** Token-prefix fuzzy match: every query token must prefix a distinct title word. */
export function fuzzyTitle(queryTokens, words) {
  if (!queryTokens.length || !words.length) return null;
  const used = new Set();
  const positions = [];
  for (const q of queryTokens) {
    let found = -1;
    for (let i = 0; i < words.length; i++) {
      if (!used.has(i) && words[i].startsWith(q)) { found = i; break; }
    }
    if (found < 0) return null;
    used.add(found);
    positions.push(found);
  }
  const inOrder = positions.every((p, i) => i === 0 || p > positions[i - 1]);
  const coverage = used.size / words.length + (inOrder ? 0.2 : 0);
  return { coverage };
}

export function matchEntry(ix, head, query) {
  if (ix.alias && ix.alias === head) return { type: MATCH.ALIAS };
  if (ix.tcodes.has(head)) return { type: MATCH.TCODE };
  if (ix.appId && ix.appId === head) return { type: MATCH.APP_ID };
  if (ix.intent && ix.intent === head) return { type: MATCH.INTENT };
  if (head.length >= MIN_PREFIX_LENGTH && ix.keys.some((k) => k.startsWith(head))) return { type: MATCH.KEY_PREFIX };
  if (query && ix.titleLower.startsWith(query)) return { type: MATCH.TITLE_PREFIX };
  const f = fuzzyTitle(query.split(' ').filter(Boolean), ix.titleWords);
  if (f) return { type: MATCH.TITLE_FUZZY, coverage: f.coverage };
  return null;
}

/** Boost for a recently launched intent: 4000 for the most recent, fading out over the last 20 launches – within a tier
 *  it reorders rows, it never lifts a row over a higher tier (20000 apart) or over a scan-present boost (55000). */
export function recentBoost(index) {
  return index == null || index < 0 ? 0 : Math.max(0, 4000 - index * 200);
}

/** Fact sheets (object pages) are reached by navigation, rarely typed: a notch down within the tier. */
const FACT_SHEET_RE = /factsheet$/i;

export function scoreMatch(type, entry, coverage = 0, recentIndex = null, launches = 0) {
  // Rows the scan found present get a boost: exact keyed matches almost three tiers, so a t-code mapped to a present
  // successor app (ME21N → Manage Purchase Orders) outranks the same code's alias row whose app is absent on this
  // tenant, while a present alias still beats a present t-code; title matches a little over one tier, so a present app
  // found by a word inside its title ("partner" in Business Partner) beats absent or unverified library apps whose
  // titles merely start with the word, instead of being crowded out of the result limit by them.
  const present = entry.onTarget === true ? (EXACT_KEYED.has(type) ? 55000 : 25000) : 0;
  return Math.round(TIER[type] * 20000)
    + present
    + recentBoost(recentIndex)
    + Math.min(launches, 5) * 300 // frequently launched: up to +1500 on top of recency
    - (FACT_SHEET_RE.test(String(entry.intent || '')) ? 3000 : 0)
    + (entry.discoveredOnTarget ? 5000 : 0)
    - (entry.onTarget === false ? 6000 : 0) // scanned and absent: sinks within its tier, below present rows of lower keyed tiers
    + Math.round(Math.min(coverage, 1.2) * 1000)
    + Math.max(0, 200 - str(entry.title).length);
}

/**
 * rank(parsed, index, { limit, guesser }) → [{ entry, type, score, param }]
 * `guesser(head)` optionally returns candidate intents ("SO-action") for an unknown t-code;
 * a guess is only offered when that intent exists in the index.
 * `availableOnly` keeps only rows the last scan found on the target (onTarget === true), so on an
 * unscanned system it would drop everything – callers only set it after a scan.
 * `sources` (iterable of entry.source values: user, import, discovered, seed, library, gui) keeps only those rows;
 * a forced "/n" transaction ignores it.
 * `recentIntents` (most recent first, duplicates allowed) boosts rows the user launched lately, within their tier:
 * by how recent the last launch was, plus a little for how often it appears.
 */
export function rank(parsed, index, { limit = 6, guesser = null, gui = null, availableOnly = false, sources = null, recentIntents = null } = {}) {
  const allowed = sources ? new Set(sources) : null;
  const recentIdx = new Map();
  const launches = new Map();
  let order = 0;
  for (const intent of recentIntents || []) {
    const k = lc(intent);
    if (!k) continue;
    if (!recentIdx.has(k)) recentIdx.set(k, order++);
    launches.set(k, (launches.get(k) || 0) + 1);
  }
  const recentOf = (entry) => (recentIdx.size ? recentIdx.get(lc(entry.intent)) ?? null : null);
  const launchesOf = (entry) => launches.get(lc(entry.intent)) || 0;
  if (!parsed || parsed.kind !== 'query' || !parsed.head) return [];
  const head = parsed.head;
  const query = parsed.query;
  const param = parsed.rest.length ? parsed.rest.join(' ') : null;
  const mk = (entry, type, coverage) => ({ entry, type, score: scoreMatch(type, entry, coverage, recentOf(entry), launchesOf(entry)), param: KEYED.has(type) ? param : null });
  const guiOn = Boolean(gui?.enabled) && gui.available !== false; // scanned without Shell-startGUI: never offered

  // "/nse16": only the GUI transaction, nothing else (and nothing at all where GUI launches are not offered)
  const forced = forcedTcode(head);
  if (forced) return guiOn ? [mk(guiEntry(forced, gui.available ?? null), MATCH.GUI)] : [];

  const matches = [];
  for (const ix of index) {
    const m = matchEntry(ix, head, query);
    if (m) matches.push(mk(ix.entry, m.type, m.coverage));
  }

  if (guesser && !matches.some((m) => EXACT_KEYED.has(m.type))) {
    const guessed = new Set((guesser(head) || []).map((g) => lc(typeof g === 'string' ? g : `${g.semanticObject}-${g.action}`)));
    if (guessed.size) {
      for (const ix of index) if (guessed.has(ix.intent)) matches.push(mk(ix.entry, MATCH.TCODE_GUESS));
    }
  }

  // weak shapes (letters only, ≤4): only when nothing usable matched – no match at all, every match scanned absent, or
  // (with the filter on) none present
  const usable = (m) => (availableOnly ? m.entry.onTarget === true : m.entry.onTarget !== false);
  const shape = guiOn ? tcodeLike(head) : false;
  if (shape === 'strong' || (shape === 'weak' && !matches.some(usable))) {
    // Fiori intent known present or unverified: GUI second; known absent (or no exact match at all): GUI first.
    const exactUsable = matches.some((m) => EXACT_KEYED.has(m.type) && m.entry.onTarget !== false);
    const g = mk(guiEntry(head, gui.available ?? null), MATCH.GUI);
    if (!exactUsable) g.score = Math.round(TIER[MATCH.ALIAS] * 20000) + 10000;
    matches.push(g);
  }

  const pool = matches.filter((m) => (!availableOnly || m.entry.onTarget === true) && (!allowed || allowed.has(m.entry.source)));
  pool.sort((a, b) => b.score - a.score
    || (a.entry.alias?.length ?? 99) - (b.entry.alias?.length ?? 99) // same score: shorter alias (f0842 before dfs_po_manage)
    || cmpNullable(a.entry.alias, b.entry.alias)
    || lc(a.entry.intent).localeCompare(lc(b.entry.intent)));

  const seen = new Set();
  const out = [];
  for (const m of pool) {
    const k = lc(m.entry.intent) + (m.entry.fixedParams ? '?' + JSON.stringify(m.entry.fixedParams) : '');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
    if (out.length >= limit) break;
  }
  return out;
}

function cmpNullable(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a.localeCompare(b);
}

// ---------------------------------------------------------------- urls

/** "https://host[:port]/path?query" – host may carry a port; launchpadQuery (e.g. "sap-client=600") is kept on every URL. */
export function launchpadBase(system) {
  const path = str(system?.launchpadPath) || DEFAULT_LAUNCHPAD_PATH;
  const scheme = lc(system?.scheme) === 'http' ? 'http' : 'https';
  const query = str(system?.launchpadQuery).replace(/^\?/, '');
  return `${scheme}://${lc(system?.host)}${path.startsWith('/') ? path : '/' + path}${query ? '?' + query : ''}`;
}

export function intentUrl(system, intent, params = null) {
  let url = `${launchpadBase(system)}#${str(intent).replace(/^#/, '')}`;
  const entries = Object.entries(params || {}).filter(([, v]) => v != null && v !== '');
  if (entries.length) url += '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return url;
}

export function buildUrl(system, entry, param = null) {
  const key = entry.paramKey || entry.semanticObject;
  const params = { ...(entry.fixedParams || {}) };
  // a Shell-startGUI row (library "SAP GUI" apps, user aliases) needs its transaction code or the shell opens nothing
  if (lc(entry.intent) === lc(GUI_INTENT) && !params[GUI_TCODE_PARAM] && !entry.paramKey) {
    const t = entry.tcodes?.[0] || entry.appId || (entry.alias && !entry.alias.startsWith('/') ? entry.alias : null);
    if (t) params[GUI_TCODE_PARAM] = String(t).toUpperCase();
  }
  if (param) params[key] = param;
  return intentUrl(system, entry.intent, params);
}

export const homeUrl = (system) => intentUrl(system, HOME_INTENT);
export const appFinderUrl = (system) => intentUrl(system, APP_FINDER_INTENT);

/** Compares host including an explicit port ("acd.finteq.io:8443"); default ports are normalised by URL(). */
export function isOnHost(url, system) {
  if (!url || !system?.host) return false;
  try {
    return new URL(url).host.toLowerCase() === lc(system.host);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- formatting

export function escapeXml(s) {
  return str(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Omnibox `content` must round-trip through parseInput: "<systemKey> <alias|intent> [param]". */
export function suggestionContent(match, system) {
  const e = match.entry;
  const key = e.alias ?? e.intent;
  return `${system.key} ${key}${match.param ? ' ' + match.param : ''}`;
}

export function formatSuggestion(match, system) {
  const e = match.entry;
  const key = e.alias ?? e.intent;
  const isTitle = match.type === MATCH.TITLE_PREFIX || match.type === MATCH.TITLE_FUZZY;
  const left = isTitle ? escapeXml(key) : `<match>${escapeXml(key)}</match>`;
  const mid = isTitle ? `<match>${escapeXml(e.title)}</match>` : escapeXml(e.title);
  const tags = [system.key, e.intent];
  if (match.type === MATCH.TCODE_GUESS || e.confidence === 'low') tags.push('guess');
  if (match.type === MATCH.GUI) tags.push('SAP GUI');
  if (e.onTarget === true) tags.push('on tenant');
  else if (e.onTarget === false) tags.push(`not found on ${system.key}`);
  return { content: suggestionContent(match, system), description: `${left}  ${mid}  <dim>[${escapeXml(tags.join(' · '))}]</dim>` };
}

export function formatSystemSuggestion(system) {
  const tags = [system.env, system.host].filter(Boolean).join(' · ');
  return {
    content: `${system.key}`,
    description: `<match>${escapeXml(system.key)}</match>  ${escapeXml(system.name || '')}  <dim>[${escapeXml(tags)}]</dim>`,
  };
}

export function formatDefaultDescription(parsed, topMatch = null) {
  const sys = parsed?.system;
  if (!sys) return 'No systems configured – type anything and press Enter to open slashn options';
  const where = `<dim>[${escapeXml(sys.key)} · ${escapeXml(sys.host)}]</dim>`;
  switch (parsed.kind) {
    case 'systems':
      return 'Select a system below, or press Enter to open slashn options';
    case 'empty':
    case 'home':
      return `Open launchpad home ${where}`;
    case 'query':
      if (topMatch) {
        const e = topMatch.entry;
        const warn = e.onTarget === false ? ` <dim>– not found on ${escapeXml(sys.key)} in the last scan</dim>` : '';
        return `Open <match>${escapeXml(e.alias ?? e.intent)}</match> ${escapeXml(e.title)}${topMatch.param ? ' ' + escapeXml(topMatch.param) : ''} ${where}${warn}`;
      }
      return `No match for "${escapeXml(parsed.query)}" – Enter opens the App Finder and copies it ${where}`;
    default:
      return '';
  }
}
