// SAP QuickStart — MV3 service worker.
// Omnibox handling, alias resolution, navigation, seed loading, discovery bookkeeping, rescan orchestration.
import { MSG, LOG_PREFIX } from './messages.js';
import { createStorage } from './storage.js';
import {
  parseInput, mergeEntries, buildIndex, rank, buildUrl, homeUrl, appFinderUrl, isOnHost,
  formatSuggestion, formatSystemSuggestion, formatDefaultDescription, MATCH,
} from './resolver.js';
import { makeGuesser } from './tcodes.js';

const storage = createStorage();
const guesser = makeGuesser();
const log = (...args) => console.debug(LOG_PREFIX, ...args);
const warn = (...args) => console.warn(LOG_PREFIX, ...args);

let cachePromise = null;
let latestInput = null;

// ---------------------------------------------------------------- listeners (must be registered synchronously)

chrome.runtime.onInstalled.addListener((details) => {
  onInstalled(details).catch((e) => warn('install failed', e));
});
chrome.runtime.onStartup?.addListener(() => {
  ensureSeed({ force: false }).catch((e) => warn('seed check failed', e));
});
chrome.omnibox.onInputStarted.addListener(() => {
  getCache().catch((e) => warn('cache warm-up failed', e));
});
chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  onInputChanged(text, suggest).catch((e) => warn('onInputChanged failed', e));
});
chrome.omnibox.onInputEntered.addListener((text, disposition) => {
  onInputEntered(text, disposition).catch((e) => warn('onInputEntered failed', e));
});
chrome.omnibox.onInputCancelled.addListener(() => { latestInput = null; });
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || msg.type === MSG.COPY) return false; // COPY is for the offscreen page
  handleMessage(msg, sender).then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});
chrome.storage.onChanged.addListener(() => { cachePromise = null; });

log('service worker ready');

// ---------------------------------------------------------------- install / seed

async function onInstalled(details) {
  log('onInstalled', details.reason);
  await storage.migrate();
  await ensureSeed({ force: true });
}

async function ensureSeed({ force }) {
  const version = chrome.runtime.getManifest().version;
  const read = async (path) => {
    try {
      const res = await fetch(chrome.runtime.getURL(path));
      return res.ok ? await res.text() : '';
    } catch (e) {
      warn('seed file missing', path, e);
      return '';
    }
  };
  const [aliasesCsv, libraryCsv, tcodesCsv] = await Promise.all([read('src/seed/aliases.csv'), read('src/seed/library.csv'), read('src/seed/tcodes.csv')]);
  const result = await storage.applySeed({ aliasesCsv, libraryCsv, tcodesCsv, version, force });
  if (result.applied) log('seed applied', result.count, 'entries', result.errors.length ? result.errors : '');
  return result;
}

// ---------------------------------------------------------------- cache

function getCache() {
  if (!cachePromise) {
    cachePromise = storage.loadSnapshot().then((snap) => ({ ...snap, indexByHost: new Map() })).catch((e) => {
      cachePromise = null;
      throw e;
    });
  }
  return cachePromise;
}

function indexFor(cache, system) {
  const host = system.host;
  if (!cache.indexByHost.has(host)) {
    const entries = mergeEntries({
      user: cache.userAliases,
      seed: [...cache.seedAliases, ...(cache.importedAliases || [])],
      hidden: cache.hiddenAliases,
      discovered: cache.discovered?.[host]?.entries || [],
    });
    cache.indexByHost.set(host, buildIndex(entries));
  }
  return cache.indexByHost.get(host);
}

function systemByHost(systems, host) {
  const h = String(host || '').toLowerCase();
  return systems.find((s) => s.host === h) ?? null;
}

// ---------------------------------------------------------------- omnibox

function setDefault(description) {
  try {
    chrome.omnibox.setDefaultSuggestion({ description });
  } catch (e) {
    warn('setDefaultSuggestion rejected', e);
  }
}

