// slashn — MV3 service worker.
// Omnibox handling, alias resolution, navigation, seed loading, discovery bookkeeping, rescan orchestration.
import { MSG, LOG_PREFIX } from './messages.js';
import { createStorage, isDefaultHost, originPattern, looksLikeLaunchpad, sanitizeDiscoveredRecord, targetKey, systemByTarget, systemForUrl, isOnTarget } from './storage.js';
import {
  parseInput, mergeEntries, buildIndex, rank, buildUrl, homeUrl, appFinderUrl,
  formatSuggestion, formatSystemSuggestion, formatDefaultDescription, MATCH,
} from './resolver.js';
import { makeGuesser } from './tcodes.js';
import { probeTab } from './probe.js';
import { runDebugCallInPage, debugCallById } from './debug.js';

const storage = createStorage();
const guesser = makeGuesser();
const log = (...args) => console.debug(LOG_PREFIX, ...args);
const warn = (...args) => console.warn(LOG_PREFIX, ...args);

let cachePromise = null;
let latestInput = null;
let contextKey = null; // system key of the tab the omnibox session started on
const LIVE_CHECK_TIMEOUT_MS = 3000;
const SYSTEM_INFO_WINDOW = { width: 560, height: 680 };
const DEBUG_WINDOW = { width: 760, height: 760 };

// ---------------------------------------------------------------- listeners (must be registered synchronously)

chrome.runtime.onInstalled.addListener((details) => {
  onInstalled(details).catch((e) => warn('install failed', e));
});
chrome.runtime.onStartup?.addListener(() => {
  ensureSeed({ force: false }).catch((e) => warn('seed check failed', e));
  syncContentScripts().catch((e) => warn('content script sync failed', e));
  refreshActionForAllTabs().catch((e) => warn('action state failed', e));
});
// toolbar button: greyed out on pages that are not a SAP launchpad (setting actionOnlyOnSap, default on)
chrome.tabs?.onActivated?.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then(applyActionState).catch((e) => warn('action state failed', e));
});
chrome.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
  // Chrome clears per-tab button state when the navigation commits, which can be after "loading"; "complete" re-applies it.
  if (changeInfo.url || changeInfo.status === 'loading' || changeInfo.status === 'complete') applyActionState(tab).catch((e) => warn('action state failed', e));
});
chrome.omnibox.onInputStarted.addListener(() => {
  contextKey = null;
  Promise.all([getCache(), activeTabUrl()]).then(([cache, url]) => {
    contextKey = systemForUrl(cache.systems, url)?.key ?? null;
    // Show help before the first keystroke: launchpad target, or "no systems" guidance.
    const parsed = parseInput('', cache.systems, { lastUsedKey: cache.lastUsedKey, preferredKey: contextKey });
    setDefault(parsed.system ? `${formatDefaultDescription(parsed)} – type an alias, or "list" for systems` : formatDefaultDescription(parsed));
  }).catch((e) => warn('cache warm-up failed', e));
});
chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  onInputChanged(text, suggest).catch((e) => warn('onInputChanged failed', e));
});
chrome.omnibox.onInputEntered.addListener((text, disposition) => {
  onInputEntered(text, disposition).catch((e) => warn('onInputEntered failed', e));
});
chrome.omnibox.onInputCancelled.addListener(() => { latestInput = null; contextKey = null; });
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || msg.type === MSG.COPY) return false; // COPY is for the offscreen page
  handleMessage(msg, sender).then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});
chrome.storage.onChanged.addListener((changes, area) => {
  cachePromise = null;
  if (area === 'sync' && changes.systems) syncContentScripts().catch((e) => warn('content script sync failed', e));
  if (area === 'sync' && (changes.systems || changes.settings)) refreshActionForAllTabs().catch((e) => warn('action state failed', e));
});
chrome.commands?.onCommand?.addListener((command) => {
  if (command === 'open-launcher') openLauncher().catch((e) => warn('launcher failed', e));
});
// the toolbar button has no default popup: a click opens the same overlay as the shortcut (activeTab is granted by the click)
chrome.action?.onClicked?.addListener((tab) => {
  openLauncher(tab).catch((e) => warn('launcher failed', e));
});
chrome.permissions?.onAdded?.addListener(() => syncContentScripts().catch((e) => warn('content script sync failed', e)));
chrome.permissions?.onRemoved?.addListener(() => syncContentScripts().catch((e) => warn('content script sync failed', e)));

log('service worker ready');
// the global default (disabled when the setting is on) lives in the worker, which Chrome restarts often: set it on every start
refreshActionForAllTabs().catch((e) => warn('action state failed', e));

// ---------------------------------------------------------------- install / seed

async function onInstalled(details) {
  log('onInstalled', details.reason);
  await storage.migrate();
  await ensureSeed({ force: true });
  await syncContentScripts();
  await refreshActionForAllTabs();
  if (details.reason === 'install') await chrome.runtime.openOptionsPage?.().catch?.((e) => warn('options page failed', e)); // first run: add a system
}

