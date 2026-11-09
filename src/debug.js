// slashn — shell debug calls. A catalogue of the launchpad APIs the extension relies on, each runnable on demand
// in an open launchpad tab (MAIN world, via chrome.scripting.executeScript) so their raw answers can be inspected.
// runDebugCallInPage is serialised into the page: it must not reference anything outside its own body.

/** { id, group, label, params?: default JSON params, hint } */
export const DEBUG_CALLS = Object.freeze([
  { id: 'logon.all', group: 'Logon system (About › System)', label: 'getLogonSystem() – every getter', hint: 'Calls each get* method on sap.ushell.Container.getLogonSystem() and lists what came back, including the ones that throw.' },
  { id: 'logon.getProductName', group: 'Logon system (About › System)', label: 'getProductName()' },
  { id: 'logon.getProductVersion', group: 'Logon system (About › System)', label: 'getProductVersion()' },
  { id: 'logon.getSystemName', group: 'Logon system (About › System)', label: 'getSystemName()' },
  { id: 'logon.getSystemRole', group: 'Logon system (About › System)', label: 'getSystemRole()' },
  { id: 'logon.getTenantRole', group: 'Logon system (About › System)', label: 'getTenantRole()' },
  { id: 'logon.getClient', group: 'Logon system (About › System)', label: 'getClient()' },
  { id: 'logon.getName', group: 'Logon system (About › System)', label: 'getName()' },
  { id: 'logon.getPlatform', group: 'Logon system (About › System)', label: 'getPlatform()' },
  { id: 'app.getAllAppInfo', group: 'AppLifeCycle (About › Application)', label: 'getCurrentApplication().getAllAppInfo(flag)', params: true, hint: 'What the About dialog itself calls for its Application section (true, then false for custom entries). "Version" there is the appVersion key.' },
  { id: 'app.getInfo', group: 'AppLifeCycle (About › Application)', label: 'getCurrentApplication().getInfo(keys)', params: ['appVersion', 'appTitle', 'appId', 'transaction', 'appIntent', 'appSupportInfo', 'technicalAppComponentId', 'appFrameworkId', 'appFrameworkVersion', 'contentProviderLabel', 'theme', 'languageTag', 'url', 'applicationParams'], hint: 'Params: the array of keys to request. Unsupported keys are simply absent from the answer.' },
  { id: 'app.manifestVersion', group: 'AppLifeCycle (About › Application)', label: 'componentInstance manifest: sap.app id / applicationVersion', hint: 'Reads /sap.app/id, /sap.app/applicationVersion/version and /sap.app/title straight from the running component\'s manifest, the source the shell uses for appVersion.' },
  { id: 'app.current', group: 'AppLifeCycle (About › Application)', label: 'getCurrentApplication() – summary', hint: 'applicationType, homePage, intent and the methods the object exposes.' },
  { id: 'shell.versions', group: 'Shell', label: 'sap.ui.version, ushell version, FLP platform', hint: 'sap.ui.version, sap.ushell.Container.getFLPPlatform(), and the ushell library version from sap.ui.getVersionInfo when available.' },
  { id: 'shell.user', group: 'Shell', label: 'getUser() – id, language, theme', hint: 'Only non-personal fields: getId(), getLanguage(), getTheme(), isJamActive().' },
  { id: 'shell.services', group: 'Shell', label: 'getServiceAsync(name) – which services exist', params: ['Navigation', 'CrossApplicationNavigation', 'AppLifeCycle', 'SearchableContent', 'CommonDataModel', 'URLParsing', 'UserInfo', 'Personalization', 'Bookmark'], hint: 'Params: service names to try. Lists the ones that resolve and the methods they expose.' },
  { id: 'nav.getLinks', group: 'Navigation', label: 'Navigation.getLinks([{}])', hint: 'Count and the first entries. The scan uses this first.' },
  { id: 'nav.getSemanticObjects', group: 'Navigation', label: 'Navigation.getSemanticObjects()' },
  { id: 'nav.isNavigationSupported', group: 'Navigation', label: 'Navigation.isNavigationSupported(intents)', params: ['PurchaseOrder-manage', 'Shell-startGUI', 'Shell-home'], hint: 'Params: intents to check for the current session. Falls back to CrossApplicationNavigation.' },
  { id: 'nav.resolve', group: 'Navigation', label: 'NavTargetResolution.resolveHashFragment(hash)', params: '#Shell-startGUI?sap-ui2-tcode=VA01', hint: 'Params: the hash to resolve. Shows the target the launchpad would start (application type, URL, system alias) or the resolution error behind "Could not open app".' },
  { id: 'can.getLinks', group: 'Navigation', label: 'CrossApplicationNavigation.getLinks({ignoreFormFactor:true})', hint: 'The fallback for UI5 releases before 1.120.' },
  { id: 'can.getSemanticObjects', group: 'Navigation', label: 'CrossApplicationNavigation.getSemanticObjects()' },
  { id: 'content.searchable', group: 'Content', label: 'SearchableContent.getApps()', hint: 'Count, and the first apps with their target and technical attributes.' },
  { id: 'content.cdm', group: 'Content', label: 'CommonDataModel.getApplications()', hint: 'Count, and the first application descriptors (sap.app, sap.fiori, inbounds).' },
]);

