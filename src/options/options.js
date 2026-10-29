// SAP QuickStart — options page.
import { createStorage, validateSystems, normalizeSystem, ENVS, ALIAS_RE } from '../storage.js';
import { mergeEntries, normalizeEntry, homeUrl, splitIntent, entryKey } from '../resolver.js';
import { aliasesFromCsv, aliasesToCsv } from '../csv.js';
import { MSG } from '../messages.js';

const storage = createStorage();
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const INTENT_RE = /^[A-Za-z0-9_]+-[A-Za-z0-9_]+$/;

let snap = null;
const ui = { tab: 'systems', sub: 'aliases', advanced: false, discHost: null, rescanStatus: {} };
let draftSystems = null; // unsaved rows while the user fills them in

// ---------------------------------------------------------------- helpers

function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

function showErrors(sel, errors) {
  const el = $(sel);
  const list = (errors || []).filter(Boolean);
  el.hidden = !list.length;
  el.textContent = list.join('\n');
}

function download(name, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function readFile(input) {
  return new Promise((resolve) => {
    input.value = '';
    input.onchange = () => {
      const f = input.files[0];
      if (!f) return resolve(null);
      const r = new FileReader();
      r.onload = () => resolve({ name: f.name, text: String(r.result) });
      r.readAsText(f);
    };
    input.click();
  });
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

const staticEntries = () => mergeEntries({ user: snap.userAliases, seed: [...snap.seedAliases, ...snap.importedAliases], hidden: snap.hiddenAliases });
const entriesForHost = (host) => mergeEntries({ user: snap.userAliases, seed: [...snap.seedAliases, ...snap.importedAliases], hidden: snap.hiddenAliases, discovered: snap.discovered?.[host]?.entries || [] });

// ---------------------------------------------------------------- data mutations

/**
 * Copy-on-write: upserts `entry` into the user list (keyed by alias, or "#intent" when alias-less).
 * `orig` is the row that was edited. A seed/library original is hidden when the copy cannot shadow it
 * (alias changed, or no alias at all); shadowing by identical alias needs no tombstone.
 */
async function upsertUserAlias(entry, orig = null) {
  const next = normalizeEntry({ ...entry, source: 'user', discoveredOnTarget: false });
  const nextKey = entryKey(next);
  const origKey = orig ? entryKey(orig) : null;
  const list = (await storage.getUserAliases()).filter((a) => entryKey(a) !== nextKey && entryKey(a) !== origKey);
  list.push(next);
  await storage.setUserAliases(list);
  if (orig && (orig.source === 'seed' || orig.source === 'library') && (!orig.alias || origKey !== nextKey)) {
    const hidden = await storage.getHiddenAliases();
    if (!hidden.includes(origKey)) await storage.setHiddenAliases([...hidden, origKey]);
  }
}

async function deleteEntry(entry) {
  const key = entryKey(entry);
  if (entry.source === 'user') {
    await storage.setUserAliases((await storage.getUserAliases()).filter((a) => entryKey(a) !== key));
  } else if (entry.source === 'import') {
    await storage.setImportedAliases((await storage.getImportedAliases()).filter((a) => entryKey(a) !== key));
  } else {
    const hidden = await storage.getHiddenAliases();
    if (!hidden.includes(key)) await storage.setHiddenAliases([...hidden, key]);
  }
}

// ---------------------------------------------------------------- rendering

async function refresh() {
  snap = await storage.loadSnapshot();
  if (!ui.discHost || !snap.systems.some((s) => s.host === ui.discHost)) ui.discHost = snap.systems[0]?.host ?? null;
  render();
}

function render() {
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === ui.tab));
  $$('.panel').forEach((p) => { p.hidden = p.id !== `tab-${ui.tab}`; });
  $$('.subtab').forEach((b) => b.classList.toggle('active', b.dataset.sub === ui.sub));
  $$('.subpanel').forEach((p) => { p.hidden = p.id !== `sub-${ui.sub}`; });
  renderSystems();
  renderSettings();
  renderRecent();
  renderAliases();
  renderTcodes();
  renderDiscovered();
}

