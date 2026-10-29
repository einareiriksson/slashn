// SAP QuickStart — toolbar popup. Same launcher as the omnibox, driven through the service worker.
import { MSG } from '../messages.js';

const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ error: String(e) }));

let items = [];
let selected = 0;
let seq = 0;

async function init() {
  $('#options').addEventListener('click', () => chrome.runtime.openOptionsPage());
  const input = $('#q');
  input.addEventListener('input', () => resolve(input.value));
  input.addEventListener('keydown', onKey);
  input.focus();

  const state = await send({ type: MSG.GET_STATE });
  const snap = state?.snapshot || { systems: [], recent: [] };
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = '';
  try { host = tab?.url ? new URL(tab.url).hostname.toLowerCase() : ''; } catch { host = ''; }
  const current = snap.systems.find((s) => s.host === host);
  $('#current').innerHTML = current
    ? `On <b>${esc(current.key)}</b> ${esc(current.name || '')}<span class="env ${esc(current.env)}">${esc(current.env)}</span>`
    : snap.systems.length ? `<span class="muted">Not on a registered tenant · default: ${esc(snap.systems.find((s) => s.isDefault)?.key || snap.systems[0].key)}</span>` : '<span class="muted">No systems configured – open options</span>';
  if (current) input.placeholder = `${current.key} alias [value]`;
  renderRecent(snap.recent || []);
  resolve('');
}

async function resolve(text) {
  const mySeq = ++seq;
  const r = await send({ type: MSG.RESOLVE, text });
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
  if (!String(text).trim()) return;
  const r = await send({ type: MSG.NAVIGATE, text, disposition });
  if (r?.error) { $('#hint').textContent = r.error; return; }
  window.close();
}

init().catch((e) => { $('#hint').textContent = 'Failed: ' + (e.message || e); });