/**
 * Hosts outside *.s4hana.cloud.sap are not covered by the manifest. For each such system whose origin the user
 * granted, register the two content scripts dynamically; unregister scripts for systems that were removed.
 */
async function syncContentScripts() {
  if (!chrome.scripting?.registerContentScripts || !chrome.permissions?.contains) return { registered: [], removed: [] };
  const systems = await storage.getSystems();
  const wanted = new Map();
  for (const sys of systems) {
    if (isDefaultHost(sys.host)) continue;
    const origin = originPattern(sys);
    let granted = false;
    try { granted = await chrome.permissions.contains({ origins: [origin] }); } catch { granted = false; }
    if (granted) wanted.set(sys.host, origin);
  }
  const existing = (await chrome.scripting.getRegisteredContentScripts()).filter((s) => s.id.startsWith('sapqs-'));
  const hostOf = (id) => id.replace(/^sapqs-(main|iso)-/, '');
  const removed = existing.filter((s) => !wanted.has(hostOf(s.id))).map((s) => s.id);
  if (removed.length) await chrome.scripting.unregisterContentScripts({ ids: removed });
  const have = new Set(existing.map((s) => s.id));
  const toAdd = [];
  for (const [host, origin] of wanted) {
    if (!have.has(`sapqs-main-${host}`)) toAdd.push({ id: `sapqs-main-${host}`, matches: [origin], js: ['src/content-main.js'], world: 'MAIN', runAt: 'document_start', persistAcrossSessions: true });
    if (!have.has(`sapqs-iso-${host}`)) toAdd.push({ id: `sapqs-iso-${host}`, matches: [origin], js: ['src/content-isolated.js'], runAt: 'document_idle', persistAcrossSessions: true });
  }
  if (toAdd.length) await chrome.scripting.registerContentScripts(toAdd);
  if (toAdd.length || removed.length) log('content scripts synced', { registered: toAdd.map((s) => s.id), removed });
  return { registered: toAdd.map((s) => s.id), removed };
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
  const [aliasesCsv, libraryCsv, tcodesCsv, tcodeAppsJson] = await Promise.all([read('src/seed/aliases.csv'), read('src/seed/library.csv'), read('src/seed/tcodes.csv'), read('src/seed/tcode-apps.json')]);
  const result = await storage.applySeed({ aliasesCsv, libraryCsv, tcodesCsv, tcodeAppsJson, version, force });
  if (result.applied) {
    const problems = result.errors.filter((e) => !e.info);
    log('seed applied', result.count, 'entries', problems.length ? problems : '', result.errors.length - problems.length, 'app-map codes without a library app');
  }
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
  const host = targetKey(system); // host, or host/client: two clients of one host are indexed apart
  if (!cache.indexByHost.has(host)) {
    const entries = mergeEntries({
      user: cache.userAliases,
      seed: [...cache.seedAliases, ...(cache.importedAliases || [])],
      hidden: cache.hiddenAliases,
      discovered: cache.discovered?.[host]?.entries || [],
      edition: system.edition || null,
    });
    cache.indexByHost.set(host, buildIndex(entries));
  }
  return cache.indexByHost.get(host);
}

/** Intents launched lately on this system, most recent first (repeats kept: they count as frequency), for the ranking. */
function recentIntentsFor(cache, system) {
  return (cache.recent || []).filter((r) => r.host === targetKey(system) && r.intent && !/^Shell-/i.test(r.intent)).map((r) => r.intent);
}

/**
 * Classic transactions (#Shell-startGUI?sap-ui2-tcode=) are offered on On-Premise and Private Cloud systems only; Public Cloud
 * exposes the intent but almost no transactions. After a scan, only when the tenant actually offers Shell-startGUI.
 */
function guiFor(cache, system) {
  const entries = cache.discovered?.[targetKey(system)]?.entries || [];
  const available = entries.length ? entries.some((e) => /^shell-startgui$/i.test(String(e.intent || ''))) : null;
  return { enabled: (system.edition || 'onprem') !== 'public', available };
}

/** `target` is a host (what content scripts send) or host/client (what the extension's own pages send). */
function systemByHost(systems, target) {
  return systemByTarget(systems, target);
}
/** The system of a tab: its host and, when systems on that host differ by client, the URL's sap-client. */
function systemForTab(systems, url) {
  return url ? systemForUrl(systems, url) : null;
}

/** Host (with port) of the active tab; undefined when the extension may not see that tab's URL. */
// ---------------------------------------------------------------- toolbar button state

const ACTION_ICON = Object.freeze({
  on: { 16: 'icons/icon16.png', 32: 'icons/icon32.png' },
  off: { 16: 'icons/icon-off16.png', 32: 'icons/icon-off32.png' },
});
const iconPixels = new Map(); // 'on' | 'off' → { 16: ImageData, 32: ImageData }

/**
 * setIcon({ path }) fetches and decodes the file inside Chrome; that silently yields nothing for some PNGs (the red
 * tiles came back as 0 bytes). Decoding here and passing pixels makes the result deterministic and failures loud.
 */
