import { MSG } from '../messages.js';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== MSG.COPY) return false;
  let ok = false;
  try {
    const buf = document.getElementById('buf');
    buf.value = String(msg.text ?? '');
    buf.select();
    ok = document.execCommand('copy');
  } catch (e) {
    console.warn('[SAPQS] offscreen copy failed', e);
  }
  sendResponse({ ok });
  return false;
});
