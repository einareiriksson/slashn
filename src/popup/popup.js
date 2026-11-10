// slashn — toolbar popup. Same launcher as the omnibox, driven through the service worker.
import { MSG } from '../messages.js';
import { createStorage, systemFromUrl, systemForUrl, targetKey, looksLikeLaunchpad, isDefaultHost, originPattern, editionFromSystemInfo } from '../storage.js';
import { probeTab } from '../probe.js';

const storage = createStorage();

const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ error: String(e) }));

let items = [];
let rows = []; // items grouped: sibling app variants (f1492, f1492-2 …) become one row with action chips
let selected = 0; // index into rows
let variantSel = []; // per row: which variant chip is chosen
let seq = 0;
let contextHost = null; // host of the active tab when it is a registered system
let contextKey = null;
let tab = null;
let currentSystem = null; // system the current matches were resolved on
let terms = { head: '', query: '' }; // what was typed, for highlighting the matched characters in each row
let systems = []; // registered systems, for Tab cycling the target system
let pendingForce = null; // text of a launch the user must confirm (target reported unavailable)
let hintHold = false; // the hint shows a question (scan now?) that resolving must not overwrite until answered or the user types
let liveSeq = 0;
let recent = []; // all recent launches; the list shows only those on the current tab's system
const PARAMS = new URLSearchParams(location.search);
const LAUNCHER_MODE = PARAMS.get('mode') === 'launcher'; // opened as a centred window by the keyboard command
const OVERLAY_MODE = PARAMS.get('mode') === 'overlay'; // embedded in a page overlay by the keyboard command
const LAUNCHER_TAB = Number(PARAMS.get('tab')) || null; // the tab the user was on; "current tab" launches go there
const NOTE = PARAMS.get('note') || ''; // a one-line message to show on open (e.g. the result of the scan that just ran)
let availableOnly = false; // popup filter: only apps the last scan found on the system (remembered per browser)
let sourceFilter = 'all'; // popup filter: all | mine | discovered | seed | library (remembered per browser)

const fmtDate = (iso) => { try { return iso ? new Date(iso).toLocaleDateString() : ''; } catch { return ''; } };

let probed = null; // { launchpad: bool, system: About-dialog fields|null } for the active tab

/** activeTab lets us ask the page itself whether it is a Fiori launchpad, and read what its About dialog would show. */
async function probeLaunchpad(tabId) {
  if (!probed) probed = await probeTab(tabId);
  return probed;
}

/** Not opened by the worker (a stale frame, a page framing us, the file opened by hand): show how to open it and nothing else. */
function refuse() {
  document.body.textContent = '';
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = 'Open slashn from its toolbar button or with the keyboard shortcut (Alt+Shift+S).';
  document.body.appendChild(p);
  try { window.parent.postMessage({ ns: 'SAPQS', type: 'CLOSE' }, '*'); } catch { /* no parent */ }
}

