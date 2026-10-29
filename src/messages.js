// Message type constants shared by the service worker, options page and offscreen page.
// The two content scripts cannot import modules, so they repeat these literals; keep in sync.
export const NS = 'SAPQS';

/** window.postMessage between page (MAIN world) and isolated content script. Payload: { ns:'SAPQS', type, ... } */
export const PM = Object.freeze({
  MAIN_READY: 'SAPQS_MAIN_READY',
  RESCAN: 'SAPQS_RESCAN',
  DISCOVERY: 'SAPQS_DISCOVERY',
  DISCOVERY_ERROR: 'SAPQS_DISCOVERY_ERROR',
});

/** chrome.runtime / chrome.tabs messaging. Payload: { type, ... } */
export const MSG = Object.freeze({
  PAGE_READY: 'SAPQS_PAGE_READY',             // isolated → SW   { host, url }     reply { scan, reason }
  DISCOVERY_RESULT: 'SAPQS_DISCOVERY_RESULT', // isolated → SW   { host, entries, scannedAt, ui5Version, methods } reply { stored }
  RESCAN_TAB: 'SAPQS_RESCAN_TAB',             // SW → isolated   {}
  RESCAN_HOST: 'SAPQS_RESCAN_HOST',           // options → SW    { host }          reply { status }
  COPY: 'SAPQS_COPY',                         // SW → offscreen  { text }          reply { ok }
  GET_STATE: 'SAPQS_GET_STATE',               // options → SW    {}                reply { snapshot }
});

export const LOG_PREFIX = '[SAPQS]';
