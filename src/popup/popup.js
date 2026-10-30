// slashn — toolbar popup. Same launcher as the omnibox, driven through the service worker.
import { MSG } from '../messages.js';
import { createStorage, systemFromUrl, looksLikeLaunchpad, isDefaultHost, originPattern, sanitizeSystemInfo, editionFromSystemInfo } from '../storage.js';

const storage = createStorage();

const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ error: String(e) }));

let items = [];
let selected = 0;
let seq = 0;
let contextHost = null; // host of the active tab when it is a registered system
let contextKey = null;
let tab = null;
let currentSystem = null; // system the current matches were resolved on
let pendingForce = null; // text of a launch the user must confirm (target reported unavailable)
let liveSeq = 0;
let recent = []; // all recent launches; the list shows only those on the current tab's system

const fmtDate = (iso) => { try { return iso ? new Date(iso).toLocaleDateString() : ''; } catch { return ''; } };

let probed = null; // { launchpad: bool, system: About-dialog fields|null } for the active tab

/** activeTab lets us ask the page itself whether it is a Fiori launchpad, and read what its About dialog would show. */
async function probeLaunchpad(tabId) {
  if (probed) return probed;
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => {
      const c = window.sap && window.sap.ushell && window.sap.ushell.Container;
      if (!c) return { launchpad: false, system: null };
      const out = {};
      try {
        const sys = c.getLogonSystem && c.getLogonSystem();
        for (const [k, g] of [['productName', 'getProductName'], ['productVersion', 'getProductVersion'], ['systemName', 'getSystemName'], ['systemRole', 'getSystemRole'], ['tenantRole', 'getTenantRole'], ['client', 'getClient']]) {
          try { const v = sys && typeof sys[g] === 'function' ? sys[g]() : undefined; if (typeof v === 'string') out[k] = v; } catch { /* optional */ }
        }
      } catch { /* no logon system */ }
      return { launchpad: true, system: out };
    } });
    probed = { launchpad: Boolean(r?.result?.launchpad), system: sanitizeSystemInfo(r?.result?.system) };
  } catch {
    probed = { launchpad: false, system: null };
  }
  return probed;
}

async function init() {
  $('#options').addEventListener('click', () => chrome.runtime.openOptionsPage());
  const input = $('#q');
  input.addEventListener('input', () => resolve(input.value));
  input.addEventListener('keydown', onKey);
  input.focus();

  const state = await send({ type: MSG.GET_STATE });
  const snap = state?.snapshot || { systems: [], recent: [] };
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  recent = snap.recent || [];
  await describeTab(snap);
  renderRecent();
  resolve(input.value); // not '' – the user may already have typed while the tab probe ran
}

async function describeTab(snap) {
  const input = $('#q');
  let host = '';
  try { host = tab?.url ? new URL(tab.url).host.toLowerCase() : ''; } catch { host = ''; }
  const current = snap.systems.find((s) => s.host === host);
  contextHost = current ? current.host : null;
  contextKey = current ? current.key : null;
  if (current) {
    $('#current').innerHTML = `Searching <b>${esc(current.key)}</b> ${esc(current.name || '')}<span class="env ${esc(current.env)}">${esc(current.env)}</span>`;
    input.placeholder = `alias [value] – or <system> alias for another system`;
    return;
  }
  const isSap = tab?.url && /^https?:/.test(tab.url) && (looksLikeLaunchpad(tab.url) || (await probeLaunchpad(tab.id)).launchpad);
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
  const info = (await probeLaunchpad(tab.id)).system; // About-dialog product version beats the hostname guess
  const detected = editionFromSystemInfo(info);
  if (detected) sys.edition = detected;
  // permission request must start inside the click gesture
  const access = isDefaultHost(sys.host) || !chrome.permissions?.request ? Promise.resolve(true) : chrome.permissions.request({ origins: [originPattern(sys)] }).catch(() => false);
  const systems = [...(await storage.getSystems()), sys];
  await storage.setSystems(systems);
  const granted = await access;
  const state = await send({ type: MSG.GET_STATE });
  await describeTab(state?.snapshot || { systems, recent: [] });
  renderRecent();
  $('#hint').textContent = granted ? `Added "${sys.key}" (${sys.host}); reload the tab once to start discovery` : `Added "${sys.key}" – site access not granted, discovery disabled until you grant it in options`;
  resolve($('#q').value);
}