async function iconImageData(which) {
  if (iconPixels.has(which)) return iconPixels.get(which);
  const out = {};
  for (const [size, path] of Object.entries(ACTION_ICON[which])) {
    const res = await fetch(chrome.runtime.getURL(path));
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    const bitmap = await createImageBitmap(await res.blob());
    const canvas = new OffscreenCanvas(Number(size), Number(size));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, Number(size), Number(size));
    out[size] = ctx.getImageData(0, 0, Number(size), Number(size));
  }
  iconPixels.set(which, out);
  return out;
}

async function setActionIcon(which, tabId = null) {
  const target = tabId == null ? {} : { tabId };
  try {
    await chrome.action.setIcon({ ...target, imageData: await iconImageData(which) });
  } catch (e) {
    warn('action icon (pixels) failed, falling back to path', which, tabId, e);
    await chrome.action.setIcon({ ...target, path: ACTION_ICON[which] });
  }
}
// Chrome draws a disabled action with the *default* icon, ignoring the tab's own, so the default is the red tile
// whenever the setting is on and SAP tabs get the blue one per tab after being enabled.
const OFF_TITLE = 'slashn – not on a SAP launchpad (the address bar still works: type s, space, alias)';

/** A registered system's host, or any page that looks like a Fiori launchpad (so "Add as system" stays reachable). */
export function isSapTab(url, systems) {
  if (!url || !/^https?:/i.test(url)) return false;
  let host = '';
  try { host = new URL(url).host.toLowerCase(); } catch { return false; }
  return Boolean(host) && (Boolean(systemForUrl(systems, url)) || looksLikeLaunchpad(url));
}

/** Enables or disables the toolbar button for one tab. Chrome clears per-tab state on navigation, so onUpdated re-applies it. */
async function applyActionState(tab) {
  if (!chrome.action || !tab || tab.id == null) return;
  const cache = await getCache();
  const on = cache.settings.actionOnlyOnSap === false || isSapTab(tab.url, cache.systems);
  // title first: it is the one state visible in the tooltip, so it must land even if the icon or enable call fails
  await chrome.action.setTitle({ tabId: tab.id, title: on ? 'slashn' : OFF_TITLE });
  if (on) await chrome.action.enable(tab.id); else await chrome.action.disable(tab.id);
  try {
    await setActionIcon(on ? 'on' : 'off', tab.id);
  } catch (e) {
    warn('action icon failed', tab.id, e);
  }
}

/** Global default plus every open tab: run at install, start-up and whenever systems or settings change. */
async function refreshActionForAllTabs() {
  if (!chrome.action) return;
  const cache = await getCache();
  const everywhere = cache.settings.actionOnlyOnSap === false;
  // the defaults, which also cover the moment after a navigation commits and Chrome has dropped the tab's own state
  await chrome.action.setTitle({ title: everywhere ? 'slashn' : OFF_TITLE });
  if (everywhere) await chrome.action.enable(); else await chrome.action.disable();
  try {
    await setActionIcon(everywhere ? 'on' : 'off');
  } catch (e) {
    warn('default action icon failed', e);
  }
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((t) => applyActionState(t).catch((e) => warn('action state failed', t.id, e))));
}

async function activeTabUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.url || null;
  } catch {
    return null;
  }
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
  const parsed = parseInput(text, cache.systems, { lastUsedKey: cache.lastUsedKey, preferredKey: contextKey });
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
    const matches = rank(parsed, indexFor(cache, parsed.system), { limit: cache.settings.suggestionLimit, guesser, gui: guiFor(cache, parsed.system), recentIntents: recentIntentsFor(cache, parsed.system) });
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
  return launch(text, disposition);
}

/**
 * The launchpad tab a scan requested by the user should run in: the tab the launcher sits on when it is one, else a tab
 * of `system` in the caller's window (the active one first). A tab in another window is left alone – the user asked
 * from this window and must see the scan happen – so null means "open a new tab here".
 */
async function rescanTab(system, contextTabId, windowId) {
  const pattern = originPattern(system);
  if (contextTabId != null) {
    const t = await chrome.tabs.get(contextTabId).catch(() => null);
    if (t?.url && isOnTarget(t.url, system)) return t;
  }
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: pattern }); } catch { return null; }
  tabs = tabs.filter((t) => isOnTarget(t.url, system)); // the same host on another client is another system's tab
  if (windowId != null) tabs = tabs.filter((t) => t.windowId === windowId);
  tabs.sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));
  return tabs[0] || null;
}

/**
 * Ask an open launchpad tab of `system` whether the current session can navigate to `intents` (Navigation.isNavigationSupported).
 * Returns { available: { intent: bool }, tabId } or null when no tab with a live content script exists.
 */
