// slashn — shell debug window. Pick a system and a call; the service worker runs it in an open launchpad tab.
import { MSG } from '../messages.js';
import { DEBUG_CALLS, debugCallById, parseDebugParams } from '../debug.js';

const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ error: String(e) }));

let systems = [];
const results = []; // newest first

function notice(text, kind = '') {
  const n = $('#notice');
  n.hidden = !text;
  n.className = `notice ${kind}`;
  n.textContent = text || '';
}

function fillCalls() {
  const groups = [...new Set(DEBUG_CALLS.map((c) => c.group))];
  $('#call').innerHTML = groups.map((g) => `<optgroup label="${esc(g)}">${DEBUG_CALLS.filter((c) => c.group === g).map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('')}</optgroup>`).join('');
}

function onCallChange() {
  const call = debugCallById($('#call').value);
  $('#hint').textContent = call?.hint || '';
  const p = call?.params;
  $('#params').value = p == null ? '' : typeof p === 'string' ? p : JSON.stringify(p);
  $('#params').disabled = p == null;
  try { localStorage.setItem('slashn-debug-call', call?.id || ''); } catch { /* optional */ }
}

function renderResults() {
  $('#out').innerHTML = results.map((r) => `<div class="result">
    <div class="head"><span class="name">${esc(r.label)}</span><span class="muted small">${esc(r.systemKey)} · tab ${esc(r.tabId ?? '–')} · ${esc(r.ms ?? '?')} ms</span><span class="${r.ok ? 'ok' : 'err'}">${r.ok ? 'ok' : 'error'}</span></div>
    ${r.params !== undefined && r.params !== null ? `<div class="muted small">params: ${esc(typeof r.params === 'string' ? r.params : JSON.stringify(r.params))}</div>` : ''}
    <pre>${esc(r.text)}</pre>
  </div>`).join('');
}

async function runOne(callId, params) {
  const call = debugCallById(callId);
  const host = $('#system').value;
  const system = systems.find((s) => s.host === host);
  if (!call || !system) return;
  $('#status').textContent = `Running ${call.label} on ${system.key}…`;
  const r = await send({ type: MSG.DEBUG_CALL, host, call: call.id, params });
  const entry = { label: call.label, systemKey: system.key, params, tabId: r?.tabId ?? null, ms: r?.ms ?? null };
  if (!r || r.error) { Object.assign(entry, { ok: false, text: r?.error || 'no reply from the service worker' }); }
  else if (r.launchpad === false) { Object.assign(entry, { ok: false, text: r.reason === 'no tab' ? `No open tab for ${host}. Open its launchpad first.` : `The open ${host} tab could not be scripted (${r.reason}).` }); }
  else if (r.ok) { Object.assign(entry, { ok: true, text: JSON.stringify(r.result, null, 2) }); }
  else { Object.assign(entry, { ok: false, text: `${r.errorText || r.error}${r.stack ? '\n' + r.stack : ''}` }); }
  results.unshift(entry);
  if (results.length > 30) results.length = 30;
  renderResults();
  $('#status').textContent = `${entry.ok ? 'ok' : 'error'} · ${call.label} · ${entry.ms ?? '?'} ms`;
  return entry;
}

async function init() {
  const state = await send({ type: MSG.GET_STATE });
  systems = state?.snapshot?.systems || [];
  const wanted = new URLSearchParams(location.search).get('host') || '';
  $('#system').innerHTML = systems.map((s) => `<option value="${esc(s.host)}" ${s.host === wanted || (!wanted && s.isDefault) ? 'selected' : ''}>${esc(s.key)} – ${esc(s.host)}</option>`).join('') || '<option value="">no systems</option>';
  fillCalls();
  let remembered = '';
  try { remembered = localStorage.getItem('slashn-debug-call') || ''; } catch { remembered = ''; }
  if (remembered && debugCallById(remembered)) $('#call').value = remembered;
  onCallChange();
  if (!systems.length) notice('No systems configured. Add one in options first.', 'warn');
}

$('#call').addEventListener('change', onCallChange);
$('#run').addEventListener('click', () => runOne($('#call').value, parseDebugParams($('#params').value)).catch((e) => notice(String(e.message || e), 'error')));
$('#run-group').addEventListener('click', async () => {
  const group = debugCallById($('#call').value)?.group;
  for (const c of DEBUG_CALLS.filter((x) => x.group === group)) await runOne(c.id, c.params ?? null);
});
$('#copy').addEventListener('click', async () => {
  const text = results.map((r) => `## ${r.label} (${r.systemKey}, ${r.ok ? 'ok' : 'error'}, ${r.ms ?? '?'} ms)\n${r.params != null ? 'params: ' + (typeof r.params === 'string' ? r.params : JSON.stringify(r.params)) + '\n' : ''}${r.text}\n`).join('\n');
  try { await navigator.clipboard.writeText(text); $('#status').textContent = 'Copied'; } catch (e) { notice('Copy failed: ' + (e.message || e), 'error'); }
});
$('#clear').addEventListener('click', () => { results.length = 0; renderResults(); $('#status').textContent = ''; });
$('#close').addEventListener('click', () => window.close());
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') window.close();
  if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) $('#run').click();
});

init().catch((e) => notice('Failed: ' + (e.message || e), 'error'));
