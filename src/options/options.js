// slashn — options page.
import { createStorage, validateSystems, normalizeSystem, systemFromUrl, isDefaultHost, originPattern, ENVS, EDITIONS, EDITION_LABELS, ALIAS_RE } from '../storage.js';
import { mergeEntries, normalizeEntry, homeUrl, splitIntent, entryKey, appliesToEdition } from '../resolver.js';
import { aliasesFromCsv, aliasesToCsv } from '../csv.js';
import { MSG } from '../messages.js';

const storage = createStorage();
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const INTENT_RE = /^[A-Za-z0-9_]+-[A-Za-z0-9_]+$/;
const NEW = '__new__';
const PAGE = 100;

let snap = null;
const ui = {
  tab: 'systems',
  editHost: null, sysDraft: null, sysErrors: [],   // system being edited (host, or NEW) and its unsaved field values
  aliasSource: '', editAlias: null, aliasDraft: null, showAdd: false,
  discHost: null, rescanStatus: {}, access: {},
};

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

/** "just now", "3 h ago", "yesterday", "12 days ago" */
function ago(iso) {
  const t = Date.parse(iso);
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
const fmtDateTime = (v) => { try { return new Date(v).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return String(v); } };
const srcLabel = (e) => ({ user: 'mine', import: 'imported', seed: 'built-in', library: 'library', discovered: 'discovered' }[e.source] || e.source);

const staticEntries = () => mergeEntries({ user: snap.userAliases, seed: [...snap.seedAliases, ...snap.importedAliases], hidden: snap.hiddenAliases });
const entriesForHost = (host) => mergeEntries({ user: snap.userAliases, seed: [...snap.seedAliases, ...snap.importedAliases], hidden: snap.hiddenAliases, discovered: snap.discovered?.[host]?.entries || [], edition: snap.systems.find((s) => s.host === host)?.edition || null });
const systemByHost = (host) => snap.systems.find((s) => s.host === host) || null;

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

async function refreshAccess() {
  ui.access = {};
  if (!chrome.permissions?.contains) return;
  await Promise.all(snap.systems.filter((s) => !isDefaultHost(s.host)).map(async (s) => {
    try { ui.access[s.host] = await chrome.permissions.contains({ origins: [originPattern(s)] }); } catch { ui.access[s.host] = false; }
  }));
}

/** Must be called synchronously inside a user-gesture handler (paste, click, submit). */
function requestAccess(system) {
  if (isDefaultHost(system.host) || !chrome.permissions?.request) return Promise.resolve(true);
  return chrome.permissions.request({ origins: [originPattern(system)] }).catch(() => false);
}

async function addFromUrl(text) {
  const sys = systemFromUrl(text, snap.systems);
  if (!sys) { toast('That does not look like a launchpad URL'); return; }
  const dup = systemByHost(sys.host);
  if (dup) { toast(`${sys.host} is already registered as "${dup.key}"`); return; }
  const access = requestAccess(sys); // started inside the gesture
  await storage.setSystems([...snap.systems, sys]);
  const granted = await access;
  toast(granted ? `Added "${sys.key}" (${sys.host})` : `Added "${sys.key}" – grant site access to enable discovery on ${sys.host}`, 3500);
  $('#add-url-input').value = '';
}

// ---------------------------------------------------------------- rendering

async function refresh() {
  snap = await storage.loadSnapshot();
  await refreshAccess();
  if (!ui.discHost || !systemByHost(ui.discHost)) ui.discHost = snap.systems[0]?.host ?? null;
  render();
}

function render() {
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === ui.tab));
  $$('.panel').forEach((p) => { p.hidden = p.id !== `tab-${ui.tab}`; });
  renderSystems();
  renderAliases();
  renderDiscovered();
  renderSettings();
  renderRecent();
}

// ---- systems

function keyCollisionWarnings(systems) {
  const aliases = new Map(staticEntries().filter((e) => e.alias).map((e) => [e.alias, e]));
  return systems.filter((s) => aliases.has(s.key)).map((s) => `System key "${s.key}" is also an alias (${aliases.get(s.key).intent}). "s ${s.key}" opens the launchpad; type "s ${systems.find((x) => x.isDefault)?.key || '<system>'} ${s.key}" for the app, or rename one of them.`);
}

