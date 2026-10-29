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
});

export const TIER = Object.freeze({
  [MATCH.ALIAS]: 7,
  [MATCH.TCODE]: 6,
  [MATCH.APP_ID]: 5,
  [MATCH.INTENT]: 4,
  [MATCH.TCODE_GUESS]: 3.5,
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
export function parseInput(text, systems, { lastUsedKey } = {}) {
  const raw = String(text ?? '');
  const tokens = tokenize(raw);
  const base = { raw, tokens, system: null, systemExplicit: false, head: null, rest: [], query: '' };
  const fallback = pickDefaultSystem(systems, lastUsedKey);
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
  };
}

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
  const userEntries = user.map((e) => normalizeEntry({ ...e, source: 'user', discoveredOnTarget: false }));
  const staticEntries = seed
    .map((e) => normalizeEntry(e))
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
    .map((d) => normalizeEntry({ ...d, source: 'discovered', discoveredOnTarget: true }))
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

// ---------------------------------------------------------------- matching

export function titleWords(title) {
  return lc(title).split(/[\s\-/(),.:;&+]+/).filter(Boolean);
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

export function scoreMatch(type, entry, coverage = 0) {
  return Math.round(TIER[type] * 20000)
    + (entry.discoveredOnTarget ? 5000 : 0)
    + Math.round(Math.min(coverage, 1.2) * 1000)
    + Math.max(0, 200 - str(entry.title).length);
}

/**
 * rank(parsed, index, { limit, guesser }) → [{ entry, type, score, param }]
 * `guesser(head)` optionally returns candidate intents ("SO-action") for an unknown t-code;
 * a guess is only offered when that intent exists in the index.
 */
export function rank(parsed, index, { limit = 6, guesser = null } = {}) {
  if (!parsed || parsed.kind !== 'query' || !parsed.head) return [];
  const head = parsed.head;
  const query = parsed.query;
  const param = parsed.rest.length ? parsed.rest.join(' ') : null;
  const mk = (entry, type, coverage) => ({ entry, type, score: scoreMatch(type, entry, coverage), param: KEYED.has(type) ? param : null });

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

  matches.sort((a, b) => b.score - a.score
    || (a.entry.alias?.length ?? 99) - (b.entry.alias?.length ?? 99) // same score: shorter alias (f0842 before dfs_po_manage)
    || cmpNullable(a.entry.alias, b.entry.alias)
    || lc(a.entry.intent).localeCompare(lc(b.entry.intent)));

  const seen = new Set();
  const out = [];
  for (const m of matches) {
    const k = lc(m.entry.intent);
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
  return intentUrl(system, entry.intent, param ? { [key]: param } : null);
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
  if (e.discoveredOnTarget) tags.push('on tenant');
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
        return `Open <match>${escapeXml(e.alias ?? e.intent)}</match> ${escapeXml(e.title)}${topMatch.param ? ' ' + escapeXml(topMatch.param) : ''} ${where}`;
      }
      return `No match for "${escapeXml(parsed.query)}" – Enter opens the App Finder and copies it ${where}`;
    default:
      return '';
  }
}