async function init() {
  $('#options').addEventListener('click', () => chrome.runtime.openOptionsPage());
  const input = $('#q');
  input.addEventListener('input', () => { hintHold = false; updateRecentVisibility(); resolve(input.value); });
  input.addEventListener('keydown', onKey);
  input.focus();
  if (OVERLAY_MODE) {
    // inside the page overlay the frame gets focus from its host page, which then asks us to place the caret
    const focusInput = () => { if (document.activeElement !== input) input.focus(); };
    window.addEventListener('message', (ev) => { if (ev.data && ev.data.ns === 'SAPQS' && ev.data.type === 'FOCUS') focusInput(); });
    window.addEventListener('focus', focusInput);
    for (const ms of [50, 150, 400]) setTimeout(focusInput, ms);
  }
  try { availableOnly = localStorage.getItem('slashn-available-only') === '1'; } catch { availableOnly = false; }
  const source = $('#source');
  try { sourceFilter = localStorage.getItem('slashn-source') || 'all'; } catch { sourceFilter = 'all'; }
  if (![...source.options].some((o) => o.value === sourceFilter)) sourceFilter = 'all';
  source.value = sourceFilter;
  source.addEventListener('change', () => {
    sourceFilter = source.value;
    try { localStorage.setItem('slashn-source', sourceFilter); } catch { /* optional */ }
    resolve(input.value);
    input.focus();
  });
  const avail = $('#avail');
  avail.setAttribute('aria-pressed', String(availableOnly));
  avail.addEventListener('click', () => {
    availableOnly = !availableOnly;
    avail.setAttribute('aria-pressed', String(availableOnly));
    try { localStorage.setItem('slashn-available-only', availableOnly ? '1' : '0'); } catch { /* optional */ }
    resolve(input.value);
    input.focus();
  });

  if (LAUNCHER_MODE || OVERLAY_MODE) {
    document.body.classList.add('launcher');
    if (OVERLAY_MODE) document.body.classList.add('overlay');
    document.title = 'slashn';
    // a Spotlight-like window goes away when it loses focus (after a grace period: opening it can blur it once);
    // in the overlay the backdrop click does that job
    if (LAUNCHER_MODE) setTimeout(() => window.addEventListener('blur', () => closeSelf()), 400);
  }
  // This page is web-accessible so the overlay can frame it, so a web page could frame it too and clickjack its
  // buttons. Only a frame the worker opened carries the current nonce: without it nothing is rendered or fetched.
  const hello = await send({ type: MSG.LAUNCHER_HELLO, nonce: PARAMS.get('nonce') || '' });
  if (!hello?.ok) { refuse(); return; }
  const state = await send({ type: MSG.GET_STATE });
  const snap = state?.snapshot || { systems: [], recent: [] };
  systems = snap.systems || [];
  renderKeys();
  if (LAUNCHER_TAB) { try { tab = await chrome.tabs.get(LAUNCHER_TAB); } catch { tab = null; } }
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  recent = snap.recent || [];
  await describeTab(snap);
  renderRecent();
  if (NOTE) { hintHold = true; $('#hint').textContent = NOTE; }
  if (OVERLAY_MODE) {
    // the host page sizes the panel to our content and keeps it hidden until the first report, so it is sent only now,
    // once header, recents and note are in place (no half-rendered stages); later changes are coalesced per frame
    let pending = 0;
    const report = () => {
      if (pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        try { window.parent.postMessage({ ns: 'SAPQS', type: 'SIZE', height: Math.ceil(document.body.getBoundingClientRect().height) }, '*'); } catch { /* no parent */ }
      });
    };
    new ResizeObserver(report).observe(document.body);
    report();
  }
  resolve(input.value); // not '' – the user may already have typed while the tab probe ran
}