async function onInputChanged(text, suggest) {
  latestInput = text;
  const cache = await getCache();
  if (latestInput !== text) return; // stale
  const parsed = parseInput(text, cache.systems, { lastUsedKey: cache.lastUsedKey });
  try {
    if (parsed.kind === 'systems') {
      setDefault(formatDefaultDescription(parsed));
      suggest(cache.systems.map(formatSystemSuggestion));
      return;
    }
    if (!parsed.system) {
      setDefault(formatDefaultDescription(parsed));
      suggest([]);
      return;
    }
    if (parsed.kind !== 'query') {
      setDefault(formatDefaultDescription(parsed));
      suggest([]);
      return;
    }
    const matches = rank(parsed, indexFor(cache, parsed.system), { limit: cache.settings.suggestionLimit, guesser });
    setDefault(formatDefaultDescription(parsed, matches[0] ?? null));
    const seen = new Set();
    const suggestions = [];
    for (const m of matches) {
      const s = formatSuggestion(m, parsed.system);
      if (seen.has(s.content)) continue;
      seen.add(s.content);
      suggestions.push(s);
    }
    suggest(suggestions);
  } catch (e) {
    warn('suggest failed (check XML escaping)', e);
  }
}

async function onInputEntered(text, disposition) {
  const cache = await getCache();
  const parsed = parseInput(text, cache.systems, { lastUsedKey: cache.lastUsedKey });
  const system = parsed.system;
  if (parsed.kind === 'systems' || !system) {
    await chrome.runtime.openOptionsPage();
    return;
  }
  if (parsed.kind !== 'query') {
    await navigate(homeUrl(system), system, disposition, cache.settings);
    await remember({ systemKey: system.key, host: system.host, intent: 'Shell-home', alias: null, title: 'Launchpad home', url: homeUrl(system), input: text });
    return;
  }
  const matches = rank(parsed, indexFor(cache, system), { limit: 1, guesser });
  const top = matches[0];
  if (!top) {
    const url = appFinderUrl(system);
    await navigate(url, system, disposition, cache.settings);
    await copyToClipboard(parsed.query);
    await remember({ systemKey: system.key, host: system.host, intent: 'Shell-appfinder', alias: null, title: `App Finder (unresolved "${parsed.query}")`, url, input: text, unresolved: parsed.query });
    return;
  }
  const url = buildUrl(system, top.entry, top.param);
  await navigate(url, system, disposition, cache.settings);
  await remember({
    systemKey: system.key, host: system.host, intent: top.entry.intent, alias: top.entry.alias, title: top.entry.title,
    url, input: text, param: top.param, matchType: top.type, guess: top.type === MATCH.TCODE_GUESS || top.entry.confidence === 'low',
  });
}

async function remember(launch) {
  try {
    await storage.pushRecent({ ts: Date.now(), ...launch });
    await storage.setLastUsedSystemKey(launch.systemKey);
  } catch (e) {
    warn('could not record launch', e);
  }
}

/**
 * Chrome reports: plain Enter → "currentTab", Alt+Enter → "newForegroundTab", Ctrl/Cmd+Enter → "newBackgroundTab".
 * currentTab reuses the active tab only when it is already on the target host (hash-only navigation, no reload).
 */
async function navigate(url, system, disposition, settings) {
  if (disposition !== 'currentTab') {
    await chrome.tabs.create({ url, active: disposition === 'newForegroundTab' });
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab && settings.reuseTabOnSameHost !== false && isOnHost(tab.url, system)) {
    await chrome.tabs.update(tab.id, { url });
    return;
  }
  await chrome.tabs.create({ url, active: true });
}

// ---------------------------------------------------------------- clipboard (offscreen document)

async function copyToClipboard(text) {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (!contexts.length) {
      await chrome.offscreen.createDocument({
        url: 'src/offscreen/offscreen.html',
        reasons: ['CLIPBOARD'],
        justification: 'Copy an unresolved alias so it can be pasted into the SAP app finder',
      });
    }
    const res = await chrome.runtime.sendMessage({ type: MSG.COPY, text });
    log('clipboard', res);
  } catch (e) {
    warn('clipboard copy failed', e);
  } finally {
    try { await chrome.offscreen.closeDocument(); } catch { /* already closed */ }
  }
}