async function liveCheck(system, intents) {
  const list = [...new Set(intents.filter((i) => i && !/^shell-/i.test(i)))];
  if (!list.length || !chrome.tabs?.sendMessage) return null;
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: originPattern(system) }); } catch { return null; }
  tabs = tabs.filter((t) => isOnTarget(t.url, system));
  tabs.sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));
  for (const tab of tabs.slice(0, 3)) {
    try {
      const reply = await Promise.race([
        chrome.tabs.sendMessage(tab.id, { type: MSG.CHECK_INTENTS, intents: list }),
        new Promise((resolve) => setTimeout(() => resolve(null), LIVE_CHECK_TIMEOUT_MS)),
      ]);
      if (!reply || !Array.isArray(reply.supported)) continue;
      const available = {};
      (reply.intents || list).forEach((intent, i) => { available[intent] = Boolean(reply.supported[i]); });
      return { available, tabId: tab.id };
    } catch { /* tab predates install or has no content script */ }
  }
  return null;
}

/** A live answer that contradicts the stored scan marks the host for a rescan on its next load. */
async function noteMismatch(system, entry, live) {
  if (!live || entry.onTarget == null) return;
  const l = live.available[entry.intent];
  if (l != null && l !== entry.onTarget) {
    log('live check differs from scan; rescan scheduled', system.key, entry.intent, { scan: entry.onTarget, live: l });
    await storage.setPendingRescan(targetKey(system), true).catch(() => {});
  }
}

/**
 * launch(text, disposition, preferredKey, { confirm, force })
 * confirm=true (popup): when the top match is known to be unavailable – by a live check against an open tab,
 * else by the last scan – nothing is opened and { action:'blocked' } is returned so the UI can ask once; force=true overrides.
 * The omnibox has no way to ask, so it always opens and lets the launchpad show its own error.
 */
async function launch(text, disposition, preferredKey = contextKey, { confirm = false, force = false, contextTabId = null } = {}) {
  const cache = await getCache();
  const parsed = parseInput(text, cache.systems, { lastUsedKey: cache.lastUsedKey, preferredKey });
  const system = parsed.system;
  if (parsed.kind === 'systems' || !system) {
    await chrome.runtime.openOptionsPage();
    return { action: 'options' };
  }
  if (parsed.kind !== 'query') {
    await navigate(homeUrl(system), system, disposition, cache.settings);
    await remember({ systemKey: system.key, host: targetKey(system), intent: 'Shell-home', alias: null, title: 'Launchpad home', url: homeUrl(system), input: text });
    return { action: 'home', url: homeUrl(system) };
  }
  const matches = rank(parsed, indexFor(cache, system), { limit: 1, guesser, gui: guiFor(cache, system), recentIntents: recentIntentsFor(cache, system) });
  const top = matches[0];
  if (!top) {
    const url = appFinderUrl(system);
    await navigate(url, system, disposition, cache.settings, contextTabId);
    if (cache.settings.copyUnresolved) await copyToClipboard(parsed.query); // opt-in: it replaces whatever is on the clipboard
    await remember({ systemKey: system.key, host: targetKey(system), intent: 'Shell-appfinder', alias: null, title: `App Finder (unresolved "${parsed.query}")`, url, input: text, unresolved: parsed.query });
    return { action: 'appfinder', url };
  }
  const url = buildUrl(system, top.entry, top.param);
  let availability = top.entry.onTarget; // true | false | null
  let basis = availability == null ? null : 'scan';
  if (confirm && !force) {
    const live = await liveCheck(system, [top.entry.intent]);
    if (live && live.available[top.entry.intent] != null) {
      availability = live.available[top.entry.intent];
      basis = 'live';
      await noteMismatch(system, top.entry, live);
    }
    if (availability === false) {
      return {
        action: 'blocked', basis, url, intent: top.entry.intent, title: top.entry.title, systemKey: system.key,
        scannedAt: cache.scanMeta?.[targetKey(system)]?.lastScanned || null,
      };
    }
  }
  await navigate(url, system, disposition, cache.settings, contextTabId);
  await remember({
    systemKey: system.key, host: targetKey(system), intent: top.entry.intent, alias: top.entry.alias, title: top.entry.title,
    url, input: text, param: top.param, matchType: top.type, guess: top.type === MATCH.TCODE_GUESS || top.entry.confidence === 'low',
    unavailable: availability === false ? basis : null,
  });
  return { action: 'open', url, availability, basis };
}

const plainText = (s) => String(s).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Structured resolution for the popup (no omnibox XML). */
/** Popup source filter → entry.source values; unknown or 'all' → no filter. */
const SOURCE_FILTERS = Object.freeze({ mine: ['user', 'import'], discovered: ['discovered'], seed: ['seed'], library: ['library'] });

