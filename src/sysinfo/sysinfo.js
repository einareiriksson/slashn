// slashn — system-info dialog (opened as a popup-type window). Shows one system's row and the launchpad About fields:
// what the last scan recorded, or what an open launchpad tab reports right now after "Refresh from open tab".
import { MSG } from '../messages.js';
import { systemInfoRows } from '../probe.js';
import { homeUrl } from '../resolver.js';
import { systemByTarget } from '../storage.js';

const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ error: String(e) }));
const fmt = (iso) => { try { return iso ? new Date(iso).toLocaleString() : ''; } catch { return String(iso); } };

const host = new URLSearchParams(location.search).get('host') || '';
let system = null;
let meta = null;
let live = null;

function notice(text, kind = '') {
  const n = $('#notice');
  n.hidden = !text;
  n.className = `notice ${kind}`;
  n.textContent = text || '';
}

async function load() {
  const state = await send({ type: MSG.GET_STATE });
  const snap = state?.snapshot;
  system = systemByTarget(snap?.systems || [], host); // host is a target: host, or host/client
  meta = snap?.scanMeta?.[host] || null;
  render();
}

function render() {
  if (!system) {
    $('#title').textContent = 'Unknown system';
    $('#subtitle').textContent = host ? `${host} is not registered.` : 'No system given.';
    $('#sections').innerHTML = '';
    for (const id of ['refresh', 'open', 'rescan', 'debug']) $(`#${id}`).disabled = true;
    return;
  }
  document.title = `${system.key} – system information`;
  $('#title').innerHTML = `<code>${esc(system.key)}</code> ${esc(system.name || '')}`;
  $('#subtitle').textContent = system.host;
  $('#env').textContent = system.env;
  $('#env').className = `badge ${system.env}`;
  const rows = systemInfoRows({ system, meta, live });
  const sections = [...new Set(rows.map((r) => r.section))];
  $('#sections').innerHTML = sections.map((name) => `<section><h2>${esc(name)}</h2><table>${rows.filter((r) => r.section === name).map((r) => {
    const value = r.label === 'Last scanned' && r.value ? fmt(r.value) : r.value;
    const src = r.source ? `<span class="chip ${r.source === 'live' ? 'live' : ''}" title="${r.source === 'live' ? 'Read from the open launchpad tab just now' : 'Recorded by the last scan'}">${r.source}</span>` : '';
    return `<tr><td class="label">${esc(r.label)}</td><td class="value ${value == null ? 'empty' : ''}">${value == null ? 'not reported' : esc(value)}</td><td class="src">${src}</td></tr>`;
  }).join('')}</table></section>`).join('');
  if (!meta?.lastScanned && !live) notice('This system has not been scanned yet. Open its launchpad and click "Refresh from open tab", or "Rescan".');
}

/** Read the About fields from an open launchpad tab. Runs on open; `auto` keeps a missing tab quiet (the scan values stay). */
async function refresh({ auto = false } = {}) {
  const btn = $('#refresh');
  btn.disabled = true;
  if (!auto) notice('Reading from the open launchpad tab…');
  try {
    const r = await send({ type: MSG.PROBE_SYSTEM, host });
    if (r?.error) { notice(r.error, 'error'); return; }
    if (!r?.launchpad) {
      const scanned = Boolean(meta?.lastScanned || meta?.system);
      if (auto && scanned) { notice(`Showing what the last scan recorded. Open the ${system?.key || host} launchpad in a tab to read the About fields live.`); return; }
      notice(r?.reason === 'no tab' ? `No open tab for ${host}. Open the launchpad first, then refresh.` : `The open ${host} tab is not a loaded launchpad (${r?.reason || 'no shell'}). Wait for it to load, then refresh.`, 'warn');
      return;
    }
    live = { system: r.system, ui5Version: r.ui5Version };
    await load(); // the worker stored the fresh fields in the scan metadata too
    notice(r.system ? 'Read live from the open launchpad tab.' : 'The launchpad is loaded but reports no About fields (older UI5 release?).', r.system ? 'ok' : 'warn');
  } finally {
    btn.disabled = false;
  }
}

$('#refresh').addEventListener('click', () => refresh().catch((e) => notice(String(e.message || e), 'error')));
$('#open').addEventListener('click', () => { if (system) chrome.tabs.create({ url: homeUrl(system) }); });
$('#rescan').addEventListener('click', async () => {
  const r = await send({ type: MSG.RESCAN_HOST, host });
  notice(r?.status === 'messaged' ? 'Scanning in the open tab…' : r?.status === 'opened' ? 'Launchpad opened – scanning when it loads.' : r?.status === 'reloaded' ? 'Tab reloaded – scanning.' : (r?.error || 'Scan failed'), r?.error ? 'error' : '');
});
$('#debug').addEventListener('click', () => send({ type: MSG.OPEN_DEBUG, host }));
$('#close').addEventListener('click', () => window.close());
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') window.close(); });
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.scanMeta) load().catch(() => {}); });

load().then(() => (system ? refresh({ auto: true }) : null)).catch((e) => notice('Failed: ' + (e.message || e), 'error'));
