// SAP QuickStart — isolated-world content script: bridge between the page (MAIN world) and the service worker.
(() => {
  'use strict';
  const NS = 'SAPQS';
  const PM = { MAIN_READY: 'SAPQS_MAIN_READY', RESCAN: 'SAPQS_RESCAN', DISCOVERY: 'SAPQS_DISCOVERY', DISCOVERY_ERROR: 'SAPQS_DISCOVERY_ERROR' };
  const MSG = { PAGE_READY: 'SAPQS_PAGE_READY', DISCOVERY_RESULT: 'SAPQS_DISCOVERY_RESULT', RESCAN_TAB: 'SAPQS_RESCAN_TAB' };
  const LOG = '[SAPQS]';
  const INTENT_RE = /^[A-Za-z0-9_]+-[A-Za-z0-9_]+$/;
  const MAX_ENTRIES = 5000;
  const log = (...a) => console.debug(LOG, ...a);

  let wantScan = false;
  let mainReady = false;

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
        methods: d.methods && typeof d.methods === 'object' ? d.methods : {},
        errors: Array.isArray(d.errors) ? d.errors.map(String) : [],
      }).then((r) => log('discovery stored', r));
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== MSG.RESCAN_TAB) return false;
    requestScan();
    sendResponse({ ok: true });
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