async function resolveForPopup(text, contextHost = null, availableOnly = false, source = 'all') {
  const cache = await getCache();
  const preferredKey = systemByHost(cache.systems, contextHost)?.key ?? null;
  const parsed = parseInput(text, cache.systems, { lastUsedKey: cache.lastUsedKey, preferredKey });
  const system = parsed.system ? { key: parsed.system.key, host: parsed.system.host, target: targetKey(parsed.system), env: parsed.system.env, name: parsed.system.name } : null;
  if (parsed.kind === 'systems') {
    return { kind: 'systems', system, hint: 'Pick a system', matches: cache.systems.map((s) => ({ content: s.key, alias: s.key, title: s.name || s.host, intent: '', systemKey: s.key, tag: `${s.env} · ${s.host}` })) };
  }
  if (!system || parsed.kind !== 'query') return { kind: parsed.kind, system, hint: plainText(formatDefaultDescription(parsed)), matches: [] };
  // "available only" needs a scan to judge against; before one, every row is unverified and the filter is ignored
  const scannedAt = cache.scanMeta?.[targetKey(parsed.system)]?.lastScanned || null;
  const filtered = Boolean(availableOnly && scannedAt);
  const sources = SOURCE_FILTERS[source] || null;
  const matches = rank(parsed, indexFor(cache, parsed.system), { limit: 8, guesser, gui: guiFor(cache, parsed.system), availableOnly: filtered, sources, recentIntents: recentIntentsFor(cache, parsed.system) });
  const notice = availableOnly && !scannedAt ? `${parsed.system.key} has not been scanned yet – showing all apps`
    : filtered && !matches.length ? `No app found in the last scan of ${parsed.system.key} – turn the filter off to see everything`
    : sources && !matches.length ? `Nothing from "${source}" matches – set the source to all`
    : null;
  return {
    kind: 'query',
    system,
    hint: notice || plainText(formatDefaultDescription(parsed, matches[0] ?? null)),
    hintKind: notice ? 'notice' : 'default', // the popup shows a default hint only when Enter would do something non-obvious
    terms: { head: parsed.head, query: parsed.query }, // what the popup highlights in each row
    filtered,
    source: sources ? source : 'all',
    matches: matches.map((m) => ({
      content: formatSuggestion(m, parsed.system).content,
      alias: m.entry.alias ?? m.entry.intent,
      title: m.entry.title,
      intent: m.entry.intent,
      appId: m.entry.appId || null,
      tcodes: m.entry.tcodes || [],
      source: m.entry.source || null, // user | import | discovered | seed | library | gui
      matchType: m.type, // alias | tcode | appId | intent | tcodeGuess | keyPrefix | titlePrefix | titleFuzzy | gui
      param: m.param,
      systemKey: parsed.system.key,
      guess: m.type === MATCH.TCODE_GUESS || m.entry.confidence === 'low',
      gui: m.type === MATCH.GUI,
      onTenant: m.entry.onTarget === true,
      missing: m.entry.onTarget === false,
    })),
    scannedAt,
  };
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
/**
 * `contextTabId` is the tab the user was on when the launcher window (or popup) opened: the launcher is its own window,
 * so "the active tab of the focused window" would be the launcher itself. New tabs then open next to that tab.
 */
async function navigate(url, system, disposition, settings, contextTabId = null) {
  let tab = null;
  if (contextTabId != null) {
    try { tab = await chrome.tabs.get(contextTabId); } catch { tab = null; }
  }
  if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const where = tab?.windowId != null && contextTabId != null ? { windowId: tab.windowId } : {};
  if (disposition !== 'currentTab') {
    await chrome.tabs.create({ url, active: disposition === 'newForegroundTab', ...where });
    return;
  }
  if (tab && settings.reuseTabOnSameHost !== false && isOnTarget(tab.url, system)) {
    await chrome.tabs.update(tab.id, { url });
    if (contextTabId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    return;
  }
  await chrome.tabs.create({ url, active: true, ...where });
}

// ---------------------------------------------------------------- launcher window (keyboard command)

const LAUNCHER = { width: 640, height: 620 };

/**
 * Runs inside the page (injected with chrome.scripting, so it must be self-contained): a lightly dimmed backdrop over
 * the page (not blurred, so the page stays readable) with the launcher page floating in a frosted-glass iframe – the Spotlight look a separate window cannot have.
 * Calling it again while open closes it (the shortcut toggles). The iframe asks to be closed by posting
 * { ns: 'SAPQS', type: 'CLOSE' }; Esc and a click on the backdrop close it too.
 */
function showLauncherOverlay(src, width, height, blur = false) {
  const ID = 'sapqs-launcher';
  const existing = document.getElementById(ID);
  if (existing) { existing.remove(); return 'closed'; }
  const host = document.createElement('div');
  host.id = ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  const origin = new URL(src).origin;
  const style = document.createElement('style');
  style.textContent = `
    .back { position: fixed; inset: 0; background: rgba(15, 20, 28, ${blur ? '.28' : '.18'}); animation: sapqs-in .12s ease-out; ${blur ? 'backdrop-filter: blur(8px) saturate(1.1); -webkit-backdrop-filter: blur(8px) saturate(1.1);' : ''} } /* a light dim by default so the page stays readable; the blur is a setting */
    .panel { position: fixed; left: 50%; top: 13vh; transform: translateX(-50%); width: ${width}px; height: ${height}px; max-width: calc(100vw - 32px); max-height: calc(100vh - 15vh); border-radius: 16px; overflow: hidden; box-shadow: 0 24px 80px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.12); opacity: 0; transition: height .16s ease-out; }
    .panel.ready { animation: sapqs-pop .14s ease-out; opacity: 1; } /* shown once the launcher has reported its first size: no jump from the full height, no half-rendered stages */
    iframe { width: 100%; height: 100%; border: 0; background: transparent; color-scheme: light dark; }
    .panel { backdrop-filter: blur(18px) saturate(1.2); -webkit-backdrop-filter: blur(18px) saturate(1.2); }
    @keyframes sapqs-in { from { opacity: 0 } to { opacity: 1 } }
    @keyframes sapqs-pop { from { opacity: 0; transform: translateX(-50%) scale(.97) } to { opacity: 1; transform: translateX(-50%) scale(1) } }`;
  const back = document.createElement('div');
  back.className = 'back';
  const panel = document.createElement('div');
  panel.className = 'panel';
  const frame = document.createElement('iframe');
  frame.src = src;
  frame.setAttribute('allowtransparency', 'true');
  frame.setAttribute('title', 'slashn launcher');
  panel.appendChild(frame);
  root.append(style, back, panel);
  const close = () => { clearTimeout(fallback); host.remove(); window.removeEventListener('message', onMessage); document.removeEventListener('keydown', onKey, true); };
  const reveal = () => panel.classList.add('ready');
  const fallback = setTimeout(reveal, 700); // the launcher could not report (blocked, failed): show it anyway
  const onMessage = (ev) => {
    if (ev.origin !== origin || !ev.data || ev.data.ns !== 'SAPQS') return;
    if (ev.data.type === 'CLOSE') close();
    if (ev.data.type === 'SIZE' && Number.isFinite(ev.data.height)) {
      panel.style.height = Math.max(160, Math.min(height, Math.ceil(ev.data.height))) + 'px'; // shrink to the rows, grow up to the maximum (animated)
      clearTimeout(fallback);
      reveal();
    }
  };
  const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } };
  back.addEventListener('click', close);
  window.addEventListener('message', onMessage);
  document.addEventListener('keydown', onKey, true);
  (document.body || document.documentElement).appendChild(host);
  // the caret: focus the frame element, then tell the launcher page to focus its input (a document inside a frame that
  // was not focused when it ran its own focus() has no caret); repeat briefly, the page may still be loading
  const giveFocus = () => { try { frame.focus(); frame.contentWindow.focus(); frame.contentWindow.postMessage({ ns: 'SAPQS', type: 'FOCUS' }, origin); } catch { /* not ready */ } };
  frame.addEventListener('load', () => { giveFocus(); setTimeout(giveFocus, 60); setTimeout(giveFocus, 250); });
  giveFocus();
  return 'opened';
}