function systemForm(s, isNew) {
  const v = ui.sysDraft || s;
  const opt = (list, cur, labels) => list.map((x) => `<option value="${esc(x)}" ${x === cur ? 'selected' : ''}>${esc(labels ? labels[x] : x)}</option>`).join('');
  return `<form class="form editor" data-sys-form="${esc(isNew ? NEW : s.host)}">
    <div class="fields">
      <label>Key <input name="key" value="${esc(v.key)}" placeholder="acd" autocomplete="off" required pattern="[a-z0-9][a-z0-9_\\-]*"></label>
      <label class="wide">Name <input name="name" value="${esc(v.name)}" placeholder="Customer A – Development"></label>
      <label>Customer <input name="customer" value="${esc(v.customer)}" placeholder="Customer A"></label>
      <label>Environment <select name="env">${opt(ENVS, v.env)}</select></label>
      <label>Edition <select name="edition">${opt(EDITIONS, v.edition, EDITION_LABELS)}</select></label>
      <div class="group">Connection</div>
      <label class="wide">Host <input name="host" value="${esc(v.host)}" placeholder="my123456.s4hana.cloud.sap or erp.example.com:8443" autocomplete="off" required></label>
      <label>Scheme <select name="scheme">${opt(['https', 'http'], v.scheme === 'http' ? 'http' : 'https')}</select></label>
      <label>Launchpad path <input name="launchpadPath" value="${esc(v.launchpadPath || '/ui')}" placeholder="/ui or /sap/bc/ui2/flp"></label>
      <label>Query <input name="launchpadQuery" value="${esc(v.launchpadQuery || '')}" placeholder="sap-client=600"></label>
      <label class="check"><input type="checkbox" name="isDefault" ${v.isDefault ? 'checked' : ''}> Default system</label>
    </div>
    ${ui.sysErrors.length ? `<div class="notice error">${esc(ui.sysErrors.join('\n'))}</div>` : ''}
    <div class="formbar">
      <button type="submit" class="primary">Save</button>
      <button type="button" class="ghost" data-action="cancel-system">Cancel</button>
      <span class="spacer"></span>
      ${isNew ? '' : `<button type="button" class="ghost danger" data-action="delete-system" data-host="${esc(s.host)}">Delete system</button>`}
    </div>
  </form>`;
}

function systemCard(s) {
  const meta = snap.scanMeta?.[s.host];
  const editing = ui.editHost === s.host;
  const custom = !isDefaultHost(s.host);
  const noAccess = custom && ui.access[s.host] === false;
  const status = ui.rescanStatus[s.host];
  const scan = status ? `<span>${esc(status)}</span>`
    : meta?.lastScanned ? `<span title="${esc(fmtDateTime(meta.lastScanned))}">Scanned ${esc(ago(meta.lastScanned))} · ${esc(meta.appCount)} apps</span> <button class="linkbtn" data-action="view-discovered" data-host="${esc(s.host)}">View</button>`
    : '<span>Not scanned yet</span>';
  return `<article class="card sys env-${esc(s.env)}" data-host="${esc(s.host)}">
    <div class="card-head">
      <span class="key">${esc(s.key)}</span>
      <span class="name">${esc(s.name || '')}</span>
      <span class="badge ${esc(s.env)}">${esc(s.env)}</span>
      ${s.isDefault ? '<span class="badge outline">default</span>' : ''}
      <span class="actions">
        <button class="sm" data-action="open-launchpad" data-host="${esc(s.host)}">Open</button>
        <button class="sm" data-action="rescan" data-host="${esc(s.host)}">Rescan</button>
        <button class="sm ${editing ? 'primary' : ''}" data-action="edit-system" data-host="${esc(s.host)}">Edit</button>
      </span>
    </div>
    <div class="card-meta">
      <span>${esc(s.host)}${s.launchpadPath && s.launchpadPath !== '/ui' ? esc(s.launchpadPath) : ''}${s.launchpadQuery ? '?' + esc(s.launchpadQuery) : ''}</span>
      <span>${esc(EDITION_LABELS[s.edition] || s.edition)}</span>
      ${scan}
    </div>
    ${noAccess ? `<div class="notice warn inline"><span>slashn has no access to this site yet, so it cannot discover apps or reuse its tabs.</span><button class="sm" data-action="grant-access" data-host="${esc(s.host)}">Grant site access</button></div>` : ''}
    ${editing ? systemForm(s, false) : ''}
  </article>`;
}