function keyCollisionWarnings(systems) {
  const aliases = new Map(staticEntries().filter((e) => e.alias).map((e) => [e.alias, e]));
  return systems.filter((s) => aliases.has(s.key)).map((s) => `System key "${s.key}" is also an alias (${aliases.get(s.key).intent}); "s ${s.key}" opens the launchpad, so use "s ${systems.find((x) => x.isDefault)?.key || '<system>'} ${s.key}" for the app or rename one of them.`);
}

function renderSystems() {
  const systems = draftSystems ?? snap.systems;
  const adv = ui.advanced;
  const rows = systems.map((s, i) => {
    const meta = snap.scanMeta?.[s.host];
    const status = ui.rescanStatus[s.host] ? ` <span class="muted">(${esc(ui.rescanStatus[s.host])})</span>` : '';
    return `<tr class="env-${esc(s.env)}" data-row="${i}">
      <td><input data-field="key" value="${esc(s.key)}" class="cell-sm" placeholder="acd"></td>
      <td><input data-field="name" value="${esc(s.name)}" placeholder="Customer A – Dev"></td>
      <td><input data-field="customer" value="${esc(s.customer)}" placeholder="Customer A"></td>
      <td><input data-field="host" value="${esc(s.host)}" placeholder="my123456.s4hana.cloud.sap" size="28"></td>
      ${adv ? `<td><input data-field="launchpadPath" value="${esc(s.launchpadPath)}" class="cell-sm"></td>` : ''}
      <td><select data-field="env">${ENVS.map((e) => `<option ${e === s.env ? 'selected' : ''}>${e}</option>`).join('')}</select></td>
      <td><input type="radio" name="isDefault" data-field="isDefault" ${s.isDefault ? 'checked' : ''}></td>
      <td class="muted">${meta?.lastScanned ? esc(new Date(meta.lastScanned).toLocaleString()) : '–'}${status}</td>
      <td class="muted">${meta ? esc(meta.appCount) : '–'}</td>
      <td class="actions">
        <button class="small" data-action="open-launchpad" data-host="${esc(s.host)}">Open launchpad</button>
        <button class="small" data-action="rescan" data-host="${esc(s.host)}">Rescan now</button>
        <button class="small danger" data-action="delete-system" data-row="${i}">Delete</button>
      </td></tr>`;
  }).join('');
  $('#systems-table').innerHTML = `<thead><tr><th>Key</th><th>Name</th><th>Customer</th><th>Host</th>${adv ? '<th>Path</th>' : ''}<th>Env</th><th>Default</th><th>Last scanned</th><th>Apps</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="10" class="muted">No systems yet. Click "Add system".</td></tr>'}</tbody>`;
  const warnings = keyCollisionWarnings(snap.systems);
  $('#sys-warnings').hidden = !warnings.length;
  $('#sys-warnings').textContent = warnings.join('\n');
}

function renderSettings() {
  const f = $('#settings');
  f.suggestionLimit.value = snap.settings.suggestionLimit;
  f.autoScanDays.value = snap.settings.autoScanDays;
  f.reuseTabOnSameHost.checked = Boolean(snap.settings.reuseTabOnSameHost);
}

function renderRecent() {
  const rows = (snap.recent || []).slice(0, 10).map((r, i) => `<tr>
    <td class="muted">${esc(new Date(r.ts).toLocaleString())}</td>
    <td>${esc(r.input)}</td><td>${esc(r.systemKey)}</td><td><code>${esc(r.intent)}</code></td><td>${esc(r.title)}</td>
    <td>${r.guess || r.unresolved ? `<button class="small" data-action="pin-recent" data-idx="${i}">Pin as alias</button>` : ''}</td></tr>`).join('');
  $('#recent-table').innerHTML = `<thead><tr><th>When</th><th>Typed</th><th>System</th><th>Intent</th><th>Title</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="muted">Nothing launched yet.</td></tr>'}</tbody>`;
}