/**
 * The keyboard command: an in-page overlay (transparent, blurred) on ordinary pages, where the activeTab grant lets
 * us script the page; a small centred window on pages that cannot be scripted (chrome://, the Web Store, PDFs).
 */
async function openLauncher(clickedTab = null, note = null) {
  let win = null;
  try { win = clickedTab?.windowId != null ? await chrome.windows.get(clickedTab.windowId, { populate: true }) : await chrome.windows.getLastFocused({ windowTypes: ['normal'], populate: true }); } catch { win = null; }
  const tab = clickedTab || win?.tabs?.find((t) => t.active) || null;
  const base = chrome.runtime.getURL('src/popup/popup.html');
  // popup.html is web-accessible so the overlay can frame it, which means any web page can frame it too. The page
  // renders only after presenting this nonce (LAUNCHER_HELLO); the frame URL sits in a closed shadow root, so the
  // host page cannot read it, and a frame a web page adds on its own stays blank.
  const nonce = crypto.randomUUID();
  await storage.setLauncherNonce(nonce);
  if (tab?.id != null && /^https?:/i.test(tab.url || '')) {
    const q = new URLSearchParams({ mode: 'overlay', tab: String(tab.id), nonce });
    if (note) q.set('note', note);
    try {
      const { settings } = await getCache();
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: showLauncherOverlay, args: [`${base}?${q}`, LAUNCHER.width, LAUNCHER.height, settings.overlayBlur === true] });
      return { mode: 'overlay', tabId: tab.id, result: res?.result ?? null };
    } catch (e) {
      log('overlay not possible here, using a window', tab.url, e?.message || e);
    }
  }
  // one launcher at a time: close a stale one so the new one carries the current tab
  try {
    const open = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    for (const c of open) if (c.documentUrl?.startsWith(base + '?') && c.windowId != null) await chrome.windows.remove(c.windowId).catch(() => {});
  } catch (e) { log('getContexts unavailable', e); }
  const q = new URLSearchParams({ mode: 'launcher', nonce });
  if (tab?.id != null) q.set('tab', String(tab.id));
  if (note) q.set('note', note);
  const bounds = win && Number.isFinite(win.left) && Number.isFinite(win.width)
    ? { left: Math.max(0, Math.round(win.left + (win.width - LAUNCHER.width) / 2)), top: Math.max(0, Math.round(win.top + Math.max(0, win.height - LAUNCHER.height) / 6)) }
    : {};
  const created = await chrome.windows.create({ url: `${base}?${q}`, type: 'popup', focused: true, ...LAUNCHER, ...bounds });
  return { windowId: created?.id ?? null, tabId: tab?.id ?? null };
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