function renderSystems() {
  const cards = snap.systems.map(systemCard);
  if (ui.editHost === NEW) cards.unshift(`<article class="card sys"><div class="card-head"><span class="name">New system</span></div>${systemForm(normalizeSystem({ key: '', name: '', customer: '', host: '', env: 'TST', isDefault: !snap.systems.length }), true)}</article>`);
  $('#systems-list').innerHTML = cards.join('') || '<div class="empty">No systems yet. Paste a launchpad URL above, or open a launchpad and click the slashn icon.</div>';
  const warnings = keyCollisionWarnings(snap.systems);
  $('#sys-warnings').hidden = !warnings.length;
  $('#sys-warnings').textContent = warnings.join('\n');
}

function readSystemForm(form) {
  const fd = new FormData(form);
  const g = (k) => String(fd.get(k) ?? '').trim();
  return { key: g('key'), name: g('name'), customer: g('customer'), host: g('host'), scheme: g('scheme') || 'https', launchpadPath: g('launchpadPath') || '/ui', launchpadQuery: g('launchpadQuery'), env: g('env'), edition: g('edition'), isDefault: fd.get('isDefault') != null };
}

async function saveSystem(form) {
  const which = form.dataset.sysForm;
  const draft = normalizeSystem(readSystemForm(form));
  const systems = snap.systems.map((s) => ({ ...s }));
  const idx = which === NEW ? -1 : systems.findIndex((s) => s.host === which);
  if (idx < 0) systems.push(draft); else systems[idx] = draft;
  if (draft.isDefault) systems.forEach((s) => { s.isDefault = s === draft; });
  if (!systems.some((s) => s.isDefault)) systems[0].isDefault = true;
  const errors = validateSystems(systems);
  ui.sysDraft = draft;
  ui.sysErrors = errors;
  if (errors.length) { renderSystems(); return; }
  const oldHost = idx >= 0 ? snap.systems[idx].host : null;
  const hostChanged = draft.host !== oldHost;
  // Ask for site access only for a new or changed custom host, and start the request inside the submit gesture.
  const access = hostChanged && !isDefaultHost(draft.host) ? requestAccess(draft) : Promise.resolve(true);
  await storage.setSystems(systems);
  if (oldHost && hostChanged) await storage.clearDiscovered(oldHost);
  ui.editHost = null; ui.sysDraft = null; ui.sysErrors = [];
  snap.systems = systems;
  renderSystems(); // do not wait for the storage event: a pending permission prompt can delay it
  const granted = await access;
  toast(granted ? 'System saved' : 'System saved – site access not granted, discovery disabled until you grant it', 3500);
}

// ---- aliases

function aliasQueryState() {
  const q = ($('#alias-filter').value || '').trim().toLowerCase();
  const src = ui.aliasSource;
  const ed = $('#alias-edition').value;
  let list = staticEntries();
  const all = list.length;
  if (src === 'user') list = list.filter((e) => e.source === 'user' || e.source === 'import');
  else if (src) list = list.filter((e) => e.source === src);
  if (ed) list = list.filter((e) => appliesToEdition(e, ed));
  if (q) {
    const terms = q.split(/\s+/).filter(Boolean);
    list = list.filter((e) => {
      const hay = [e.alias, e.intent, e.title, e.appId, ...(e.tcodes || [])].map((v) => String(v || '').toLowerCase());
      return terms.every((t) => hay.some((h) => h.includes(t)));
    });
    // exact alias / t-code / app ID hits first, then alias prefix, then the rest
    const score = (e) => (e.alias === q || (e.tcodes || []).includes(q) || String(e.appId || '').toLowerCase() === q) ? 0 : e.alias?.startsWith(q) ? 1 : 2;
    list.sort((a, b) => score(a) - score(b) || (a.alias || '~').localeCompare(b.alias || '~'));
  }
  const browsing = !q && !src && !ed; // nothing asked for: show the user's own rows instead of 21k library rows
  if (browsing) list = list.filter((e) => e.source === 'user' || e.source === 'import');
  return { list, all, q, browsing };
}

