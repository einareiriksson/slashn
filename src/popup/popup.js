// slashn — toolbar popup. Same launcher as the omnibox, driven through the service worker.
import { MSG } from '../messages.js';
import { createStorage, systemFromUrl, looksLikeLaunchpad, isDefaultHost, originPattern } from '../storage.js';

const storage = createStorage();

const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ error: String(e) }));

let items = [];
let selected = 0;
let seq = 0;
let contextHost = null; // host of the active tab when it is a registered system
let tab = null;

/** activeTab lets us ask the page itself whether it is a Fiori launchpad. */
async function probeLaunchpad(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => Boolean(window.sap && window.sap.ushell) });
    return Boolean(r?.result);
  } catch {
    return false;
  }
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
  await describeTab(snap);
  renderRecent(snap.recent || []);
  resolve('');
}

async function describeTab(snap) {
  const input = $('#q');
  let host = '';
  try { host = tab?.url ? new URL(tab.url).host.toLowerCase() : ''; } catch { host = ''; }
  const current = snap.systems.find((s) => s.host === host);
  contextHost = current ? current.host : null;
  if (current) {
    $('#current').innerHTML = `Searching <b>${esc(current.key)}</b> ${esc(current.name || '')}<span class="env ${esc(current.env)}">${esc(current.env)}</span>`;
    input.placeholder = `alias [value] – or <system> alias for another system`;
    return;
  }
  const isSap = tab?.url && /^https?:/.test(tab.url) && (looksLikeLaunchpad(tab.url) || await probeLaunchpad(tab.id));
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
  // permission request must start inside the click gesture
  const access = isDefaultHost(sys.host) || !chrome.permissions?.request ? Promise.resolve(true) : chrome.permissions.request({ origins: [originPattern(sys)] }).catch(() => false);
  const systems = [...(await storage.getSystems()), sys];
  await storage.setSystems(systems);
  const granted = await access;
  const state = await send({ type: MSG.GET_STATE });
  await describeTab(state?.snapshot || { systems, recent: [] });
  $('#hint').textContent = granted ? `Added "${sys.key}" (${sys.host}); reload the tab once to start discovery` : `Added "${sys.key}" – site access not granted, discovery disabled until you grant it in options`;
  resolve($('#q').value);
}

async function resolve(text) {
  const mySeq = ++seq;
  const r = await send({ type: MSG.RESOLVE, text, contextHost });
  if (mySeq !== seq || !r || r.error) return;
  items = r.matches || [];
  selected = 0;
  $('#hint').textContent = r.hint || '';
  renderList();
}

function renderList() {
  const ul = $('#list');
  ul.innerHTML = items.map((m, i) => `<li class="${i === selected ? 'sel' : ''}" data-i="${i}">
    <span class="key">${esc(m.alias)}</span><span class="title">${esc(m.title)}</span>
    <span class="tag">${esc(m.intent || m.tag || '')}${m.guess ? ' <span class="chip guess">guess</span>' : ''}${m.onTenant ? ' <span class="chip tenant">tenant</span>' : ''}</span></li>`).join('');
  ul.querySelectorAll('li').forEach((li) => {
    li.addEventListener('click', (ev) => go(items[Number(li.dataset.i)].content, ev.metaKey || ev.ctrlKey ? 'newForegroundTab' : 'currentTab'));
  });
}

function renderRecent(recent) {
  const ul = $('#recent');
  const list = recent.slice(0, 10);
  ul.innerHTML = list.map((r, i) => `<li data-i="${i}"><span class="key">${esc(r.input)}</span><span class="title">${esc(r.title)}</span><span class="tag">${esc(r.systemKey)}</span></li>`).join('') || '<li class="empty">Nothing launched yet.</li>';
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
  const r = await send({ type: MSG.NAVIGATE, text: String(text ?? ''), disposition, contextHost });
  if (r?.error) { $('#hint').textContent = r.error; return; }
  window.close();
}

init().catch((e) => { $('#hint').textContent = 'Failed: ' + (e.message || e); });