async function handleMessage(msg, sender) {
  if (sender.id !== chrome.runtime.id) return { error: 'foreign sender' };
  switch (msg.type) {
    case MSG.PAGE_READY: {
      if (!sender.tab) return { scan: false, reason: 'no tab' };
      const cache = await getCache();
      const system = systemForTab(cache.systems, sender.tab.url) ?? systemByHost(cache.systems, msg.host);
      if (!system) return { scan: false, reason: 'unregistered host' };
      const pending = await storage.getPendingRescan(targetKey(system));
      const meta = cache.scanMeta?.[targetKey(system)];
      const ageDays = meta?.lastScanned ? (Date.now() - Date.parse(meta.lastScanned)) / 86400000 : Infinity;
      const scan = pending || !meta || ageDays > cache.settings.autoScanDays;
      if (pending) await storage.setPendingRescan(targetKey(system), false);
      const reason = pending ? 'requested' : !meta ? 'never scanned' : ageDays > cache.settings.autoScanDays ? 'stale' : 'fresh';
      log('page ready', system.key, { scan, reason });
      return { scan, reason };
    }
    case MSG.DISCOVERY_RESULT: {
      // only a content script may report a scan, and only for the host its tab is on
      if (!sender?.tab) return { stored: 0, error: 'not from a tab' };
      const fromHost = (() => { try { return sender.tab.url ? new URL(sender.tab.url).host.toLowerCase() : null; } catch { return null; } })();
      if (fromHost && fromHost !== String(msg.host || '').toLowerCase()) return { stored: 0, error: 'host mismatch' };
      const cache = await getCache();
      const system = systemForTab(cache.systems, sender.tab.url) ?? systemByHost(cache.systems, msg.host);
      if (!system) return { stored: 0, error: 'unregistered host' };
      const record = sanitizeDiscoveredRecord({ scannedAt: new Date().toISOString(), ui5Version: msg.ui5Version, system: msg.system, methods: msg.methods, errors: msg.errors, entries: msg.entries });
      const { entries } = record;
      await storage.setDiscovered(targetKey(system), record);
      cachePromise = null;
      log('discovery stored', system.key, entries.length);
      const reopen = await storage.getReopenLauncher();
      if (reopen?.host === targetKey(system) && Date.now() - reopen.ts < 5 * 60000 && sender?.tab?.id != null) {
        await storage.setReopenLauncher(null);
        openLauncher(sender.tab, `Scanned ${system.key}: ${entries.length} apps`).catch((e) => warn('launcher failed', e));
      }
      return { stored: entries.length };
    }
    case MSG.RESCAN_HOST: {
      const cache = await getCache();
      const system = systemByHost(cache.systems, msg.host);
      if (!system) return { status: 'error', error: 'unregistered host' };
      // from the launcher: the reload takes the overlay with it, so bring it back once the scan has landed
      await storage.setReopenLauncher(msg.reopenLauncher ? targetKey(system) : null);
      const windowId = sender?.tab?.windowId ?? (await chrome.windows.getLastFocused().catch(() => null))?.id ?? null;
      const tab = await rescanTab(system, Number.isInteger(msg.contextTabId) ? msg.contextTabId : null, windowId);
      if (tab) {
        try {
          await chrome.tabs.sendMessage(tab.id, { type: MSG.RESCAN_TAB });
          return { status: 'messaged' };
        } catch {
          // no content script in that tab (it predates the grant): a fresh tab scans; reloading could discard unsaved work
          await storage.setPendingRescan(targetKey(system), true);
          await chrome.tabs.create({ url: homeUrl(system), active: true, ...(tab.windowId != null ? { windowId: tab.windowId } : {}) });
          return { status: 'opened' };
        }
      }
      await storage.setPendingRescan(targetKey(system), true);
      await chrome.tabs.create({ url: homeUrl(system), active: true, ...(windowId != null ? { windowId } : {}) });
      return { status: 'opened' };
    }
    case MSG.LAUNCHER_HELLO: {
      const nonce = await storage.getLauncherNonce();
      return { ok: Boolean(nonce) && typeof msg.nonce === 'string' && msg.nonce === nonce };
    }
    case MSG.GET_STATE: {
      const cache = await getCache();
      const { indexByHost, ...snapshot } = cache;
      return { snapshot };
    }
    case MSG.RESOLVE:
      return resolveForPopup(String(msg.text ?? ''), msg.contextHost || null, Boolean(msg.availableOnly), typeof msg.source === 'string' ? msg.source : 'all');
    case MSG.NAVIGATE: {
      const cache = await getCache();
      return launch(String(msg.text ?? ''), msg.disposition || 'currentTab', systemByHost(cache.systems, msg.contextHost)?.key ?? null, { confirm: true, force: Boolean(msg.force), contextTabId: Number.isInteger(msg.contextTabId) ? msg.contextTabId : null });
    }
    case MSG.LIVE_CHECK: {
      const cache = await getCache();
      const system = systemByHost(cache.systems, msg.host);
      if (!system) return { available: null, reason: 'unregistered host' };
      const intents = (Array.isArray(msg.intents) ? msg.intents : []).map(String).slice(0, 50);
      const live = await liveCheck(system, intents);
      if (!live) return { available: null, reason: 'no launchpad tab open' };
      const index = indexFor(cache, system);
      for (const ix of index) if (ix.entry.intent in live.available) await noteMismatch(system, ix.entry, live);
      return { available: live.available, reason: 'live', tabId: live.tabId };
    }
    case MSG.OPEN_URL: {
      const cache = await getCache();
      const system = systemByHost(cache.systems, msg.host) || { host: '' };
      // https always; plain http only to a registered http system (internal on-prem hosts), never javascript:/data:/file:
      let u = null;
      try { u = new URL(String(msg.url)); } catch { u = null; }
      const okScheme = u && (u.protocol === 'https:' || (u.protocol === 'http:' && systemForUrl(cache.systems, u.href)?.scheme === 'http'));
      if (!okScheme) return { error: 'bad url' };
      await navigate(u.href, system, msg.disposition || 'currentTab', cache.settings, Number.isInteger(msg.contextTabId) ? msg.contextTabId : null);
      return { action: 'open', url: u.href };
    }
    case MSG.OPEN_LAUNCHER:
      return openLauncher();
    case MSG.OPEN_SYSTEM_INFO: {
      const cache = await getCache();
      const system = systemByHost(cache.systems, msg.host);
      if (!system) return { error: 'unregistered host' };
      return openDialog('src/sysinfo/sysinfo.html', targetKey(system), SYSTEM_INFO_WINDOW);
    }
    case MSG.OPEN_DEBUG:
      return openDialog('src/debug/debug.html', msg.host ? String(msg.host) : '', DEBUG_WINDOW);
    case MSG.DEBUG_CALL: {
      const cache = await getCache();
      const system = systemByHost(cache.systems, msg.host);
      if (!system) return { error: 'unregistered host' };
      if (!debugCallById(String(msg.call))) return { error: `unknown call ${msg.call}` };
      return debugCall(system, String(msg.call), msg.params ?? null);
    }
    case MSG.PROBE_SYSTEM: {
      const cache = await getCache();
      const system = systemByHost(cache.systems, msg.host);
      if (!system) return { error: 'unregistered host' };
      return probeSystem(system);
    }
    default:
      return { ignored: true };
  }
}