async function describeTab(snap) {
  const input = $('#q');
  let host = '';
  try { host = tab?.url ? new URL(tab.url).host.toLowerCase() : ''; } catch { host = ''; }
  const current = systemForUrl(snap.systems, tab?.url); // host and, where systems differ by client, the URL's sap-client
  contextHost = current ? targetKey(current) : null;
  contextKey = current ? current.key : null;
  const info = $('#sysinfo');
  info.hidden = !current;
  document.body.dataset.env = current ? current.env : '';
  const header = $('#current');
  header.classList.toggle('clickable', Boolean(current));
  header.title = current ? 'Open system info' : '';
  header.onclick = null;
  if (current) {
    // primary: the registry display name; without one, the tenant label derived from the host (my420635 for
    // my420635.s4hana.cloud.sap, acd for acd.finteq.io:8443) so it is always shorter than the host on the second line;
    // the key is added there only when neither line says it – never the same identifier twice
    const pill = `<span class="env ${esc(current.env)}">${esc(current.env)}</span>`;
    // "Add as system" names a system after its host: that is no display name, so it takes the one-line form too
    const name = current.name && current.name.trim().toLowerCase() !== current.host.toLowerCase() ? current.name.trim() : '';
    const said = (v) => (name + ' ' + current.host).toLowerCase().includes(v.toLowerCase());
    const key = said(current.key) ? '' : ` · ${esc(current.key)}`;
    if (name) {
      header.innerHTML = `<div class="sysname">${esc(name)}${pill}</div><div class="syshost">${esc(current.host)}${key}</div>`;
    } else {
      // no display name: one line – the system key as primary (it is what you type), the host dim after it
      header.innerHTML = `<div class="sysname">${esc(current.key)}${pill} <span class="syshost inline">${esc(current.host)}</span></div>`;
    }
    const openInfo = async () => { await send({ type: MSG.OPEN_SYSTEM_INFO, host: targetKey(current) }); closeSelf(); };
    info.onclick = openInfo;
    header.onclick = openInfo; // the header is the system: clicking it opens the system-info panel too
    input.placeholder = `alias [value] – or <system> alias for another system`;
    return;
  }
  let isSap = false;
  try {
    isSap = Boolean(tab?.url && /^https?:/.test(tab.url) && (looksLikeLaunchpad(tab.url) || (await probeLaunchpad(tab.id)).launchpad));
  } catch (e) {
    console.warn('tab probe failed', e); // not scriptable (chrome://, store, PDF): treat as a plain page
  }
  if (isSap) {
    $('#current').innerHTML = `SAP launchpad detected: <b>${esc(host)}</b> <button id="add-current" class="small">Add as system</button>`;
    $('#add-current').addEventListener('click', () => addCurrent(snap).catch((e) => { $('#hint').textContent = 'Could not add: ' + (e.message || e); }));
    return;
  }
  $('#current').innerHTML = snap.systems.length
    ? `<span class="muted">Not on a registered tenant · default: ${esc(snap.systems.find((s) => s.isDefault)?.key || snap.systems[0].key)}</span>`
    : '<span class="muted">No systems configured – paste a launchpad URL in options, or open one and click the icon</span>';
}

async function addCurrent(snap) {
  const sys = systemFromUrl(tab.url, snap.systems);
  if (!sys) throw new Error('unrecognised URL');
  // The permission request must start synchronously inside the click, before any await (the probe below would end
  // the user gesture and Chrome would refuse the prompt, leaving the system without site access).
  let denied = '';
  const access = isDefaultHost(sys.host) || !chrome.permissions?.request
    ? Promise.resolve(true)
    : chrome.permissions.request({ origins: [originPattern(sys)] }).catch((e) => { denied = e?.message || String(e); return false; });
  const info = (await probeLaunchpad(tab.id)).system; // About-dialog product version beats the hostname guess
  const detected = editionFromSystemInfo(info);
  if (detected) sys.edition = detected;
  const granted = await access; // the system is written only once the user has answered the prompt, not before
  const systems = [...(await storage.getSystems()), sys];
  await storage.setSystems(systems);
  const state = await send({ type: MSG.GET_STATE });
  await describeTab(state?.snapshot || { systems, recent: [] });
  renderRecent();
  resolve($('#q').value); // first, so its hint cannot overwrite the question below
  if (granted) askScan(sys);
  else askAccess(sys, denied);
}

/** Site access was refused or could not be asked for: say so, and offer the request again from a fresh click. */
function askAccess(sys, reason) {
  const hint = $('#hint');
  hintHold = true;
  hint.innerHTML = `Added <b>${esc(sys.key)}</b>, but slashn has no access to ${esc(sys.host)} yet${reason ? ` (${esc(reason)})` : ''}, so it cannot scan it. <button id="grant-now" class="small">Grant access</button>`;
  $('#grant-now').addEventListener('click', () => {
    chrome.permissions.request({ origins: [originPattern(sys)] }).then((ok) => { hintHold = false; if (ok) askScan(sys); else hint.textContent = `Access to ${sys.host} not granted – grant it on the options page, then Rescan`; }, (e) => { hintHold = false; hint.textContent = 'Could not ask for access: ' + (e?.message || e); });
  });
}

