// Smoke test of the embedding API under JavaScriptCore's shell (no URL, TextEncoder, structuredClone, console, timers):
//   npm run test:jsc   →   .../JavaScriptCore.framework/Versions/A/Helpers/jsc -m test/embed.jsc.mjs   (from the repo root)
// Catches web-API leaks the Node tests cannot see, and keeps the cold-start cost in view.
import * as core from '../src/embed.js';

const fail = (msg) => { throw new Error(`embed.jsc: ${msg}`); };
const ok = (cond, msg) => { if (!cond) fail(msg); };

for (const g of ['URL', 'URLSearchParams', 'TextEncoder', 'structuredClone', 'console']) { // the shell has setTimeout; a JSContext does not
  ok(typeof globalThis[g] === 'undefined', `${g} is defined: this shell is not the bare JavaScriptCore the test is for`);
}

const seed = {
  aliasesCsv: readFile('src/seed/aliases.csv'),
  libraryCsv: readFile('src/seed/library.csv'),
  tcodesCsv: readFile('src/seed/tcodes.csv'),
  tcodeAppsJson: readFile('src/seed/tcode-apps.json'),
};
const config = {
  format: 'slashn-config',
  systems: [
    { key: 'acd', host: 'my1.s4hana.cloud.sap', isDefault: true },
    { key: 'erp', host: 'erp.example.com', launchpadQuery: 'sap-client=100', edition: 'onprem', gui: { serviceUuid: 'u', client: '100' } },
    { key: 'gui', host: '', launchpad: false, edition: 'onprem', gui: { serviceUuid: 'u', client: '800' } },
  ],
};

const t0 = Date.now();
const init = JSON.parse(core.json.init(JSON.stringify(seed), JSON.stringify(config)));
const initMs = Date.now() - t0;
ok(init.entryCount > 15000, `seed loaded: ${init.entryCount}`);
ok(init.seedErrors.length === 0, `seed errors: ${JSON.stringify(init.seedErrors)}`);
ok(init.configErrors.length === 0, `config errors: ${JSON.stringify(init.configErrors)}`);
ok(initMs < 1000, `init took ${initMs} ms`);

const t1 = Date.now();
const checks = [
  ['me21n', (r) => r.matches[0].tcode === 'me21n' && /^https:\/\/my1/.test(r.matches[0].url)],
  ['erp /nse16', (r) => r.matches.length === 1 && r.matches[0].gui && /sap-ui2-tcode=SE16$/.test(r.matches[0].url)],
  ['gui se16', (r) => r.matches[0].url === null && r.matches[0].tcode === 'se16'],
  ['purchase ord', (r) => r.matches.length > 0 && /purchase/i.test(r.matches[0].title)],
  ['?', (r) => r.kind === 'systems' && r.matches.length === 3],
];
for (const [text, test] of checks) {
  const r = JSON.parse(core.json.suggest(JSON.stringify(text), '{}'));
  ok(test(r), `suggest(${JSON.stringify(text)}) → ${JSON.stringify(r).slice(0, 300)}`);
}
const suggestMs = Date.now() - t1;

const resolved = JSON.parse(core.json.resolve(JSON.stringify('erp me23n 4500001234'), '{}'));
ok(resolved.kind === 'open' && resolved.param === '4500001234' && resolved.tcode === 'me23n', `resolve → ${JSON.stringify(resolved).slice(0, 300)}`);
ok(JSON.parse(core.json.resolve(JSON.stringify('gui'), '{}')).url === null, 'classic-only home has no URL');

const launch = JSON.parse(core.json.recordLaunch(JSON.stringify({ systemKey: 'erp', intent: 'PurchaseOrder-display' })));
ok(launch.lastUsedSystemKey === 'erp' && launch.recent.length === 1, 'recordLaunch');

const parts = JSON.parse(core.json.systemFromParts(JSON.stringify({ host: 'Acd.Finteq.io:8443', launchpadPath: '/sap/bc/ui2/flp', launchpadQuery: 'sap-client=600' }), '[]'));
ok(parts.key === 'acd' && parts.customer === 'finteq', 'systemFromParts');

const imported = JSON.parse(core.json.importConfig(JSON.stringify(config), JSON.stringify({ format: 'slashn-config', systems: [{ key: 'x', host: 'x.example.com', isDefault: true }] }), JSON.stringify({ replace: false })));
ok(imported.systems.length === 4, 'importConfig merge');

print(`embed.jsc ok: ${init.entryCount} entries, init ${initMs} ms, ${checks.length} suggests ${suggestMs} ms`);