function renderAliases() {
  const q = ($('#alias-filter').value || '').trim().toLowerCase();
  const src = $('#alias-source').value;
  let list = staticEntries();
  if (src) list = list.filter((e) => e.source === src);
  if (q) list = list.filter((e) => [e.alias, e.intent, e.title, e.appId, ...(e.tcodes || [])].some((v) => String(v || '').toLowerCase().includes(q)));
  const total = list.length;
  list = list.slice(0, 500);
  const rows = list.map((e, i) => `<tr data-idx="${i}">
    <td><input data-field="alias" value="${esc(e.alias ?? '')}" class="cell-sm" placeholder="(none)"></td>
    <td><input data-field="intent" value="${esc(e.intent)}"></td>
    <td><input data-field="appId" value="${esc(e.appId ?? '')}" class="cell-sm"></td>
    <td><input data-field="tcodes" value="${esc((e.tcodes || []).join(';'))}"></td>
    <td><input data-field="title" value="${esc(e.title)}" size="30"></td>
    <td><input data-field="paramKey" value="${esc(e.paramKey ?? '')}" class="cell-sm"></td>
    <td><span class="chip ${esc(e.source)}">${esc(e.source)}</span>${e.confidence === 'low' ? ' <span class="chip low">guess</span>' : ''}</td>
    <td><button class="small danger" data-action="delete-alias" data-idx="${i}">${e.source === 'user' || e.source === 'import' ? 'Delete' : 'Hide'}</button></td></tr>`).join('');
  $('#aliases-table').innerHTML = `<thead><tr><th>Alias</th><th>Intent</th><th>App ID</th><th>T-codes</th><th>Title</th><th>Param key</th><th>Source</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="8" class="muted">No aliases match.</td></tr>'}</tbody>`;
  renderAliases.visible = list;
  const hidden = snap.hiddenAliases || [];
  $('#hidden-list').innerHTML = hidden.length
    ? `Hidden: ${hidden.map((h) => `<code>${esc(h)}</code> <button class="small" data-action="restore-alias" data-key="${esc(h)}">restore</button>`).join(' ')}`
    : '';
  if (total > list.length) $('#hidden-list').innerHTML += `<div>Showing ${list.length} of ${total}; refine the filter.</div>`;
}

function renderTcodes() {
  const q = ($('#tcode-filter').value || '').trim().toLowerCase();
  const rows = [];
  for (const e of staticEntries()) for (const t of e.tcodes || []) rows.push({ tcode: t, e });
  rows.sort((a, b) => a.tcode.localeCompare(b.tcode) || a.e.intent.localeCompare(b.e.intent));
  const list = rows.filter((r) => !q || r.tcode.includes(q) || r.e.intent.toLowerCase().includes(q) || r.e.title.toLowerCase().includes(q)).slice(0, 500);
  renderTcodes.visible = list;
  $('#tcodes-table').innerHTML = `<thead><tr><th>T-code</th><th>Intent</th><th>Title</th><th>Alias</th><th>Source</th><th></th></tr></thead><tbody>${list.map((r, i) => `<tr>
    <td><code>${esc(r.tcode.toUpperCase())}</code></td><td><code>${esc(r.e.intent)}</code></td><td>${esc(r.e.title)}</td><td>${esc(r.e.alias ?? '')}</td>
    <td><span class="chip ${esc(r.e.source)}">${esc(r.e.source)}</span>${r.e.confidence === 'low' ? ' <span class="chip low">guess</span>' : ''}</td>
    <td><button class="small danger" data-action="unmap-tcode" data-idx="${i}">Remove</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No t-codes match.</td></tr>'}</tbody>`;
}