// ---------------------------------------------------------------- messages

const INTENT_RE = /^[A-Za-z0-9_]+-[A-Za-z0-9_]+$/;
const MAX_ENTRIES = 5000;

function sanitizeEntries(entries) {
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const e of entries.slice(0, MAX_ENTRIES)) {
    if (!e || typeof e.intent !== 'string') continue;
    const intent = e.intent.replace(/^#/, '').split('?')[0];
    if (!INTENT_RE.test(intent)) continue;
    const [semanticObject, action] = intent.split(/-(.*)/s);
    out.push({
      intent,
      semanticObject,
      action,
      title: typeof e.title === 'string' ? e.title.slice(0, 200) : intent,
      appId: typeof e.appId === 'string' ? e.appId.slice(0, 40) : null,
      paramKey: typeof e.paramKey === 'string' ? e.paramKey.slice(0, 80) : null,
    });
  }
  return out;
}

async function handleMessage(msg, sender) {
  if (sender.id !== chrome.runtime.id) return { error: 'foreign sender' };
  switch (msg.type) {
    case MSG.PAGE_READY: {
      if (!sender.tab) return { scan: false, reason: 'no tab' };
      const cache = await getCache();
      const system = systemByHost(cache.systems, msg.host);
      if (!system) return { scan: false, reason: 'unregistered host' };
      const pending = await storage.getPendingRescan(system.host);
      const meta = cache.scanMeta?.[system.host];
      const ageDays = meta?.lastScanned ? (Date.now() - Date.parse(meta.lastScanned)) / 86400000 : Infinity;
      const scan = pending || !meta || ageDays > cache.settings.autoScanDays;
      if (pending) await storage.setPendingRescan(system.host, false);
      const reason = pending ? 'requested' : !meta ? 'never scanned' : ageDays > cache.settings.autoScanDays ? 'stale' : 'fresh';
      log('page ready', system.key, { scan, reason });
      return { scan, reason };
    }
    case MSG.DISCOVERY_RESULT: {
      const cache = await getCache();
      const system = systemByHost(cache.systems, msg.host);
      if (!system) return { stored: 0, error: 'unregistered host' };
      const entries = sanitizeEntries(msg.entries);
      await storage.setDiscovered(system.host, {
        scannedAt: new Date().toISOString(),
        ui5Version: typeof msg.ui5Version === 'string' ? msg.ui5Version : null,
        methods: msg.methods && typeof msg.methods === 'object' ? msg.methods : {},
        errors: Array.isArray(msg.errors) ? msg.errors.slice(0, 20).map(String) : [],
        entries,
      });
      cachePromise = null;
      log('discovery stored', system.key, entries.length);
      return { stored: entries.length };
    }
    case MSG.RESCAN_HOST: {
      const cache = await getCache();
      const system = systemByHost(cache.systems, msg.host);
      if (!system) return { status: 'error', error: 'unregistered host' };
      const tabs = await chrome.tabs.query({ url: `https://${system.host}/*` });
      if (tabs.length) {
        try {
          await chrome.tabs.sendMessage(tabs[0].id, { type: MSG.RESCAN_TAB });
          return { status: 'messaged' };
        } catch {
          await storage.setPendingRescan(system.host, true);
          await chrome.tabs.reload(tabs[0].id);
          return { status: 'reloaded' };
        }
      }
      await storage.setPendingRescan(system.host, true);
      await chrome.tabs.create({ url: homeUrl(system), active: true });
      return { status: 'opened' };
    }
    case MSG.GET_STATE: {
      const cache = await getCache();
      const { indexByHost, ...snapshot } = cache;
      return { snapshot };
    }
    default:
      return { ignored: true };
  }
}