/** First add: offer to scan the new system now (reloads this tab so the content script can read the launchpad). */
function askScan(sys) {
  const hint = $('#hint');
  hintHold = true;
  hint.innerHTML = `Added <b>${esc(sys.key)}</b>. Scan its apps now? <button id="scan-now" class="small">Scan now</button> <button id="scan-later" class="small">Later</button>`;
  $('#scan-now').addEventListener('click', async () => {
    hintHold = false;
    const r = await send({ type: MSG.RESCAN_HOST, host: targetKey(sys), reopenLauncher: true, contextTabId: tab?.id ?? null }); // this tab is scanned; the launcher comes back when the scan has landed
    hint.textContent = r?.status === 'messaged' ? 'Scanning…' : r?.status === 'reloaded' || r?.status === 'opened' ? 'Launchpad reloading – scanning when it loads, then the launcher reopens' : (r?.error || 'Scan failed');
  });
  $('#scan-later').addEventListener('click', () => { hintHold = false; hint.textContent = `Added "${sys.key}"; the first launchpad load scans it (or use Rescan in options)`; });
}

async function resolve(text) {
  const mySeq = ++seq;
  const r = await send({ type: MSG.RESOLVE, text, contextHost, availableOnly, source: sourceFilter });
  if (mySeq !== seq || !r || r.error) return;
  items = r.matches || [];
  rows = groupItems(items, r.terms?.head || '');
  selected = 0;
  currentSystem = r.system || null;
  terms = r.terms || { head: '', query: '' };
  renderKeys();
  pendingForce = null;
  // The "Open <code> <title> [system · host]" line only earns its place when Enter does something non-obvious: the
  // launch targets another system than the tab (so it opens there, in a new tab) – or when it carries a notice.
  const elsewhere = Boolean(r.system?.host) && (r.system.target || r.system.host) !== contextHost;
  const show = r.hintKind === 'notice' || (r.kind === 'query' && elsewhere) || (r.kind !== 'query' && text.trim() && elsewhere);
  if (!hintHold) $('#hint').textContent = show && text.trim() ? (r.hint || '') : '';
  renderList();
  liveCheck(r);
}

/** Ask an open launchpad tab of the target system whether this session can reach each suggested intent. */
async function liveCheck(r) {
  const mySeq = ++liveSeq;
  if (!r.system?.host || !items.length) return;
  const intents = [...new Set(items.map((m) => m.intent).filter(Boolean))];
  const live = await send({ type: MSG.LIVE_CHECK, host: r.system.target || r.system.host, intents });
  if (mySeq !== liveSeq || !live?.available) return;
  for (const m of items) if (m.intent in live.available) m.live = live.available[m.intent];
  renderList();
}

/**
 * Availability is the normal case, so it gets no badge: only entries the system does not offer are marked, as a grey
 * "not assigned" (a live answer from an open tab says "not available" instead). With the "available only" filter on,
 * nothing can be unavailable, so no badge at all. The tooltip says whether the answer is from the scan or a live check.
 */
function availabilityChip(m) {
  if (availableOnly) return '';
  if (m.live === false) return ' <span class="chip missing" title="Live check: your session cannot open this in the open launchpad tab">not available</span>';
  if (m.live === true || m.onTenant) return '';
  if (m.missing) return ` <span class="chip unassigned" title="Not found in the last scan of ${esc(m.systemKey)}: the app is not assigned to your user there">not assigned</span>`;
  return '';
}

const KEYED = new Set(['alias', 'tcode', 'appId', 'intent', 'tcodeGuess', 'keyPrefix', 'gui']);