function renderDiscovered() {
  const sel = $('#disc-host');
  sel.innerHTML = snap.systems.map((s) => `<option value="${esc(s.host)}" ${s.host === ui.discHost ? 'selected' : ''}>${esc(s.key)} – ${esc(s.name || s.host)}</option>`).join('') || '<option value="">no systems</option>';
  const host = ui.discHost;
  const rec = host ? snap.discovered?.[host] : null;
  const meta = host ? snap.scanMeta?.[host] : null;
  $('#disc-meta').innerHTML = rec
    ? `Scanned ${esc(new Date(rec.scannedAt).toLocaleString())} · ${esc(rec.entries.length)} intents · UI5 ${esc(rec.ui5Version || '?')} · ${esc(JSON.stringify(rec.methods || {}))}${rec.errors?.length ? `<br>Warnings: ${esc(rec.errors.join(' | '))}` : ''}`
    : `Not scanned yet${meta ? '' : ' – open the launchpad on this system (or click Rescan now) to discover its apps.'}`;
  const q = ($('#disc-filter').value || '').trim().toLowerCase();
  const merged = host ? entriesForHost(host) : [];
  const discoveredOnly = merged.filter((e) => e.source === 'discovered');
  const list = discoveredOnly.filter((e) => !q || [e.intent, e.title, e.appId, e.alias, ...(e.tcodes || [])].some((v) => String(v || '').toLowerCase().includes(q))).slice(0, 500);
  renderDiscovered.visible = list;
  $('#disc-table').innerHTML = `<thead><tr><th>Intent</th><th>Title</th><th>App ID</th><th>Auto alias</th><th>T-codes</th><th>Param</th><th></th></tr></thead><tbody>${list.map((e, i) => `<tr>
    <td><code>${esc(e.intent)}</code></td><td>${esc(e.title)}</td><td>${esc(e.appId ?? '')}</td><td>${esc(e.alias ?? '')}</td><td>${esc((e.tcodes || []).join(' '))}</td><td>${esc(e.paramKey ?? '')}</td>
    <td><button class="small" data-action="pin-discovered" data-idx="${i}">Pin as alias</button></td></tr>`).join('') || `<tr><td colspan="7" class="muted">${discoveredOnly.length ? 'No entries match.' : 'Nothing discovered for this system yet.'}</td></tr>`}</tbody>`;

  // Seed / personal / imported intents the tenant does not offer (library rows are too many to be useful here).
  const details = $('#disc-missing');
  if (!rec) { details.hidden = true; return; }
  details.hidden = false;
  const have = new Set(rec.entries.map((e) => String(e.intent).toLowerCase()));
  const missing = mergeEntries({ user: snap.userAliases, seed: [...snap.seedAliases, ...snap.importedAliases], hidden: snap.hiddenAliases })
    .filter((e) => e.source !== 'library' && !have.has(e.intent.toLowerCase()) && !/^Shell-/.test(e.intent))
    .sort((a, b) => (a.alias || '~').localeCompare(b.alias || '~') || a.intent.localeCompare(b.intent));
  $('summary', details).textContent = `${missing.length} seed/personal intents not found on this tenant (hidden from suggestions when marked guess)`;
  $('#missing-table').innerHTML = `<thead><tr><th>Alias</th><th>Intent</th><th>Title</th><th>T-codes</th><th>Source</th><th>Confidence</th></tr></thead><tbody>${missing.slice(0, 500).map((e) => `<tr>
    <td>${esc(e.alias ?? '')}</td><td><code>${esc(e.intent)}</code></td><td>${esc(e.title)}</td><td>${esc((e.tcodes || []).join(' '))}</td><td><span class="chip ${esc(e.source)}">${esc(e.source)}</span></td><td>${esc(e.confidence || '')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Every seed and personal intent exists on this tenant.</td></tr>'}</tbody>`;
}

// ---------------------------------------------------------------- systems editing

function readSystemsFromDom() {
  return $$('#systems-table tbody tr[data-row]').map((tr) => {
    const get = (f) => $(`[data-field="${f}"]`, tr);
    return normalizeSystem({
      key: get('key').value,
      name: get('name').value,
      customer: get('customer').value,
      host: get('host').value,
      launchpadPath: get('launchpadPath')?.value || '/ui',
      env: get('env').value,
      isDefault: get('isDefault').checked,
    });
  });
}

const saveSystems = debounce(async () => {
  const systems = readSystemsFromDom();
  if (systems.length && !systems.some((s) => s.isDefault)) systems[0].isDefault = true;
  const errors = validateSystems(systems);
  showErrors('#sys-errors', errors);
  if (errors.length) { draftSystems = systems; return; }
  try {
    await storage.setSystems(systems);
    draftSystems = null;
    const warnings = keyCollisionWarnings(systems);
    toast(warnings.length ? 'Systems saved (see warning)' : 'Systems saved');
  } catch (e) {
    showErrors('#sys-errors', [String(e.message || e)]);
  }
}, 300);

const saveSettings = debounce(async () => {
  const f = $('#settings');
  const limit = Math.min(10, Math.max(1, Number(f.suggestionLimit.value) || 6));
  const days = Math.min(365, Math.max(0, Number(f.autoScanDays.value) || 0));
  await storage.setSettings({ suggestionLimit: limit, autoScanDays: days, reuseTabOnSameHost: f.reuseTabOnSameHost.checked });
  toast('Settings saved');
}, 300);

// ---------------------------------------------------------------- alias editing

async function onAliasCellChange(tr) {
  const orig = renderAliases.visible?.[Number(tr.dataset.idx)];
  if (!orig) return;
  const get = (f) => $(`[data-field="${f}"]`, tr).value.trim();
  const alias = get('alias').toLowerCase() || null;
  const intent = get('intent');
  const errors = [];
  if (alias && !ALIAS_RE.test(alias)) errors.push(`alias "${alias}" must match ${ALIAS_RE}`);
  if (!INTENT_RE.test(intent)) errors.push(`intent "${intent}" must look like SemanticObject-action`);
  showErrors('#alias-errors', errors);
  if (errors.length) return;
  const [semanticObject, action] = splitIntent(intent);
  const entry = { alias, semanticObject, action, intent, appId: get('appId') || null, tcodes: get('tcodes'), title: get('title') || intent, paramKey: get('paramKey') || null };
  if (orig.source === 'import') {
    const list = (await storage.getImportedAliases()).filter((a) => entryKey(a) !== entryKey(orig));
    list.push(normalizeEntry({ ...entry, source: 'import' }));
    await storage.setImportedAliases(list);
  } else {
    await upsertUserAlias(entry, orig);
  }
  toast(`Saved "${alias || intent}"`);
}

async function pinEntry(base, suggested) {
  const alias = prompt(`Alias for ${base.intent} (${base.title}):`, suggested || base.alias || '');
  if (alias == null) return;
  const a = alias.trim().toLowerCase();
  if (!ALIAS_RE.test(a)) { toast(`Invalid alias "${a}"`); return; }
  const clash = staticEntries().find((e) => e.alias === a && e.intent !== base.intent);
  if (clash && !confirm(`"${a}" already points to ${clash.intent}. Replace it?`)) return;
  await upsertUserAlias({ ...base, alias: a, source: 'user' }, null);
  toast(`Pinned "${a}"`);
}

// ---------------------------------------------------------------- events

document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-action], .tab, .subtab');
  if (!btn) return;
  if (btn.classList.contains('tab')) { ui.tab = btn.dataset.tab; render(); return; }
  if (btn.classList.contains('subtab')) { ui.sub = btn.dataset.sub; render(); return; }
  const action = btn.dataset.action;
  try {
    switch (action) {
      case 'add-system': {
        draftSystems = [...(draftSystems ?? snap.systems), normalizeSystem({ key: '', name: '', customer: '', host: '', env: 'TST', isDefault: !snap.systems.length })];
        renderSystems();
        $('#systems-table tbody tr:last-child input').focus();
        break;
      }
      case 'delete-system': {
        const systems = readSystemsFromDom();
        const [removed] = systems.splice(Number(btn.dataset.row), 1);
        if (removed?.host && !confirm(`Delete system "${removed.key}" (${removed.host})?`)) return;
        if (systems.length && !systems.some((s) => s.isDefault)) systems[0].isDefault = true;
        const errors = validateSystems(systems);
        if (errors.length) { draftSystems = systems; showErrors('#sys-errors', errors); renderSystems(); return; }
        draftSystems = null;
        await storage.setSystems(systems);
        if (removed?.host) await storage.clearDiscovered(removed.host);
        toast('System deleted');
        break;
      }
      case 'open-launchpad': {
        const system = snap.systems.find((s) => s.host === btn.dataset.host);
        if (system) chrome.tabs.create({ url: homeUrl(system) });
        break;
      }
      case 'rescan':
      case 'rescan-selected': {
        const host = action === 'rescan' ? btn.dataset.host : ui.discHost;
        if (!host) return;
        ui.rescanStatus[host] = 'requesting…';
        renderSystems();
        const r = await chrome.runtime.sendMessage({ type: MSG.RESCAN_HOST, host });
        ui.rescanStatus[host] = r?.status === 'messaged' ? 'scanning…' : r?.status === 'opened' ? 'launchpad opened, scanning on load' : r?.status === 'reloaded' ? 'tab reloaded, scanning' : (r?.error || 'failed');
        renderSystems();
        toast(`Rescan: ${ui.rescanStatus[host]}`);
        break;
      }
      case 'clear-selected': {
        if (ui.discHost && confirm(`Clear discovered apps for ${ui.discHost}?`)) { await storage.clearDiscovered(ui.discHost); toast('Cleared'); }
        break;
      }
      case 'export-json': {
        const data = await storage.exportJson({ includeDiscovered: $('#include-discovered').checked });
        download(`sap-quickstart-config-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json');
        break;
      }
      case 'import-json': {
        const f = await readFile($('#file-json'));
        if (!f) return;
        const obj = JSON.parse(f.text);
        if (!confirm(`Import ${obj.systems?.length ?? 0} systems and ${obj.userAliases?.length ?? 0} aliases from ${f.name}, replacing the current config?`)) return;
        const r = await storage.importJson(obj, { replace: true });
        toast(`Imported ${r.systems} systems, ${r.userAliases} aliases`);
        break;
      }
      case 'import-csv': {
        const f = await readFile($('#file-csv'));
        if (!f) return;
        const target = $('#import-target').value;
        const mode = $('#import-mode').value;
        const { entries, errors } = aliasesFromCsv(f.text, { source: target });
        showErrors('#alias-errors', errors.map((e) => `line ${e.line}: ${e.message}`));
        if (!entries.length) { toast('No rows imported'); return; }
        const current = mode === 'replace' ? [] : target === 'user' ? await storage.getUserAliases() : await storage.getImportedAliases();
        const byKey = new Map(current.map((a) => [entryKey(a), a]));
        for (const e of entries) byKey.set(entryKey(normalizeEntry(e)), e);
        if (target === 'user') await storage.setUserAliases([...byKey.values()]);
        else await storage.setImportedAliases([...byKey.values()]);
        toast(`Imported ${entries.length} aliases (${mode}) into ${target === 'user' ? 'my aliases' : 'local import table'}`);
        break;
      }
      case 'export-csv': {
        download('sap-quickstart-aliases.csv', aliasesToCsv(staticEntries()), 'text/csv');
        break;
      }
      case 'delete-alias': {
        const e = renderAliases.visible?.[Number(btn.dataset.idx)];
        if (!e) return;
        await deleteEntry(e);
        toast(e.source === 'user' || e.source === 'import' ? `Deleted "${e.alias || e.intent}"` : `Hidden "${e.alias || e.intent}"`);
        break;
      }
      case 'restore-alias': {
        await storage.setHiddenAliases((await storage.getHiddenAliases()).filter((h) => h !== btn.dataset.key));
        toast(`Restored "${btn.dataset.key}"`);
        break;
      }
      case 'unmap-tcode': {
        const r = renderTcodes.visible?.[Number(btn.dataset.idx)];
        if (!r) return;
        const remaining = r.e.tcodes.filter((t) => t !== r.tcode);
        if (r.e.source === 'import') {
          const list = (await storage.getImportedAliases()).map((a) => (entryKey(a) === entryKey(r.e) ? { ...a, tcodes: remaining } : a));
          await storage.setImportedAliases(list);
        } else if (!remaining.length && !r.e.alias && r.e.source !== 'user') {
          await deleteEntry(r.e); // alias-less seed row with its only t-code removed: just hide it
        } else {
          await upsertUserAlias({ ...r.e, tcodes: remaining }, r.e);
        }
        toast(`Removed ${r.tcode.toUpperCase()} from ${r.e.alias || r.e.intent}`);
        break;
      }
      case 'pin-discovered': {
        const e = renderDiscovered.visible?.[Number(btn.dataset.idx)];
        if (e) await pinEntry(e, e.alias || '');
        break;
      }
      case 'pin-recent': {
        const r = snap.recent?.[Number(btn.dataset.idx)];
        if (!r) return;
        const [semanticObject, action] = splitIntent(r.intent);
        const typed = String(r.input || '').split(/\s+/).filter(Boolean);
        const suggested = r.unresolved || (typed.length > 1 ? typed[1] : typed[0]) || '';
        await pinEntry({ alias: null, semanticObject, action, intent: r.intent, appId: null, tcodes: [], title: r.title, paramKey: null }, suggested);
        break;
      }
      default:
        break;
    }
  } catch (e) {
    console.warn('[SAPQS] options action failed', e);
    toast(String(e.message || e), 4000);
  }
});

document.addEventListener('change', async (ev) => {
  const el = ev.target;
  if (el.matches('[data-action="toggle-advanced"]')) { ui.advanced = el.checked; renderSystems(); return; }
  if (el.closest('#systems-table')) { saveSystems(); return; }
  if (el.closest('#settings')) { saveSettings(); return; }
  if (el.closest('#aliases-table') && el.matches('[data-field]')) { await onAliasCellChange(el.closest('tr')); return; }
  if (el.id === 'alias-source') renderAliases();
  if (el.id === 'disc-host') { ui.discHost = el.value; renderDiscovered(); }
});

document.addEventListener('input', debounce((ev) => {
  const id = ev.target.id;
  if (id === 'alias-filter') renderAliases();
  if (id === 'tcode-filter') renderTcodes();
  if (id === 'disc-filter') renderDiscovered();
}, 120));

$('#alias-add').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const intent = String(fd.get('intent')).trim();
  const [semanticObject, action] = splitIntent(intent);
  const alias = String(fd.get('alias')).trim().toLowerCase();
  try {
    await upsertUserAlias({ alias, semanticObject, action, intent, appId: String(fd.get('appId') || '').trim() || null, tcodes: String(fd.get('tcodes') || ''), title: String(fd.get('title') || '').trim() || intent, paramKey: String(fd.get('paramKey') || '').trim() || null }, null);
    ev.target.reset();
    toast(`Added "${alias}"`);
  } catch (e) {
    showErrors('#alias-errors', [String(e.message || e)]);
  }
});

$('#tcode-add').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const tcode = String(fd.get('tcode')).trim().toLowerCase();
  const target = String(fd.get('target')).trim();
  const all = staticEntries();
  let base = all.find((e) => e.alias === target.toLowerCase()) || all.find((e) => e.intent.toLowerCase() === target.toLowerCase());
  let orig = base || null;
  if (!base) {
    if (!INTENT_RE.test(target)) { showErrors('#tcode-errors', [`"${target}" is neither a known alias nor a SemanticObject-action`]); return; }
    const [semanticObject, action] = splitIntent(target);
    base = { alias: tcode, semanticObject, action, intent: target, appId: null, tcodes: [], title: target, paramKey: null };
  }
  if (!base.alias) base = { ...base, alias: tcode };
  showErrors('#tcode-errors', []);
  await upsertUserAlias({ ...base, tcodes: [...(base.tcodes || []), tcode] }, orig);
  ev.target.reset();
  toast(`Mapped ${tcode.toUpperCase()} → ${base.intent}`);
});

chrome.storage.onChanged.addListener(debounce(() => { refresh().catch((e) => console.warn('[SAPQS] refresh failed', e)); }, 150));

refresh().catch((e) => { console.error('[SAPQS] options failed to load', e); toast('Failed to load: ' + e.message, 6000); });