function aliasEditor(e) {
  const v = ui.aliasDraft || { alias: e.alias ?? '', intent: e.intent, title: e.title, appId: e.appId ?? '', tcodes: (e.tcodes || []).join('; '), paramKey: e.paramKey ?? '' };
  return `<form class="form editor" data-alias-form="${esc(entryKey(e))}">
    <div class="fields">
      <label>Alias <input name="alias" value="${esc(v.alias)}" placeholder="(none)" autocomplete="off"></label>
      <label class="wide">Title <input name="title" value="${esc(v.title)}"></label>
      <label class="wide">App (SemanticObject-action) <input name="intent" value="${esc(v.intent)}" required></label>
      <label>App ID <input name="appId" value="${esc(v.appId)}"></label>
      <label>T-codes <input name="tcodes" value="${esc(v.tcodes)}" placeholder="me21n; me21"></label>
      <label>Parameter <input name="paramKey" value="${esc(v.paramKey)}" placeholder="PurchaseOrder"></label>
    </div>
    <div class="formbar">
      <button type="submit" class="primary">Save${e.source === 'user' || e.source === 'import' ? '' : ' as my alias'}</button>
      <button type="button" class="ghost" data-action="cancel-alias">Cancel</button>
    </div>
  </form>`;
}

function aliasRow(e) {
  const key = entryKey(e);
  const sub = [
    `<code>${esc(e.intent)}</code>`,
    e.appId ? esc(e.appId) : '',
    e.tcodes?.length ? `t-codes ${esc(e.tcodes.map((t) => t.toUpperCase()).join(', '))}` : '',
    e.paramKey ? `param ${esc(e.paramKey)}` : '',
    e.editions?.length ? esc(e.editions.map((x) => EDITION_LABELS[x]).join(', ')) : '',
  ].filter(Boolean).map((x) => `<span>${x}</span>`).join('');
  const mine = e.source === 'user' || e.source === 'import';
  return `<div class="row" data-key="${esc(key)}">
    <div class="row-main">
      <span class="alias">${esc(e.alias ?? '–')}</span>
      <span class="title">${esc(e.title)}</span>
      <span class="badge ${esc(e.source)}">${esc(srcLabel(e))}</span>
      ${e.confidence === 'low' ? '<span class="badge guess">guess</span>' : ''}
      <span class="actions">
        <button class="sm" data-action="edit-alias" data-key="${esc(key)}">Edit</button>
        <button class="sm ghost danger" data-action="delete-alias" data-key="${esc(key)}">${mine ? 'Delete' : 'Hide'}</button>
      </span>
    </div>
    <div class="row-sub">${sub}</div>
    ${ui.editAlias === key ? aliasEditor(e) : ''}
  </div>`;
}

function renderAliases() {
  $$('#alias-source button').forEach((b) => b.classList.toggle('active', b.dataset.value === ui.aliasSource));
  $('#alias-add').hidden = !ui.showAdd;
  const { list, all, q, browsing } = aliasQueryState();
  const shown = list.slice(0, PAGE);
  renderAliases.visible = new Map(shown.map((e) => [entryKey(e), e]));
  $('#aliases-list').innerHTML = shown.map(aliasRow).join('');
  const n = all.toLocaleString();
  $('#alias-summary').innerHTML = browsing
    ? (list.length ? `Your ${list.length} alias${list.length === 1 ? '' : 'es'}. Search to find any of the ${n} built-in and library apps.` : `<div class="empty">You have no aliases of your own yet. Search the ${n} built-in and library apps, then edit a row or click <b>Add alias</b>.</div>`)
    : list.length > PAGE ? `Showing ${PAGE} of ${list.length.toLocaleString()} matches – refine the search.` : `${list.length.toLocaleString()} match${list.length === 1 ? '' : 'es'}${q ? '' : ` of ${n}`}.`;
  if (!browsing && !list.length) $('#alias-summary').innerHTML = `<div class="empty">Nothing matches${q ? ` "${esc(q)}"` : ''}.</div>`;
  const hidden = snap.hiddenAliases || [];
  $('#hidden-list').innerHTML = hidden.length
    ? `Hidden: ${hidden.map((h) => `<code>${esc(h)}</code> <button class="linkbtn" data-action="restore-alias" data-key="${esc(h)}">restore</button>`).join(' · ')}`
    : '';
}