// ---------------------------------------------------------------- system-info dialog

/** Opens an extension page in a small popup-type window (no tabs, no address bar); focuses it if already open for that host. */
async function openDialog(page, host, size) {
  const url = chrome.runtime.getURL(`${page}${host ? '?host=' + encodeURIComponent(host) : ''}`);
  try {
    const open = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [url] });
    const existing = open.find((c) => c.windowId != null);
    if (existing) {
      await chrome.windows.update(existing.windowId, { focused: true });
      return { windowId: existing.windowId, action: 'focused' };
    }
  } catch (e) {
    log('getContexts unavailable', e);
  }
  const win = await chrome.windows.create({ url, type: 'popup', focused: true, ...size });
  return { windowId: win?.id ?? null, action: 'opened' };
}

/** Find an open launchpad tab of `system` (active one first) and run one catalogued shell call in it. */
async function debugCall(system, call, params) {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: originPattern(system) }); } catch { tabs = []; }
  tabs = tabs.filter((t) => isOnTarget(t.url, system));
  if (!tabs.length) return { launchpad: false, reason: 'no tab' };
  tabs.sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));
  let lastError = 'cannot script the tab';
  for (const tab of tabs.slice(0, 3)) {
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: runDebugCallInPage, args: [call, params] });
      if (r && r.result && typeof r.result === 'object') return { ...r.result, tabId: tab.id };
      lastError = 'no result from the page';
    } catch (e) {
      lastError = String(e?.message || e);
    }
  }
  return { launchpad: false, reason: lastError };
}

/**
 * Read the About-dialog fields from an open launchpad tab of `system` (the same getters a scan records) and store them.
 * Needs host access, which registered systems have (manifest for *.s4hana.cloud.sap, granted at save time otherwise).
 */
async function probeSystem(system) {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: originPattern(system) }); } catch { tabs = []; }
  tabs = tabs.filter((t) => isOnTarget(t.url, system));
  if (!tabs.length) return { launchpad: false, reason: 'no tab' };
  tabs.sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));
  let reason = 'no shell';
  for (const tab of tabs.slice(0, 3)) {
    const r = await probeTab(tab.id);
    if (!r.launchpad) continue;
    await storage.setScanSystemInfo(targetKey(system), r.system, r.ui5Version);
    cachePromise = null;
    log('probed', system.key, r);
    return { launchpad: true, system: r.system, ui5Version: r.ui5Version, tabId: tab.id };
  }
  return { launchpad: false, reason };
}
