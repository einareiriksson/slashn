// slashn — isolated-world content script: bridge between the page (MAIN world) and the service worker.
(() => {
  'use strict';
  const NS = 'SAPQS';
  const PM = { MAIN_READY: 'SAPQS_MAIN_READY', RESCAN: 'SAPQS_RESCAN', DISCOVERY: 'SAPQS_DISCOVERY', DISCOVERY_ERROR: 'SAPQS_DISCOVERY_ERROR', CHECK: 'SAPQS_CHECK', CHECK_RESULT: 'SAPQS_CHECK_RESULT' };
  const MSG = { PAGE_READY: 'SAPQS_PAGE_READY', DISCOVERY_RESULT: 'SAPQS_DISCOVERY_RESULT', RESCAN_TAB: 'SAPQS_RESCAN_TAB', CHECK_INTENTS: 'SAPQS_CHECK_INTENTS' };
  const CHECK_TIMEOUT_MS = 2500;
  const MAX_CHECK = 50;
  const LOG = '[SAPQS]';
  const INTENT_RE = /^[A-Za-z0-9_]+-[A-Za-z0-9_]+$/;
  const MAX_ENTRIES = 5000;
  const SYSTEM_INFO_FIELDS = ['productName', 'productVersion', 'systemName', 'systemRole', 'tenantRole', 'client'];
  const systemInfo = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    for (const k of SYSTEM_INFO_FIELDS) if (typeof raw[k] === 'string' && raw[k].trim()) out[k] = raw[k].trim().slice(0, 120);
    return Object.keys(out).length ? out : null;
  };
  const log = (...a) => console.debug(LOG, ...a);

  if (window.__sapqsIsoLoaded) return;
  window.__sapqsIsoLoaded = true;

  let wantScan = false;
  let mainReady = false;
  let checkSeq = 0;
  const pendingChecks = new Map(); // id → resolve

  function checkIntents(intents) {
    return new Promise((resolve) => {
      const id = ++checkSeq;
      const timer = setTimeout(() => { pendingChecks.delete(id); resolve({ supported: null, error: 'timeout' }); }, CHECK_TIMEOUT_MS);
      pendingChecks.set(id, (r) => { clearTimeout(timer); resolve(r); });
      toPage(PM.CHECK, { id, intents });
    });
  }

  const toPage = (type, extra) => window.postMessage({ ns: NS, type, ...(extra || {}) }, location.origin);
  const toWorker = async (msg) => {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      log('worker unreachable (extension reloaded?)', e && e.message);
      return null;
    }
  };

  function requestScan() {
    wantScan = true;
    if (mainReady) {
      toPage(PM.RESCAN);
      wantScan = false;
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const d = event.data;
    if (!d || d.ns !== NS) return;
    if (d.type === PM.MAIN_READY) {
      mainReady = true;
      if (wantScan) requestScan();
      return;
    }
    if (d.type === PM.CHECK_RESULT) {
      const done = pendingChecks.get(d.id);
      if (done) {
        pendingChecks.delete(d.id);
        done({ supported: Array.isArray(d.supported) ? d.supported.map(Boolean) : null, error: d.error ? String(d.error) : undefined });
      }
      return;
    }
    if (d.type === PM.DISCOVERY_ERROR) {
      log('discovery error', d.error);
      return;
    }
    if (d.type === PM.DISCOVERY) {
      const entries = Array.isArray(d.entries)
        ? d.entries.slice(0, MAX_ENTRIES)
          .filter((e) => e && typeof e.intent === 'string' && INTENT_RE.test(e.intent))
          .map((e) => ({
            intent: e.intent,
            semanticObject: typeof e.semanticObject === 'string' ? e.semanticObject : e.intent.split('-')[0],
            action: typeof e.action === 'string' ? e.action : e.intent.slice(e.intent.indexOf('-') + 1),
            title: typeof e.title === 'string' ? e.title : e.intent,
            appId: typeof e.appId === 'string' ? e.appId : null,
            paramKey: typeof e.paramKey === 'string' ? e.paramKey : null,
          }))
        : [];
      toWorker({
        type: MSG.DISCOVERY_RESULT,
        host: location.hostname,
        entries,
        ui5Version: typeof d.ui5Version === 'string' ? d.ui5Version : null,
        system: systemInfo(d.system),
        methods: d.methods && typeof d.methods === 'object' ? d.methods : {},
        errors: Array.isArray(d.errors) ? d.errors.map(String) : [],
      }).then((r) => log('discovery stored', r));
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return false;
    if (msg.type === MSG.RESCAN_TAB) {
      requestScan();
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === MSG.CHECK_INTENTS) {
      const intents = (Array.isArray(msg.intents) ? msg.intents : []).slice(0, MAX_CHECK).filter((i) => typeof i === 'string' && INTENT_RE.test(i));
      checkIntents(intents).then((r) => sendResponse({ intents, ...r }));
      return true; // async
    }
    return false;
  });

  // The MAIN script runs at document_start and posts MAIN_READY; if that arrived before this listener existed,
  // the RESCAN is simply posted now and the MAIN script's listener (already installed) picks it up.
  mainReady = true;
  toWorker({ type: MSG.PAGE_READY, host: location.hostname, url: location.href }).then((reply) => {
    log('page ready', reply);
    if (reply && reply.scan) requestScan();
  });
})();
