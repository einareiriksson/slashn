// Message type constants shared by the service worker, options page and offscreen page.
// The two content scripts cannot import modules, so they repeat these literals; keep in sync.
export const NS = 'SAPQS';

/** window.postMessage between page (MAIN world) and isolated content script. Payload: { ns:'SAPQS', type, ... } */
export const PM = Object.freeze({
  MAIN_READY: 'SAPQS_MAIN_READY',
  RESCAN: 'SAPQS_RESCAN',
  DISCOVERY: 'SAPQS_DISCOVERY',
  DISCOVERY_ERROR: 'SAPQS_DISCOVERY_ERROR',
  CHECK: 'SAPQS_CHECK',                 // isolated → page { id, intents:[] }
  CHECK_RESULT: 'SAPQS_CHECK_RESULT',   // page → isolated { id, supported:[bool], error? }
});

/** chrome.runtime / chrome.tabs messaging. Payload: { type, ... } */
export const MSG = Object.freeze({
  PAGE_READY: 'SAPQS_PAGE_READY',             // isolated → SW   { host, url }     reply { scan, reason }
  DISCOVERY_RESULT: 'SAPQS_DISCOVERY_RESULT', // isolated → SW   { host, entries, scannedAt, ui5Version, methods } reply { stored }
  RESCAN_TAB: 'SAPQS_RESCAN_TAB',             // SW → isolated   {}
  CHECK_INTENTS: 'SAPQS_CHECK_INTENTS',       // SW → isolated   { intents:[] }    reply { supported:[bool] | null, error? }
  LIVE_CHECK: 'SAPQS_LIVE_CHECK',             // popup → SW      { host, intents:[] } reply { available: {intent:bool} | null, reason }
  RESCAN_HOST: 'SAPQS_RESCAN_HOST',           // options → SW    { host }          reply { status }
  COPY: 'SAPQS_COPY',                         // SW → offscreen  { text }          reply { ok }
  GET_STATE: 'SAPQS_GET_STATE',               // options/popup → SW {}             reply { snapshot }
  RESOLVE: 'SAPQS_RESOLVE',                   // popup → SW      { text }          reply { kind, system, hint, matches }
  NAVIGATE: 'SAPQS_NAVIGATE',                 // popup → SW      { text, disposition, contextHost, force }  reply { action:'open'|'blocked'|…, reason }
  OPEN_URL: 'SAPQS_OPEN_URL',                 // popup → SW      { url, host, disposition }
  OPEN_SYSTEM_INFO: 'SAPQS_OPEN_SYSTEM_INFO', // popup/options → SW { host }      reply { windowId } – opens or focuses the system-info dialog window
  OPEN_LAUNCHER: 'SAPQS_OPEN_LAUNCHER',       // options → SW    {}                reply { windowId, tabId } – the centred launcher window (also the keyboard command)
  PROBE_SYSTEM: 'SAPQS_PROBE_SYSTEM',         // sysinfo → SW    { host }          reply { launchpad, system, ui5Version, tabId } | { launchpad:false, reason }
  OPEN_DEBUG: 'SAPQS_OPEN_DEBUG',             // sysinfo/options → SW { host? }    reply { windowId } – opens or focuses the shell debug window
  LAUNCHER_HELLO: 'SAPQS_LAUNCHER_HELLO',     // popup → SW      { nonce }         reply { ok } – the launcher page renders only when the worker opened it (web pages can frame the page, but not know the nonce)
  DEBUG_CALL: 'SAPQS_DEBUG_CALL',             // debug → SW      { host, call, params } reply { ok, ms, result | error, tabId } | { launchpad:false, reason }
});

export const LOG_PREFIX = '[SAPQS]';