async function saveAlias(form) {
  const orig = renderAliases.visible?.get(form.dataset.aliasForm);
  if (!orig) return;
  const fd = new FormData(form);
  const g = (k) => String(fd.get(k) ?? '').trim();
  const alias = g('alias').toLowerCase() || null;
  const intent = g('intent');
  const errors = [];
  if (alias && !ALIAS_RE.test(alias)) errors.push(`Alias "${alias}" may only contain a-z, 0-9, _ . / -`);
  if (!INTENT_RE.test(intent)) errors.push(`"${intent}" must look like SemanticObject-action`);
  showErrors('#alias-errors', errors);
  if (errors.length) return;
  const [semanticObject, action] = splitIntent(intent);
  const entry = { alias, semanticObject, action, intent, appId: g('appId') || null, tcodes: g('tcodes'), title: g('title') || intent, paramKey: g('paramKey') || null };
  if (orig.source === 'import') {
    const list = (await storage.getImportedAliases()).filter((a) => entryKey(a) !== entryKey(orig));
    list.push(normalizeEntry({ ...entry, source: 'import' }));
    await storage.setImportedAliases(list);
  } else {
    await upsertUserAlias(entry, orig);
  }
  ui.editAlias = null; ui.aliasDraft = null;
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

// ---- discovered

function renderDiscovered() {
  $('#disc-host').innerHTML = snap.systems.map((s) => `<button type="button" data-value="${esc(s.host)}" class="${s.host === ui.discHost ? 'active' : ''}">${esc(s.key)}</button>`).join('') || '<button type="button" disabled>no systems</button>';
  const host = ui.discHost;
  const rec = host ? snap.discovered?.[host] : null;
  const sys = systemByHost(host);
  const q = ($('#disc-filter').value || '').trim().toLowerCase();
  if (rec) {
    const details = `${esc(JSON.stringify(rec.methods || {}, null, 1))}${rec.errors?.length ? `\nWarnings:\n${esc(rec.errors.join('\n'))}` : ''}`;
    $('#disc-meta').innerHTML = `<b>${esc(sys?.key || host)}</b> scanned ${esc(ago(rec.scannedAt))} (${esc(fmtDateTime(rec.scannedAt))}) · ${esc(rec.entries.length)} apps${rec.ui5Version ? ` · UI5 ${esc(rec.ui5Version)}` : ''} · <details><summary>details</summary><pre>${details}</pre></details>`;
  } else {
    $('#disc-meta').innerHTML = host ? `<b>${esc(sys?.key || host)}</b> has not been scanned yet. Open its launchpad, or click <b>Rescan</b>, and slashn reads the apps your user can reach.` : 'Add a system first.';
  }
  const discoveredOnly = host ? entriesForHost(host).filter((e) => e.source === 'discovered') : [];
  const list = discoveredOnly.filter((e) => !q || [e.intent, e.title, e.appId, e.alias, ...(e.tcodes || [])].some((v) => String(v || '').toLowerCase().includes(q)));
  const shown = list.slice(0, PAGE * 2);
  renderDiscovered.visible = new Map(shown.map((e) => [e.intent, e]));
  $('#disc-list').innerHTML = shown.map((e) => `<div class="row">
    <div class="row-main">
      <span class="alias">${esc(e.alias ?? '')}</span>
      <span class="title">${esc(e.title)}</span>
      <span class="actions"><button class="sm" data-action="pin-discovered" data-key="${esc(e.intent)}">Pin as alias</button></span>
    </div>
    <div class="row-sub"><span><code>${esc(e.intent)}</code></span>${e.appId ? `<span>${esc(e.appId)}</span>` : ''}${e.tcodes?.length ? `<span>t-codes ${esc(e.tcodes.map((t) => t.toUpperCase()).join(', '))}</span>` : ''}${e.paramKey ? `<span>param ${esc(e.paramKey)}</span>` : ''}</div>
  </div>`).join('') || (host && discoveredOnly.length ? '<div class="row empty-row">Nothing matches.</div>' : '');
  if (list.length > shown.length) $('#disc-list').insertAdjacentHTML('beforeend', `<div class="row empty-row">Showing ${shown.length} of ${list.length} – refine the search.</div>`);

  // Built-in / personal intents the system does not offer (library rows are too many to be useful here).
  const details = $('#disc-missing');
  if (!rec) { details.hidden = true; return; }
  details.hidden = false;
  const have = new Set(rec.entries.map((e) => String(e.intent).toLowerCase()));
  const missing = mergeEntries({ user: snap.userAliases, seed: [...snap.seedAliases, ...snap.importedAliases], hidden: snap.hiddenAliases, edition: sys?.edition || null })
    .filter((e) => e.source !== 'library' && !have.has(e.intent.toLowerCase()) && !/^Shell-/.test(e.intent))
    .sort((a, b) => (a.alias || '~').localeCompare(b.alias || '~') || a.intent.localeCompare(b.intent));
  $('summary', details).textContent = `${missing.length} built-in or personal alias${missing.length === 1 ? '' : 'es'} point to apps this system does not offer`;
  $('#missing-list').innerHTML = missing.slice(0, PAGE * 2).map((e) => `<div class="row"><div class="row-main"><span class="alias">${esc(e.alias ?? '–')}</span><span class="title">${esc(e.title)}</span><span class="badge ${esc(e.source)}">${esc(srcLabel(e))}</span>${e.confidence === 'low' ? '<span class="badge guess">guess</span>' : ''}<span class="muted small" style="margin-left:auto"><code>${esc(e.intent)}</code></span></div></div>`).join('')
    || '<div class="row empty-row">Every built-in and personal alias exists on this system.</div>';
}

// ---- settings / recent

function renderSettings() {
  const f = $('#settings');
  f.suggestionLimit.value = snap.settings.suggestionLimit;
  f.autoScanDays.value = snap.settings.autoScanDays;
  f.reuseTabOnSameHost.checked = Boolean(snap.settings.reuseTabOnSameHost);
}

function renderRecent() {
  const list = (snap.recent || []).slice(0, 10);
  $('#recent-list').innerHTML = list.map((r, i) => `<div class="row">
    <div class="row-main">
      <span class="alias">${esc(r.input)}</span>
      <span class="title">${esc(r.title)}</span>
      <span class="badge">${esc(r.systemKey)}</span>
      ${r.unavailable ? '<span class="badge guess">was unavailable</span>' : ''}
      <span class="actions">${r.guess || r.unresolved ? `<button class="sm" data-action="pin-recent" data-idx="${i}">Pin as alias</button>` : ''}</span>
    </div>
    <div class="row-sub"><span><code>${esc(r.intent)}</code></span><span>${esc(fmtDateTime(r.ts))}</span></div>
  </div>`).join('') || '<div class="row empty-row">Nothing launched yet.</div>';
}

// ---------------------------------------------------------------- settings save

const saveSettings = debounce(async () => {
  const f = $('#settings');
  const limit = Math.min(10, Math.max(1, Number(f.suggestionLimit.value) || 6));
  const days = Math.min(365, Math.max(0, Number(f.autoScanDays.value) || 0));
  await storage.setSettings({ suggestionLimit: limit, autoScanDays: days, reuseTabOnSameHost: f.reuseTabOnSameHost.checked });
  toast('Settings saved');
}, 300);

// ---------------------------------------------------------------- events

document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-action], .tab, .seg button');
  if (!btn) return;
  if (btn.classList.contains('tab')) { ui.tab = btn.dataset.tab; render(); return; }
  if (btn.parentElement?.id === 'alias-source') { ui.aliasSource = btn.dataset.value; renderAliases(); return; }
  if (btn.parentElement?.id === 'disc-host') { ui.discHost = btn.dataset.value; renderDiscovered(); return; }
  const action = btn.dataset.action;
  try {
    switch (action) {
      case 'add-system':
        ui.editHost = NEW; ui.sysDraft = null; ui.sysErrors = [];
        renderSystems();
        $('[data-sys-form] input[name="key"]')?.focus();
        break;
      case 'edit-system':
        ui.editHost = ui.editHost === btn.dataset.host ? null : btn.dataset.host;
        ui.sysDraft = null; ui.sysErrors = [];
        renderSystems();
        break;
      case 'cancel-system':
        ui.editHost = null; ui.sysDraft = null; ui.sysErrors = [];
        renderSystems();
        break;
      case 'delete-system': {
        const sys = systemByHost(btn.dataset.host);
        if (!sys || !confirm(`Delete system "${sys.key}" (${sys.host})? Its discovered apps are removed too.`)) return;
        const systems = snap.systems.filter((s) => s.host !== sys.host);
        if (systems.length && !systems.some((s) => s.isDefault)) systems[0].isDefault = true;
        ui.editHost = null; ui.sysDraft = null; ui.sysErrors = [];
        await storage.setSystems(systems);
        await storage.clearDiscovered(sys.host);
        toast(`Deleted "${sys.key}"`);
        break;
      }
      case 'grant-access': {
        const granted = await requestAccess(systemByHost(btn.dataset.host) || { host: btn.dataset.host });
        ui.access[btn.dataset.host] = granted;
        renderSystems();
        toast(granted ? `Access granted for ${btn.dataset.host}` : 'Access not granted');
        break;
      }
      case 'open-launchpad': {
        const system = systemByHost(btn.dataset.host);
        if (system) chrome.tabs.create({ url: homeUrl(system) });
        break;
      }
      case 'view-discovered':
        ui.discHost = btn.dataset.host; ui.tab = 'discovered';
        render();
        break;
      case 'rescan':
      case 'rescan-selected': {
        const host = action === 'rescan' ? btn.dataset.host : ui.discHost;
        if (!host) return;
        ui.rescanStatus[host] = 'Requesting scan…';
        renderSystems();
        const r = await chrome.runtime.sendMessage({ type: MSG.RESCAN_HOST, host });
        ui.rescanStatus[host] = r?.status === 'messaged' ? 'Scanning…' : r?.status === 'opened' ? 'Launchpad opened – scanning when it loads' : r?.status === 'reloaded' ? 'Tab reloaded – scanning' : (r?.error || 'Scan failed');
        renderSystems();
        toast(ui.rescanStatus[host]);
        setTimeout(() => { delete ui.rescanStatus[host]; renderSystems(); }, 20000);
        break;
      }
      case 'clear-selected':
        if (ui.discHost && confirm(`Forget the discovered apps of ${systemByHost(ui.discHost)?.key || ui.discHost}?`)) { await storage.clearDiscovered(ui.discHost); toast('Cleared'); }
        break;
      case 'export-json': {
        const data = await storage.exportJson({ includeDiscovered: $('#include-discovered').checked });
        download(`slashn-config-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json');
        break;
      }
      case 'import-json': {
        const f = await readFile($('#file-json'));
        if (!f) return;
        const obj = JSON.parse(f.text);
        if (!confirm(`Import ${obj.systems?.length ?? 0} systems and ${obj.userAliases?.length ?? 0} aliases from ${f.name}, replacing the current configuration?`)) return;
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
        ui.aliasSource = 'user';
        toast(`Imported ${entries.length} aliases (${mode})`);
        break;
      }
      case 'export-csv':
        download('slashn-aliases.csv', aliasesToCsv(staticEntries()), 'text/csv');
        break;
      case 'toggle-add-alias':
        ui.showAdd = !ui.showAdd;
        $('#alias-add').hidden = !ui.showAdd;
        if (ui.showAdd) $('#alias-add input[name="alias"]').focus();
        break;
      case 'edit-alias':
        ui.editAlias = ui.editAlias === btn.dataset.key ? null : btn.dataset.key;
        ui.aliasDraft = null;
        renderAliases();
        if (ui.editAlias) $(`[data-alias-form] input[name="alias"]`)?.focus();
        break;
      case 'cancel-alias':
        ui.editAlias = null; ui.aliasDraft = null;
        renderAliases();
        break;
      case 'delete-alias': {
        const e = renderAliases.visible?.get(btn.dataset.key);
        if (!e) return;
        await deleteEntry(e);
        toast(e.source === 'user' || e.source === 'import' ? `Deleted "${e.alias || e.intent}"` : `Hidden "${e.alias || e.intent}" – restore it below`);
        break;
      }
      case 'restore-alias':
        await storage.setHiddenAliases((await storage.getHiddenAliases()).filter((h) => h !== btn.dataset.key));
        toast(`Restored "${btn.dataset.key}"`);
        break;
      case 'pin-discovered': {
        const e = renderDiscovered.visible?.get(btn.dataset.key);
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

document.addEventListener('submit', async (ev) => {
  const form = ev.target;
  if (form.id === 'add-url') {
    ev.preventDefault();
    addFromUrl($('#add-url-input').value).catch((e) => toast(String(e.message || e), 4000));
    return;
  }
  if (form.dataset.sysForm) {
    ev.preventDefault();
    saveSystem(form).catch((e) => { ui.sysErrors = [String(e.message || e)]; renderSystems(); });
    return;
  }
  if (form.dataset.aliasForm) {
    ev.preventDefault();
    saveAlias(form).catch((e) => showErrors('#alias-errors', [String(e.message || e)]));
    return;
  }
  if (form.id === 'alias-add') {
    ev.preventDefault();
    addAlias(form).catch((e) => showErrors('#alias-errors', [String(e.message || e)]));
  }
});

/** "Add alias": target is an intent, or an existing alias / t-code whose app is copied (this is also how a t-code gets mapped). */
async function addAlias(form) {
  const fd = new FormData(form);
  const g = (k) => String(fd.get(k) ?? '').trim();
  const alias = g('alias').toLowerCase();
  const target = g('target');
  const all = staticEntries();
  const base = all.find((e) => e.alias === target.toLowerCase()) || all.find((e) => e.intent.toLowerCase() === target.toLowerCase()) || all.find((e) => (e.tcodes || []).includes(target.toLowerCase()));
  const errors = [];
  if (!ALIAS_RE.test(alias)) errors.push(`Alias "${alias}" may only contain a-z, 0-9, _ . / -`);
  if (!base && !INTENT_RE.test(target)) errors.push(`"${target}" is neither a known alias nor a SemanticObject-action`);
  showErrors('#alias-errors', errors);
  if (errors.length) return;
  const intent = base ? base.intent : target;
  const [semanticObject, action] = splitIntent(intent);
  const clash = all.find((e) => e.alias === alias && e.intent !== intent);
  if (clash && !confirm(`"${alias}" already points to ${clash.intent}. Replace it?`)) return;
  await upsertUserAlias({
    alias, semanticObject, action, intent,
    appId: g('appId') || base?.appId || null,
    tcodes: g('tcodes'),
    title: g('title') || base?.title || intent,
    paramKey: g('paramKey') || base?.paramKey || null,
  }, null);
  form.reset();
  ui.showAdd = false;
  ui.aliasSource = 'user';
  $('#alias-filter').value = '';
  toast(`Added "${alias}" → ${intent}`);
}

document.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.closest('#settings')) { saveSettings(); return; }
  if (el.id === 'alias-edition') renderAliases();
});

// Keep unsaved form values across re-renders triggered by storage changes (e.g. a scan finishing).
document.addEventListener('input', (ev) => {
  const form = ev.target.closest('form');
  if (form?.dataset.sysForm) ui.sysDraft = readSystemForm(form);
  if (form?.dataset.aliasForm) { const fd = new FormData(form); ui.aliasDraft = Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)])); }
});
document.addEventListener('input', debounce((ev) => {
  if (ev.target.id === 'alias-filter') { ui.editAlias = null; renderAliases(); }
  if (ev.target.id === 'disc-filter') renderDiscovered();
}, 120));

$('#add-url-input').addEventListener('paste', (ev) => {
  const text = (ev.clipboardData || window.clipboardData)?.getData('text') || '';
  if (!/^\s*(https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}/i.test(text)) return;
  ev.preventDefault();
  addFromUrl(text).catch((e) => toast(String(e.message || e), 4000));
});

chrome.storage.onChanged.addListener(debounce(() => { refresh().catch((e) => console.warn('[SAPQS] refresh failed', e)); }, 150));

refresh().catch((e) => { console.error('[SAPQS] options failed to load', e); toast('Failed to load: ' + e.message, 6000); });