async function resolve(text) {
  const mySeq = ++seq;
  const r = await send({ type: MSG.RESOLVE, text, contextHost });
  if (mySeq !== seq || !r || r.error) return;
  items = r.matches || [];
  selected = 0;
  currentSystem = r.system || null;
  pendingForce = null;
  $('#hint').textContent = r.hint || '';
  renderList();
  liveCheck(r);
}

/** Ask an open launchpad tab of the target system whether this session can reach each suggested intent. */
async function liveCheck(r) {
  const mySeq = ++liveSeq;
  if (!r.system?.host || !items.length) return;
  const intents = [...new Set(items.map((m) => m.intent).filter(Boolean))];
  const live = await send({ type: MSG.LIVE_CHECK, host: r.system.host, intents });
  if (mySeq !== liveSeq || !live?.available) return;
  for (const m of items) if (m.intent in live.available) m.live = live.available[m.intent];
  renderList();
}

function availabilityChip(m) {
  if (m.live === true) return ' <span class="chip live" title="Live check against your open launchpad tab">available</span>';
  if (m.live === false) return ' <span class="chip missing" title="Live check: your session cannot open this intent">not available</span>';
  if (m.onTenant) return ' <span class="chip tenant" title="Found in the last scan">tenant</span>';
  if (m.missing) return ` <span class="chip missing" title="Not found in the last scan of ${esc(m.systemKey)}">not on ${esc(m.systemKey)}</span>`;
  return '';
}

function renderList() {
  const ul = $('#list');
  ul.innerHTML = items.map((m, i) => `<li class="${i === selected ? 'sel' : ''}" data-i="${i}">
    <span class="key">${esc(m.alias)}</span><span class="title">${esc(m.title)}</span>
    <span class="tag">${esc(m.intent || m.tag || '')}${m.guess ? ' <span class="chip guess">guess</span>' : ''}${availabilityChip(m)}</span></li>`).join('');
  ul.querySelectorAll('li').forEach((li) => {
    li.addEventListener('click', (ev) => go(items[Number(li.dataset.i)].content, ev.metaKey || ev.ctrlKey ? 'newForegroundTab' : 'currentTab'));
  });
}

/** On a registered system only that system's launches are listed; elsewhere every system's, tagged with its key. */
function renderRecent() {
  const ul = $('#recent');
  const current = contextHost ? recent.filter((r) => r.host === contextHost) : recent;
  const list = current.slice(0, 10);
  $('#recent-title').textContent = contextKey ? `Recent on ${contextKey}` : 'Recent';
  ul.innerHTML = list.map((r, i) => `<li data-i="${i}"><span class="key">${esc(r.input)}</span><span class="title">${esc(r.title)}</span>${contextHost ? '' : `<span class="tag">${esc(r.systemKey)}</span>`}</li>`).join('')
    || `<li class="empty">${contextHost ? 'Nothing launched on this system yet.' : 'Nothing launched yet.'}</li>`;
  ul.querySelectorAll('li[data-i]').forEach((li) => {
    li.addEventListener('click', async (ev) => {
      const r = list[Number(li.dataset.i)];
      await send({ type: MSG.OPEN_URL, url: r.url, host: r.host, disposition: ev.metaKey || ev.ctrlKey ? 'newForegroundTab' : 'currentTab' });
      window.close();
    });
  });
}

function onKey(ev) {
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    if (!items.length) return;
    selected = (selected + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    renderList();
    return;
  }
  if (ev.key === 'Enter') {
    ev.preventDefault();
    const text = items[selected]?.content ?? $('#q').value;
    go(text, ev.metaKey || ev.ctrlKey ? 'newForegroundTab' : 'currentTab');
    return;
  }
  if (ev.key === 'Escape') window.close();
}

async function go(text, disposition) {
  // Empty input is meaningful: launchpad home on the default system, or the options page when nothing is configured.
  const t = String(text ?? '');
  const force = pendingForce === t;
  const r = await send({ type: MSG.NAVIGATE, text: t, disposition, contextHost, force });
  if (r?.error) { $('#hint').textContent = r.error; return; }
  if (r?.action === 'blocked') {
    pendingForce = t;
    const why = r.basis === 'live'
      ? `your session cannot open it right now (live check in the open ${r.systemKey} tab)`
      : `it was not found in the last scan of ${r.systemKey}${r.scannedAt ? ' on ' + fmtDate(r.scannedAt) : ''}`;
    $('#hint').textContent = `${r.title}: ${why}. Press Enter again to open anyway.`;
    return;
  }
  window.close();
}

init().catch((e) => { $('#hint').textContent = 'Failed: ' + (e.message || e); });