export const debugCallById = (id) => DEBUG_CALLS.find((c) => c.id === id) || null;

/**
 * Runs inside the page (MAIN world). Returns { ok, ms, result } or { ok:false, ms, error }, with `result` reduced to a
 * JSON-safe, bounded value (depth 5, 60 array items, 400-character strings, cycles marked) so executeScript can return it.
 */
export function runDebugCallInPage(id, params) {
  const started = Date.now();
  const LIMIT = { depth: 5, items: 60, chars: 400 };
  function safe(v, depth, seen) {
    if (v === null || v === undefined) return v === undefined ? '«undefined»' : null;
    const t = typeof v;
    if (t === 'string') return v.length > LIMIT.chars ? v.slice(0, LIMIT.chars) + '…(' + v.length + ' chars)' : v;
    if (t === 'number' || t === 'boolean') return v;
    if (t === 'bigint') return String(v) + 'n';
    if (t === 'function') return '«function ' + (v.name || 'anonymous') + '»';
    if (t === 'symbol') return String(v);
    if (seen.indexOf(v) >= 0) return '«cycle»';
    if (depth >= LIMIT.depth) return Array.isArray(v) ? '«array[' + v.length + ']»' : '«object ' + (v.constructor && v.constructor.name ? v.constructor.name : 'Object') + '»';
    seen.push(v);
    try {
      if (Array.isArray(v)) {
        const out = v.slice(0, LIMIT.items).map((x) => safe(x, depth + 1, seen));
        if (v.length > LIMIT.items) out.push('…(' + v.length + ' items)');
        return out;
      }
      if (v instanceof Error) return { name: v.name, message: v.message };
      if (v instanceof Map) return safe(Array.from(v.entries()), depth, seen);
      if (v instanceof Set) return safe(Array.from(v.values()), depth, seen);
      const out = {};
      let n = 0;
      for (const k in v) {
        if (n++ >= LIMIT.items) { out['…'] = 'more keys'; break; }
        try { out[k] = safe(v[k], depth + 1, seen); } catch (e) { out[k] = '«throws: ' + (e && e.message) + '»'; }
      }
      if (!n && v.constructor && v.constructor.name && v.constructor.name !== 'Object') out['«type»'] = v.constructor.name;
      return out;
    } finally {
      seen.pop();
    }
  }
  const methodsOf = (o) => {
    const names = new Set();
    let p = o;
    while (p && p !== Object.prototype) {
      for (const k of Object.getOwnPropertyNames(p)) { try { if (typeof o[k] === 'function' && k !== 'constructor') names.add(k); } catch (e) { /* getter */ } }
      p = Object.getPrototypeOf(p);
    }
    return Array.from(names).sort();
  };
  const container = () => {
    const c = window.sap && window.sap.ushell && window.sap.ushell.Container;
    if (!c) throw new Error('sap.ushell.Container is not available on this page (not a launchpad, or not loaded yet)');
    return c;
  };
  const service = (name) => container().getServiceAsync(name);
  const logon = () => {
    const sys = container().getLogonSystem && container().getLogonSystem();
    if (!sys) throw new Error('getLogonSystem() returned nothing');
    return sys;
  };
  const sample = (list, n) => ({ count: list.length, first: list.slice(0, n) });

  const run = async () => {
    if (id === 'logon.all') {
      const sys = logon();
      const out = {};
      for (const m of methodsOf(sys)) {
        if (!/^(get|is|has)/.test(m) || m.length > 40) continue;
        try { out[m + '()'] = sys[m](); } catch (e) { out[m + '()'] = '«throws: ' + (e && e.message) + '»'; }
      }
      return out;
    }
    if (id.indexOf('logon.') === 0) {
      const m = id.slice('logon.'.length);
      const sys = logon();
      if (typeof sys[m] !== 'function') throw new Error('getLogonSystem().' + m + ' is not a function on this release; available: ' + methodsOf(sys).join(', '));
      return sys[m]();
    }
    if (id === 'app.getInfo') {
      const svc = await service('AppLifeCycle');
      const app = svc.getCurrentApplication && svc.getCurrentApplication();
      if (!app) throw new Error('getCurrentApplication() returned nothing');
      if (typeof app.getInfo !== 'function') throw new Error('getInfo is not available on this release; methods: ' + methodsOf(app).join(', '));
      return app.getInfo(Array.isArray(params) ? params : []);
    }
    if (id === 'app.getAllAppInfo') {
      const svc = await service('AppLifeCycle');
      const app = svc.getCurrentApplication && svc.getCurrentApplication();
      if (!app) throw new Error('getCurrentApplication() returned nothing');
      if (typeof app.getAllAppInfo !== 'function') throw new Error('getAllAppInfo is not available on this release; methods: ' + methodsOf(app).join(', '));
      return app.getAllAppInfo(params === undefined || params === null ? true : params);
    }
    if (id === 'app.manifestVersion') {
      const svc = await service('AppLifeCycle');
      const app = svc.getCurrentApplication && svc.getCurrentApplication();
      const comp = app && app.componentInstance;
      if (!comp) throw new Error('the current application has no componentInstance (not a UI5 app, or an older release)');
      const out = {};
      for (const path of ['/sap.app/id', '/sap.app/applicationVersion/version', '/sap.app/title', '/sap.ui5/componentName', '/sap.fiori/registrationIds']) {
        try { out[path] = typeof comp.getManifestEntry === 'function' ? comp.getManifestEntry(path) : '«getManifestEntry not available»'; } catch (e) { out[path] = '«throws: ' + (e && e.message) + '»'; }
      }
      return out;
    }
    if (id === 'app.current') {
      const svc = await service('AppLifeCycle');
      const app = svc.getCurrentApplication && svc.getCurrentApplication();
      if (!app) return null;
      const out = { methods: methodsOf(app) };
      for (const k of ['applicationType', 'homePage', 'intent', 'componentInstance']) if (k in app) out[k] = app[k];
      try { if (typeof app.getIntent === 'function') out['getIntent()'] = await app.getIntent(); } catch (e) { out['getIntent()'] = '«throws: ' + (e && e.message) + '»'; }
      return out;
    }
    if (id === 'shell.versions') {
      const out = {};
      try { out['sap.ui.version'] = window.sap.ui.version; } catch (e) { out['sap.ui.version'] = '«throws»'; }
      try { out['getFLPPlatform()'] = container().getFLPPlatform ? container().getFLPPlatform() : '«not available»'; } catch (e) { out['getFLPPlatform()'] = '«throws: ' + (e && e.message) + '»'; }
      try {
        const info = window.sap.ui.getVersionInfo && (await window.sap.ui.getVersionInfo({ library: 'sap.ushell', async: true }));
        out['sap.ushell library'] = info ? { name: info.name, version: info.version, buildTimestamp: info.buildTimestamp } : '«getVersionInfo not available»';
      } catch (e) { out['sap.ushell library'] = '«throws: ' + (e && e.message) + '»'; }
      return out;
    }
    if (id === 'shell.user') {
      const u = container().getUser && container().getUser();
      if (!u) throw new Error('getUser() returned nothing');
      const out = { methods: methodsOf(u) };
      for (const m of ['getId', 'getLanguage', 'getTheme', 'isJamActive']) { try { if (typeof u[m] === 'function') out[m + '()'] = u[m](); } catch (e) { out[m + '()'] = '«throws: ' + (e && e.message) + '»'; } }
      return out;
    }
    if (id === 'shell.services') {
      const out = {};
      for (const name of Array.isArray(params) ? params : []) {
        try { const svc = await service(name); out[name] = { methods: methodsOf(svc) }; } catch (e) { out[name] = '«unavailable: ' + (e && e.message) + '»'; }
      }
      return out;
    }
    if (id === 'nav.getLinks') { const svc = await service('Navigation'); const res = await svc.getLinks([{}]); return sample(Array.isArray(res) ? res.flat() : [], 25); }
    if (id === 'nav.getSemanticObjects') { const svc = await service('Navigation'); const res = await svc.getSemanticObjects(); return sample(res || [], 60); }
    if (id === 'nav.isNavigationSupported') {
      const intents = (Array.isArray(params) ? params : []).map(String);
      const targets = intents.map((i) => { const m = /^#?([A-Za-z0-9_]+)-([A-Za-z0-9_]+)/.exec(i); return m ? { target: { semanticObject: m[1], action: m[2] } } : null; }).filter(Boolean);
      let via = 'Navigation';
      let res;
      try { const svc = await service('Navigation'); res = await svc.isNavigationSupported(targets); } catch (e) { via = 'CrossApplicationNavigation (' + (e && e.message) + ')'; const can = await service('CrossApplicationNavigation'); res = await Promise.resolve(can.isNavigationSupported(targets)); }
      return { via, intents, result: res };
    }
    if (id === 'nav.resolve') {
      const hash = typeof params === 'string' && params.trim() ? params.trim() : '#Shell-home';
      const svc = await service('NavTargetResolution');
      const res = await svc.resolveHashFragment(hash.startsWith('#') ? hash : '#' + hash);
      return { hash, resolved: res };
    }
    if (id === 'can.getLinks') { const can = await service('CrossApplicationNavigation'); const res = await can.getLinks({ ignoreFormFactor: true }); return sample(Array.isArray(res) ? res : [], 25); }
    if (id === 'can.getSemanticObjects') { const can = await service('CrossApplicationNavigation'); const res = await can.getSemanticObjects(); return sample(res || [], 60); }
    if (id === 'content.searchable') { const svc = await service('SearchableContent'); const apps = await svc.getApps({ includeAppsWithoutVisualizations: true }); return sample(apps || [], 10); }
    if (id === 'content.cdm') {
      const svc = await service('CommonDataModel');
      const apps = await svc.getApplications();
      const keys = Object.keys(apps || {});
      const first = {};
      for (const k of keys.slice(0, 5)) first[k] = apps[k];
      return { count: keys.length, first };
    }
    throw new Error('unknown debug call: ' + id);
  };

  return run().then(
    (result) => ({ ok: true, ms: Date.now() - started, result: safe(result, 0, []) }),
    (e) => ({ ok: false, ms: Date.now() - started, error: String((e && e.message) || e), stack: e && e.stack ? String(e.stack).split('\n').slice(0, 4).join('\n') : undefined }),
  );
}

/** Parses the params box of the debug page: JSON when it parses, otherwise the raw string (a hash, an intent). */
export function parseDebugParams(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { return t; }
}
