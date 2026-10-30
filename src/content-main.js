// slashn — MAIN-world content script. Runs inside the launchpad page.
// No chrome.* here (unavailable in the MAIN world). Talks to the isolated script via window.postMessage.
// Discovery only runs when asked (SAPQS_RESCAN); the service worker owns the "when" decision.
(() => {
  'use strict';
  const NS = 'SAPQS';
  const PM = { MAIN_READY: 'SAPQS_MAIN_READY', RESCAN: 'SAPQS_RESCAN', DISCOVERY: 'SAPQS_DISCOVERY', DISCOVERY_ERROR: 'SAPQS_DISCOVERY_ERROR', CHECK: 'SAPQS_CHECK', CHECK_RESULT: 'SAPQS_CHECK_RESULT' };
  const LOG = '[SAPQS]';
  const POLL_MS = 500;
  const POLL_LIMIT_MS = 60000;
  const MAX_ENTRIES = 5000;
  const log = (...a) => console.debug(LOG, ...a);

  if (window.__sapqsMainLoaded) return;
  window.__sapqsMainLoaded = true;

  const post = (payload) => window.postMessage({ ns: NS, ...payload }, location.origin);
  let inFlight = null;

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const d = event.data;
    if (!d || d.ns !== NS) return;
    if (d.type === PM.RESCAN) scan();
    else if (d.type === PM.CHECK) check(d.id, Array.isArray(d.intents) ? d.intents : []);
  });

  /** Live "can this user navigate there right now?" via the shell's own resolver. Answers { supported:[bool] } in input order. */
  async function check(id, intents) {
    const targets = intents.map((i) => {
      const m = /^([A-Za-z0-9_]+)-([A-Za-z0-9_]+)$/.exec(String(i || '').replace(/^#/, ''));
      return m ? { target: { semanticObject: m[1], action: m[2] } } : null;
    });
    try {
      if (!(window.sap && window.sap.ushell && window.sap.ushell.Container && window.sap.ushell.Container.getServiceAsync)) throw new Error('shell not ready');
      const valid = targets.filter(Boolean);
      let res = null;
      try {
        const nav = await getService('Navigation');
        res = await nav.isNavigationSupported(valid);
      } catch (e) {
        const can = await getService('CrossApplicationNavigation');
        res = await Promise.resolve(can.isNavigationSupported(valid));
      }
      const flags = Array.isArray(res) ? res.map((r) => Boolean(r && r.supported)) : [];
      let j = 0;
      const supported = targets.map((t) => (t ? Boolean(flags[j++]) : false));
      post({ type: PM.CHECK_RESULT, id, supported });
    } catch (e) {
      post({ type: PM.CHECK_RESULT, id, supported: null, error: String((e && e.message) || e) });
    }
  }
  post({ type: PM.MAIN_READY });

  function scan() {
    if (inFlight) return inFlight;
    inFlight = runDiscovery()
      .then((result) => post({ type: PM.DISCOVERY, host: location.hostname, ...result }))
      .catch((e) => post({ type: PM.DISCOVERY_ERROR, host: location.hostname, error: String((e && e.message) || e) }))
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  function waitFor(check, limitMs) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        let ok = false;
        try { ok = Boolean(check()); } catch { ok = false; }
        if (ok) return resolve();
        if (Date.now() - started > limitMs) return reject(new Error('timeout waiting for launchpad shell'));
        setTimeout(tick, POLL_MS);
      };
      tick();
    });
  }

  const idle = () => new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 15000 });
    else setTimeout(resolve, 3000);
  });

  async function getService(name) {
    return window.sap.ushell.Container.getServiceAsync(name);
  }

  function parseIntent(raw) {
    const s = String(raw || '').replace(/^#/, '');
    const q = s.indexOf('?');
    const base = (q >= 0 ? s.slice(0, q) : s).split('&')[0];
    const m = /^([A-Za-z0-9_]+)-([A-Za-z0-9_]+)$/.exec(base);
    if (!m) return null;
    const params = [];
    if (q >= 0) {
      for (const kv of s.slice(q + 1).split('&')) {
        let k = '';
        try { k = decodeURIComponent(kv.split('=')[0] || ''); } catch { k = ''; }
        if (k && !k.startsWith('sap-') && !k.startsWith('/')) params.push(k);
      }
    }
    return { intent: base, semanticObject: m[1], action: m[2], params };
  }

  async function getLinksAll(methods, errors) {
    let svc = null;
    try {
      svc = await getService('Navigation');
      methods.service = 'Navigation';
    } catch (e) {
      errors.push('Navigation: ' + e);
    }
    if (svc) {
      try {
        const res = await svc.getLinks([{}]);
        const flat = Array.isArray(res) ? res.flat() : [];
        if (flat.length) { methods.links = 'Navigation.getLinks([{}])'; return flat; }
      } catch (e) { errors.push('Navigation.getLinks: ' + e); }
      try {
        const sos = await svc.getSemanticObjects();
        const res = await svc.getLinks(sos.map((semanticObject) => ({ semanticObject })));
        const flat = Array.isArray(res) ? res.flat() : [];
        if (flat.length) { methods.links = 'Navigation.getSemanticObjects+getLinks'; return flat; }
      } catch (e) { errors.push('Navigation per-SO: ' + e); }
    }
    let can = null;
    try {
      can = await getService('CrossApplicationNavigation');
      methods.service = methods.service || 'CrossApplicationNavigation';
    } catch (e) {
      errors.push('CrossApplicationNavigation: ' + e);
    }
    if (can) {
      try {
        const res = await can.getLinks({ ignoreFormFactor: true });
        if (Array.isArray(res) && res.length) { methods.links = 'CAN.getLinks({})'; return res; }
      } catch (e) { errors.push('CAN.getLinks: ' + e); }
      try {
        const sos = await can.getSemanticObjects();
        const out = [];
        for (let i = 0; i < sos.length; i += 20) {
          const chunk = sos.slice(i, i + 20);
          const results = await Promise.all(chunk.map((so) => Promise.resolve(can.getLinks({ semanticObject: so, ignoreFormFactor: true })).catch(() => [])));
          for (const r of results) if (Array.isArray(r)) out.push(...r);
        }
        if (out.length) { methods.links = 'CAN.getSemanticObjects+getLinks'; return out; }
      } catch (e) { errors.push('CAN per-SO: ' + e); }
    }
    throw new Error('no navigation links available: ' + errors.join(' | '));
  }

  function pickAppId(ids) {
    const list = Array.isArray(ids) ? ids : ids ? [ids] : [];
    return list.map(String).find((id) => /^[A-Z]{1,2}\d{3,5}[A-Z]?$/.test(id)) || null;
  }

  async function getSearchableIndex(methods, errors) {
    const map = new Map();
    try {
      const svc = await getService('SearchableContent');
      const apps = await svc.getApps({ includeAppsWithoutVisualizations: true });
      for (const app of apps || []) {
        const t = app.target || {};
        if (!t.semanticObject || !t.action) continue;
        const attrs = app.technicalAttributes || {};
        const fiori = attrs['sap.fiori'] || {};
        const appId = pickAppId(fiori.registrationIds || attrs.registrationIds || attrs['sap.fiori.registrationIds']) || pickAppId(app.id);
        map.set(`${t.semanticObject}-${t.action}`, { title: app.title, subtitle: app.subtitle, appId });
      }
      methods.searchable = map.size;
    } catch (e) {
      errors.push('SearchableContent: ' + e);
    }
    return map;
  }

  async function getCdmIndex(methods, errors) {
    const map = new Map();
    try {
      const svc = await getService('CommonDataModel');
      const apps = await svc.getApplications();
      for (const desc of Object.values(apps || {})) {
        const app = (desc && desc['sap.app']) || {};
        const inbounds = (app.crossNavigation && app.crossNavigation.inbounds) || {};
        const appId = pickAppId(desc && desc['sap.fiori'] && desc['sap.fiori'].registrationIds);
        for (const ib of Object.values(inbounds)) {
          if (!ib || !ib.semanticObject || !ib.action) continue;
          const key = `${ib.semanticObject}-${ib.action}`;
          if (!map.has(key)) map.set(key, { title: ib.title || app.title, appId });
        }
      }
      methods.cdm = map.size;
    } catch (e) {
      errors.push('CommonDataModel: ' + e);
    }
    return map;
  }

  /** The same fields the launchpad's About dialog shows (sap.ushell.Container.getLogonSystem()). */
  function readSystemInfo(errors) {
    try {
      const sys = window.sap.ushell.Container.getLogonSystem && window.sap.ushell.Container.getLogonSystem();
      if (!sys) return null;
      const out = {};
      for (const [key, getter] of [['productName', 'getProductName'], ['productVersion', 'getProductVersion'], ['systemName', 'getSystemName'], ['systemRole', 'getSystemRole'], ['tenantRole', 'getTenantRole'], ['client', 'getClient']]) {
        try { const v = typeof sys[getter] === 'function' ? sys[getter]() : undefined; if (typeof v === 'string' && v.trim()) out[key] = v.trim(); } catch { /* optional getter */ }
      }
      return Object.keys(out).length ? out : null;
    } catch (e) {
      errors.push('system info: ' + (e && e.message ? e.message : e));
      return null;
    }
  }

  async function runDiscovery() {
    const started = performance.now();
    const methods = {};
    const errors = [];
    await waitFor(() => window.sap && window.sap.ushell && window.sap.ushell.Container && window.sap.ushell.Container.getServiceAsync, POLL_LIMIT_MS);
    await waitFor(() => { try { return Boolean(window.sap.ushell.Container.getRenderer()); } catch { return true; } }, POLL_LIMIT_MS).catch(() => {});
    await idle();
    const links = await getLinksAll(methods, errors);
    const [searchable, cdm] = await Promise.all([getSearchableIndex(methods, errors), getCdmIndex(methods, errors)]);

    const byIntent = new Map();
    for (const link of links) {
      const p = parseIntent(link && link.intent);
      if (!p) continue;
      let rec = byIntent.get(p.intent);
      if (!rec) {
        rec = { intent: p.intent, semanticObject: p.semanticObject, action: p.action, title: String(link.text || '').trim(), appId: null, paramKey: null, _paramSets: [] };
        byIntent.set(p.intent, rec);
      } else if (!rec.title && link.text) {
        rec.title = String(link.text).trim();
      }
      rec._paramSets.push(p.params);
    }
    const entries = [];
    for (const rec of byIntent.values()) {
      const extra = searchable.get(rec.intent) || cdm.get(rec.intent) || null;
      if (extra) {
        if (!rec.title && extra.title) rec.title = String(extra.title).trim();
        if (extra.appId) rec.appId = extra.appId;
      }
      const sets = rec._paramSets.filter((s) => s.length);
      if (sets.length && sets.every((s) => s.length === 1 && s[0] === sets[0][0])) rec.paramKey = sets[0][0];
      delete rec._paramSets;
      if (!rec.title) rec.title = rec.intent;
      entries.push(rec);
      if (entries.length >= MAX_ENTRIES) break;
    }
    const ui5Version = (() => { try { return window.sap.ui.version; } catch { return null; } })();
    const system = readSystemInfo(errors);
    log('discovery done', entries.length, 'intents in', Math.round(performance.now() - started), 'ms', methods, system, errors.length ? errors : '');
    return { entries, ui5Version, system, methods, errors, scannedAt: new Date().toISOString() };
  }
})();