/** Escapes `text` and wraps the characters that `words` match in <mark>: at word starts first, anywhere as a fallback. */
function mark(text, words) {
  const s = String(text ?? '');
  const list = [...new Set((words || []).map((w) => String(w || '').toLowerCase()).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!list.length) return esc(s);
  const lower = s.toLowerCase();
  const hits = new Array(s.length).fill(false);
  for (const w of list) {
    let found = false;
    let i = lower.indexOf(w);
    while (i >= 0) {
      if (i === 0 || !/[a-z0-9]/i.test(lower[i - 1])) { hits.fill(true, i, i + w.length); found = true; }
      i = lower.indexOf(w, i + 1);
    }
    if (!found && (i = lower.indexOf(w)) >= 0) hits.fill(true, i, i + w.length);
  }
  let out = '';
  let open = false;
  for (let i = 0; i < s.length; i++) {
    if (hits[i] && !open) { out += '<mark>'; open = true; }
    if (!hits[i] && open) { out += '</mark>'; open = false; }
    out += esc(s[i]);
  }
  return open ? out + '</mark>' : out;
}

/**
 * Sibling library rows share an app ID and carry generated codes (f1492, f1492-2, f1492-4): one row per app, the
 * variants as chips. Rows with a real alias of their own (me21n, po, user aliases) stay separate.
 */
function groupItems(list, head) {
  const out = [];
  const byApp = new Map();
  const generated = (m) => m.appId && new RegExp(`^${m.appId.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-\\d+)?$`).test(String(m.alias || '').toLowerCase());
  for (const m of list) {
    const key = generated(m) ? m.appId.toLowerCase() : null;
    if (key && byApp.has(key)) { byApp.get(key).variants.push(m); continue; }
    const row = { key: key || String(m.alias || ''), title: m.title, variants: [m], grouped: Boolean(key), source: m.source };
    out.push(row);
    if (key) byApp.set(key, row);
  }
  variantSel = out.map((row) => Math.max(0, row.variants.findIndex((v) => String(v.alias || '').toLowerCase() === head.toLowerCase())));
  return out;
}

/** 'displayFactSheet' → 'display fact sheet'; the action part of an intent is the variant's label. */
function actionLabel(m) {
  const action = String(m.intent || '').split('-')[1] || m.intent || '';
  return action.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase();
}

/** 'DebitMemoRequest' → 'debit memo request' */
function objectLabel(m) {
  const so = String(m.intent || '').split('-')[0] || '';
  return so.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase();
}

const chosen = () => rows[selected]?.variants[variantSel[selected] || 0] || null;

/** The Recent section only while the query is empty-ish: hidden as soon as there are results or 3+ characters typed. */
function updateRecentVisibility() {
  const hide = items.length > 0 || $('#q').value.trim().length >= 3;
  $('#recent-title').hidden = hide;
  $('#recent').hidden = hide;
}

function renderList() {
  updateRecentVisibility();
  const ul = $('#list');
  const head = terms.head || '';
  const words = (terms.query || '').split(/\s+/).filter(Boolean);
  // two lines per hit: the key you type in front, then the title, and below it the intent (plus the Fiori app ID when it
  // differs, and the t-code when that is what matched). The matched characters are highlighted where the match happened:
  // keyed matches in the key / app ID / t-code / intent, title matches in the title.
  const keyed = (m) => KEYED.has(m.matchType);
  const SOURCE_LABEL = { user: 'my alias', import: 'imported alias', discovered: `discovered on ${esc(currentSystem?.key || 'this system')}`, seed: 'built-in alias', library: 'app library', gui: 'SAP GUI transaction' };
  // no human-readable title: the intent is the title, and the subtitle says where the row comes from instead of repeating it
  const untitled = (m) => !m.title || String(m.title).trim().toLowerCase() === String(m.intent || '').toLowerCase();
  const subParts = (m) => {
    const parts = [untitled(m) ? (SOURCE_LABEL[m.source] || m.source || '') : (m.intent || m.tag || '')];
    if (m.appId && m.appId.toLowerCase() !== String(m.alias || '').toLowerCase()) parts.push(m.appId.toLowerCase()); // same case as the code column
    const tc = m.matchType === 'tcode' ? (m.tcodes || []).find((t) => t.toLowerCase() === head.toLowerCase()) : null;
    if (tc) parts.push(`t-code ${tc.toUpperCase()}`);
    return parts.filter(Boolean);
  };
  const mine = (m) => (m.source === 'user' || m.source === 'import' ? '<span class="mine" title="My alias">●</span>' : '');
  ul.innerHTML = rows.map((row, i) => {
    const v = row.variants[variantSel[i] || 0];
    const labels = row.variants.map(actionLabel);
    const label = (x, j) => (labels.filter((l) => l === labels[j]).length > 1 ? `${objectLabel(x)} · ${labels[j]}` : labels[j]); // same action twice: say the object too
    const chips = row.variants.length > 1 && i === selected
      ? `<span class="chips">${row.variants.map((x, j) => `<button type="button" class="vchip ${j === (variantSel[i] || 0) ? 'on' : ''}" data-i="${i}" data-v="${j}" title="${esc(x.intent)}">${keyed(x) ? mark(label(x, j), [head]) : esc(label(x, j))}</button>`).join('')}</span>`
      : '';
    const count = row.variants.length > 1 && i !== selected ? ` <span class="count">· ${row.variants.length} actions</span>` : '';
    const keyHtml = row.grouped ? (keyed(v) && String(v.alias || '').toLowerCase().startsWith(head.toLowerCase()) ? mark(row.key, [head]) : esc(row.key)) : (keyed(v) ? mark(v.alias, [head]) : esc(v.alias));
    const parts = row.grouped ? subParts(v).filter((p) => p.toLowerCase() !== String(v.appId || '').toLowerCase()) : subParts(v);
    return `<li class="${i === selected ? 'sel' : ''}" data-i="${i}">
    <span class="key ${v.source === 'user' || v.source === 'import' ? 'user' : ''}" title="${esc(row.grouped ? row.key : v.alias)}${v.source === 'user' ? ' – my alias' : ''}">${mine(v)}${keyHtml}</span>
    <span class="body"><span class="title" title="${esc(v.title)}">${keyed(v) ? esc(v.title) : mark(v.title, words)}</span>
    <span class="sub">${parts.map((p) => (keyed(v) ? mark(p, [head]) : esc(p))).join(' · ')}${count}${v.guess ? ' <span class="chip guess">guess</span>' : ''}${v.gui ? ' <span class="chip" title="Opens the transaction in SAP GUI for HTML">SAP GUI</span>' : ''}${availabilityChip(v)}</span>${chips}</span></li>`;
  }).join('');
  ul.querySelector('li.sel')?.scrollIntoView({ block: 'nearest' });
  renderKeys();
  ul.querySelectorAll('li').forEach((li) => {
    li.addEventListener('click', (ev) => {
      const i = Number(li.dataset.i);
      const chip = ev.target.closest('.vchip');
      if (chip) { variantSel[i] = Number(chip.dataset.v); selected = i; }
      go(rows[i].variants[variantSel[i] || 0].content, ev.metaKey || ev.ctrlKey ? 'newForegroundTab' : 'currentTab');
    });
  });
}

/** On a registered system only that system's launches are listed; elsewhere every system's, tagged with its key. */
/** Recent launches across all systems, each tagged with its system; shown only while the query has no results. */
function renderRecent() {
  const ul = $('#recent');
  const list = recent.slice(0, 5);
  $('#recent-title').textContent = 'Recent';
  // the tag names the system, so drop the key the user may have typed in front of the alias
  const label = (r) => (r.systemKey ? String(r.input || '').replace(new RegExp('^' + r.systemKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+', 'i'), '') : r.input);
  ul.innerHTML = list.map((r, i) => `<li data-i="${i}"><span class="key" title="${esc(label(r) || r.input)}">${esc(label(r) || r.input)}</span><span class="title">${esc(r.title)}</span><span class="tag systag">${esc(r.systemKey)}</span></li>`).join('')
    || '<li class="empty">Nothing launched yet.</li>';
  updateRecentVisibility();
  ul.querySelectorAll('li[data-i]').forEach((li) => {
    li.addEventListener('click', async (ev) => {
      const r = list[Number(li.dataset.i)];
      await send({ type: MSG.OPEN_URL, url: r.url, host: r.host, disposition: ev.metaKey || ev.ctrlKey ? 'newForegroundTab' : 'currentTab', contextTabId: tab?.id ?? null });
      closeSelf();
    });
  });
}

/** Icon-only keyboard hints with tooltips; the Tab hint names the system one Tab away. */
function renderKeys() {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
  const next = nextSystem(false);
  const grouped = (rows[selected]?.variants.length || 0) > 1;
  const hints = [['↵', 'open', 'Enter opens the selected app'], [mac ? '⌘↵' : 'Ctrl↵', 'new tab', 'Opens it in a new tab'], ...(grouped ? [['←/→', 'action', 'Left and right pick the action of the selected app']] : []), ...(next ? [[`⇥ ${esc(next.key.length > 8 ? next.key.slice(0, 7) + '…' : next.key)}`, '', `Tab switches the target system to ${esc(next.key)} (Shift+Tab goes back)`]] : []), ['esc', 'close', 'Closes the launcher']];
  $('#keys').innerHTML = hints.map(([k, w, tip]) => `<span class="hintpair" title="${tip}"><kbd>${k}</kbd>${w ? ` ${w}` : ''}</span>`).join('');
}

/** The system Tab would switch to, given the text in the box. */
function nextSystem(backwards) {
  if (systems.length < 2) return null;
  const m = /^(\S+)(\s+|$)/.exec($('#q').value);
  const keys = systems.map((s) => s.key.toLowerCase()); // keys keep their case; matching ignores it
  const currentKey = (m && keys.includes(m[1].toLowerCase()) ? m[1] : (currentSystem?.key || contextKey || systems.find((s) => s.isDefault)?.key || keys[0])).toLowerCase();
  const idx = keys.indexOf(currentKey);
  return systems[(idx + (backwards ? keys.length - 1 : 1)) % keys.length];
}

/** Tab cycles the target system: replaces a leading system key, or puts the next one in front (Shift+Tab goes back). */
function cycleSystem(backwards) {
  const target = nextSystem(backwards);
  if (!target) return;
  const input = $('#q');
  const text = input.value;
  const m = /^(\S+)(\s+|$)/.exec(text);
  const keys = systems.map((s) => s.key.toLowerCase());
  const next = target.key;
  const rest = m && keys.includes(m[1].toLowerCase()) ? text.slice(m[0].length) : text;
  input.value = `${next} ${rest}`.replace(/\s+$/, rest ? '' : ' ');
  input.setSelectionRange(input.value.length, input.value.length);
  hintHold = false;
  resolve(input.value);
}

function onKey(ev) {
  if (ev.key === 'Tab') {
    ev.preventDefault();
    cycleSystem(ev.shiftKey);
    return;
  }
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    if (!rows.length) return;
    selected = (selected + (ev.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
    renderList();
    return;
  }
  if ((ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') && rows[selected]?.variants.length > 1) {
    // ←/→ pick the action chip of the selected row (plain arrows still move the caret on single-variant rows)
    ev.preventDefault();
    const n = rows[selected].variants.length;
    variantSel[selected] = ((variantSel[selected] || 0) + (ev.key === 'ArrowRight' ? 1 : n - 1)) % n;
    renderList();
    return;
  }
  if (ev.key === 'Enter') {
    ev.preventDefault();
    const text = chosen()?.content ?? $('#q').value;
    go(text, ev.metaKey || ev.ctrlKey ? 'newForegroundTab' : 'currentTab');
    return;
  }
  if (ev.key === 'Escape') closeSelf();
}

async function go(text, disposition) {
  // Empty input is meaningful: launchpad home on the default system, or the options page when nothing is configured.
  const t = String(text ?? '');
  const force = pendingForce === t;
  const r = await send({ type: MSG.NAVIGATE, text: t, disposition, contextHost, force, contextTabId: tab?.id ?? null });
  if (r?.error) { $('#hint').textContent = r.error; return; }
  if (r?.action === 'blocked') {
    pendingForce = t;
    const why = r.basis === 'live'
      ? `your session cannot open it right now (live check in the open ${r.systemKey} tab)`
      : `it was not found in the last scan of ${r.systemKey}${r.scannedAt ? ' on ' + fmtDate(r.scannedAt) : ''}`;
    $('#hint').textContent = `${r.title}: ${why}. Press Enter again to open anyway.`;
    return;
  }
  closeSelf();
}

/** The toolbar popup and the launcher window close themselves; the page overlay asks its host page to remove it. */
function closeSelf() {
  if (OVERLAY_MODE) { try { window.parent.postMessage({ ns: 'SAPQS', type: 'CLOSE' }, '*'); } catch { /* no parent */ } return; }
  window.close();
}

init().catch((e) => { $('#hint').textContent = 'Failed: ' + (e.message || e); });
