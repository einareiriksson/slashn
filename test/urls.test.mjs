// URL composition for on-premise, private cloud and public cloud systems.
// Walks the full chain a system goes through: pasted launchpad URL → systemFromUrl/normalizeSystem → launchpadBase/buildUrl/homeUrl
// → isOnHost/originPattern (tab reuse, permissions, content-script matching) → the host a content script reports back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemFromUrl, parseLaunchpadUrl, normalizeSystem, validateSystems, originPattern, isDefaultHost } from '../src/storage.js';
import { launchpadBase, intentUrl, buildUrl, homeUrl, appFinderUrl, isOnHost, normalizeEntry } from '../src/resolver.js';

const po = normalizeEntry({ alias: 'me23n', semanticObject: 'PurchaseOrder', action: 'displayFactSheet', title: 'Purchase Order', paramKey: 'PurchaseOrder' });

/**
 * One row per launchpad flavour seen in the wild. `pasted` is what a user copies from the address bar;
 * `home` is the launchpad home URL slashn must generate from it; `host` is what every host comparison must use.
 */
const FLAVOURS = [
  {
    name: 'public cloud',
    pasted: 'https://my419228.s4hana.cloud.sap/ui#Shell-home',
    host: 'my419228.s4hana.cloud.sap', scheme: 'https', path: '/ui', query: '',
    home: 'https://my419228.s4hana.cloud.sap/ui#Shell-home',
  },
  {
    name: 'public cloud, bare host without scheme or path',
    pasted: 'MY419228.s4hana.cloud.sap',
    host: 'my419228.s4hana.cloud.sap', scheme: 'https', path: '/ui', query: '',
    home: 'https://my419228.s4hana.cloud.sap/ui#Shell-home',
  },
  {
    name: 'on-prem, custom port, flp path, sap-client',
    pasted: 'https://acd.finteq.io:8443/sap/bc/ui2/flp?sap-client=600#Shell-home',
    host: 'acd.finteq.io:8443', scheme: 'https', path: '/sap/bc/ui2/flp', query: 'sap-client=600',
    home: 'https://acd.finteq.io:8443/sap/bc/ui2/flp?sap-client=600#Shell-home',
  },
  {
    name: 'on-prem, classic FioriLaunchpad.html, two query params',
    pasted: 'https://erp.example.com/sap/bc/ui5_ui5/ui2/ushell/shells/abap/FioriLaunchpad.html?sap-client=100&sap-language=EN#Shell-home',
    host: 'erp.example.com', scheme: 'https', path: '/sap/bc/ui5_ui5/ui2/ushell/shells/abap/FioriLaunchpad.html', query: 'sap-client=100&sap-language=EN',
    home: 'https://erp.example.com/sap/bc/ui5_ui5/ui2/ushell/shells/abap/FioriLaunchpad.html?sap-client=100&sap-language=EN#Shell-home',
  },
  {
    name: 'on-prem, plain http on an internal port',
    pasted: 'http://erp.internal.example:8000/sap/bc/ui2/flp?sap-client=100#PurchaseOrder-manage',
    host: 'erp.internal.example:8000', scheme: 'http', path: '/sap/bc/ui2/flp', query: 'sap-client=100',
    home: 'http://erp.internal.example:8000/sap/bc/ui2/flp?sap-client=100#Shell-home',
  },
  {
    name: 'on-prem, trailing slash on the path and an intent with parameters in the hash',
    pasted: 'https://fiori.corp.example/sap/bc/ui2/flp/?sap-client=200#PurchaseOrder-displayFactSheet?PurchaseOrder=4500001234',
    host: 'fiori.corp.example', scheme: 'https', path: '/sap/bc/ui2/flp', query: 'sap-client=200',
    home: 'https://fiori.corp.example/sap/bc/ui2/flp?sap-client=200#Shell-home',
  },
  {
    name: 'private cloud behind a reverse proxy on the default https port, written explicitly',
    pasted: 'https://s4.customer.example:443/ui#Shell-home',
    host: 's4.customer.example', scheme: 'https', path: '/ui', query: '',
    home: 'https://s4.customer.example/ui#Shell-home',
  },
  {
    name: 'http on the default port, written explicitly',
    pasted: 'http://erp.internal.example:80/sap/bc/ui2/flp',
    host: 'erp.internal.example', scheme: 'http', path: '/sap/bc/ui2/flp', query: '',
    home: 'http://erp.internal.example/sap/bc/ui2/flp#Shell-home',
  },
  {
    name: 'uppercase host and mixed-case path are kept apart: host lowercased, path untouched',
    pasted: 'https://ERP.Example.COM:8443/sap/bc/ui5_ui5/ui2/ushell/shells/abap/FioriLaunchpad.html',
    host: 'erp.example.com:8443', scheme: 'https', path: '/sap/bc/ui5_ui5/ui2/ushell/shells/abap/FioriLaunchpad.html', query: '',
    home: 'https://erp.example.com:8443/sap/bc/ui5_ui5/ui2/ushell/shells/abap/FioriLaunchpad.html#Shell-home',
  },
];

for (const f of FLAVOURS) {
  test(`flavour: ${f.name}`, () => {
    const sys = systemFromUrl(f.pasted, []);
    assert.ok(sys, 'systemFromUrl accepted the URL');
    assert.equal(sys.host, f.host);
    assert.equal(sys.scheme, f.scheme);
    assert.equal(sys.launchpadPath, f.path);
    assert.equal(sys.launchpadQuery, f.query);
    assert.deepEqual(validateSystems([sys]), []);

    // generated URLs
    assert.equal(homeUrl(sys), f.home);
    assert.equal(appFinderUrl(sys), f.home.replace(/#Shell-home$/, '#Shell-appfinder'));
    assert.equal(buildUrl(sys, po, '4500001234'), f.home.replace(/#Shell-home$/, '#PurchaseOrder-displayFactSheet?PurchaseOrder=4500001234'));

    // the generated home URL re-parses to the same system (idempotent round trip, what "Add as system" sees after a launch)
    const again = systemFromUrl(homeUrl(sys), []);
    assert.deepEqual({ host: again.host, scheme: again.scheme, launchpadPath: again.launchpadPath, launchpadQuery: again.launchpadQuery }, { host: f.host, scheme: f.scheme, launchpadPath: f.path, launchpadQuery: f.query });

    // tab reuse: the tab we just opened is recognised as being on that system; the host a content script would report matches too
    assert.equal(isOnHost(homeUrl(sys), sys), true);
    assert.equal(isOnHost(buildUrl(sys, po, '1'), sys), true);
    assert.equal(new URL(homeUrl(sys)).host, sys.host, 'URL.host (what content scripts and tab lookups use) equals the stored host');
    if (/^[a-z]+:\/\//i.test(f.pasted)) assert.equal(isOnHost(f.pasted, sys), true, 'the URL the user pasted is on the system too');

    // permissions / dynamic content scripts
    assert.equal(originPattern(sys), `${f.scheme}://${f.host}/*`);
    assert.equal(new URL(homeUrl(sys)).origin + '/', originPattern(sys).replace(/\*$/, ''));
    assert.equal(isDefaultHost(sys.host), f.host.endsWith('.s4hana.cloud.sap'));
  });
}

test('launchpadBase: path and query normalisation', () => {
  const base = (over) => launchpadBase({ host: 'erp.example:8443', scheme: 'https', launchpadPath: '/sap/bc/ui2/flp', launchpadQuery: 'sap-client=600', ...over });
  assert.equal(base({}), 'https://erp.example:8443/sap/bc/ui2/flp?sap-client=600');
  assert.equal(base({ launchpadPath: 'sap/bc/ui2/flp' }), 'https://erp.example:8443/sap/bc/ui2/flp?sap-client=600', 'missing leading slash is added');
  assert.equal(base({ launchpadPath: '' }), 'https://erp.example:8443/ui?sap-client=600', 'empty path falls back to /ui');
  assert.equal(base({ launchpadPath: null }), 'https://erp.example:8443/ui?sap-client=600');
  assert.equal(base({ launchpadQuery: '?sap-client=600' }), 'https://erp.example:8443/sap/bc/ui2/flp?sap-client=600', 'a leading ? is tolerated');
  assert.equal(base({ launchpadQuery: '' }), 'https://erp.example:8443/sap/bc/ui2/flp');
  assert.equal(base({ launchpadQuery: undefined }), 'https://erp.example:8443/sap/bc/ui2/flp');
  assert.equal(base({ launchpadQuery: 'sap-client=600&sap-language=DE' }), 'https://erp.example:8443/sap/bc/ui2/flp?sap-client=600&sap-language=DE');
  assert.equal(base({ scheme: 'http' }), 'http://erp.example:8443/sap/bc/ui2/flp?sap-client=600');
  assert.equal(base({ scheme: 'HTTP' }), 'http://erp.example:8443/sap/bc/ui2/flp?sap-client=600');
  assert.equal(base({ scheme: 'ftp' }), 'https://erp.example:8443/sap/bc/ui2/flp?sap-client=600', 'unknown scheme falls back to https');
  assert.equal(base({ scheme: undefined }), 'https://erp.example:8443/sap/bc/ui2/flp?sap-client=600', 'legacy rows without a scheme are https');
  assert.equal(base({ host: 'ERP.Example:8443' }), 'https://erp.example:8443/sap/bc/ui2/flp?sap-client=600');
});

test('intentUrl: launchpad query and intent parameters coexist, parameters are encoded', () => {
  const sys = { host: 'erp.example:8443', scheme: 'https', launchpadPath: '/sap/bc/ui2/flp', launchpadQuery: 'sap-client=600' };
  // The launchpad query sits before the hash, intent parameters after it; both use "?" and that is what the FLP expects.
  assert.equal(intentUrl(sys, 'PurchaseOrder-manage'), 'https://erp.example:8443/sap/bc/ui2/flp?sap-client=600#PurchaseOrder-manage');
  assert.equal(intentUrl(sys, '#PurchaseOrder-manage'), 'https://erp.example:8443/sap/bc/ui2/flp?sap-client=600#PurchaseOrder-manage', 'a leading # on the intent is not doubled');
  assert.equal(intentUrl(sys, 'PurchaseOrder-manage', { PurchaseOrder: '4500001234' }), 'https://erp.example:8443/sap/bc/ui2/flp?sap-client=600#PurchaseOrder-manage?PurchaseOrder=4500001234');
  assert.equal(intentUrl(sys, 'X-y', { a: '1', b: '2' }), 'https://erp.example:8443/sap/bc/ui2/flp?sap-client=600#X-y?a=1&b=2');
  assert.equal(intentUrl(sys, 'X-y', { a: '', b: null, c: undefined, d: '0' }), 'https://erp.example:8443/sap/bc/ui2/flp?sap-client=600#X-y?d=0', 'empty values are dropped, "0" is kept');
  assert.equal(intentUrl(sys, 'X-y', { 'Material Number': 'A&B=C#D/E ü' }), 'https://erp.example:8443/sap/bc/ui2/flp?sap-client=600#X-y?Material%20Number=A%26B%3DC%23D%2FE%20%C3%BC');
  const u = new URL(intentUrl(sys, 'X-y', { k: 'a#b' }));
  assert.equal(u.search, '?sap-client=600', 'an encoded # inside a parameter does not split the hash');
  assert.equal(u.hash, '#X-y?k=a%23b');
});

test('buildUrl: parameter key comes from paramKey, else the semantic object', () => {
  const sys = { host: 'erp.example', scheme: 'https', launchpadPath: '/sap/bc/ui2/flp', launchpadQuery: '' };
  assert.equal(buildUrl(sys, normalizeEntry({ semanticObject: 'Supplier', action: 'displayFactSheet', title: 't' }), '100001'), 'https://erp.example/sap/bc/ui2/flp#Supplier-displayFactSheet?Supplier=100001');
  assert.equal(buildUrl(sys, normalizeEntry({ semanticObject: 'Supplier', action: 'displayFactSheet', title: 't', paramKey: 'BusinessPartner' }), '100001'), 'https://erp.example/sap/bc/ui2/flp#Supplier-displayFactSheet?BusinessPartner=100001');
  assert.equal(buildUrl(sys, normalizeEntry({ semanticObject: 'Supplier', action: 'displayFactSheet', title: 't', paramKey: 'BusinessPartner' }), null), 'https://erp.example/sap/bc/ui2/flp#Supplier-displayFactSheet');
  assert.equal(buildUrl(sys, normalizeEntry({ semanticObject: 'Supplier', action: 'displayFactSheet', title: 't' }), ''), 'https://erp.example/sap/bc/ui2/flp#Supplier-displayFactSheet');
  assert.equal(buildUrl(sys, normalizeEntry({ intent: 'Shell-startGUI', title: 'gui', paramKey: 'sap-ui-tech-hint' }), 'GUI'), 'https://erp.example/sap/bc/ui2/flp#Shell-startGUI?sap-ui-tech-hint=GUI');
});

test('parseLaunchpadUrl: what is accepted and what is dropped', () => {
  assert.deepEqual(parseLaunchpadUrl('https://acd.finteq.io:8443/sap/bc/ui2/flp?sap-client=600#Shell-home'), { scheme: 'https', host: 'acd.finteq.io:8443', launchpadPath: '/sap/bc/ui2/flp', launchpadQuery: 'sap-client=600' });
  assert.equal(parseLaunchpadUrl('https://acd.finteq.io:8443/sap/bc/ui2/flp?sap-client=600&=x&&foo=#Shell-home').launchpadQuery, 'sap-client=600&foo=', 'empty keys are dropped, empty values kept');
  assert.equal(parseLaunchpadUrl('https://h.example/ui?sap-language=EN&sap-client=100').launchpadQuery, 'sap-language=EN&sap-client=100', 'parameter order is preserved');
  assert.equal(parseLaunchpadUrl('https://h.example/ui?x=a%20b').launchpadQuery, 'x=a+b', 'values are re-serialised by URLSearchParams');
  assert.equal(launchpadBase({ host: 'h.example', launchpadPath: '/ui', launchpadQuery: 'x=a+b' }), 'https://h.example/ui?x=a+b');
  assert.equal(new URL(launchpadBase({ host: 'h.example', launchpadPath: '/ui', launchpadQuery: 'x=a+b' })).searchParams.get('x'), 'a b');
  assert.equal(parseLaunchpadUrl('https://h.example///ui///').launchpadPath, '///ui');
  assert.equal(parseLaunchpadUrl('https://h.example/').launchpadPath, '/ui');
  assert.equal(parseLaunchpadUrl('https://h.example').launchpadPath, '/ui');
  assert.equal(parseLaunchpadUrl('  https://h.example/ui  ').host, 'h.example', 'whitespace is trimmed');
  assert.equal(parseLaunchpadUrl('h.example:8443/sap/bc/ui2/flp').host, 'h.example:8443', 'scheme-less input with a port');
  assert.equal(parseLaunchpadUrl('https://user:pw@h.example/ui').host, 'h.example', 'credentials are not part of the host');
  assert.equal(parseLaunchpadUrl('https://h.example:65536/ui'), null, 'out-of-range port is rejected by URL()');
  assert.equal(parseLaunchpadUrl('https://h.example:abc/ui'), null);
  assert.equal(parseLaunchpadUrl('https://localhost:8443/ui'), null, 'hosts without a dot are rejected');
  assert.equal(parseLaunchpadUrl('https://10.0.0.5:8443/sap/bc/ui2/flp').host, '10.0.0.5:8443', 'IPv4 is a valid on-prem host');
  assert.equal(parseLaunchpadUrl('https://[::1]:8443/ui'), null, 'IPv6 literals are not supported by HOST_RE');
  assert.equal(parseLaunchpadUrl('https://h_x.example/ui'), null, 'underscore is not a valid host character');
  assert.equal(parseLaunchpadUrl('ftp://h.example/ui'), null);
  assert.equal(parseLaunchpadUrl('javascript:alert(1)'), null);
  assert.equal(parseLaunchpadUrl('chrome://extensions'), null);
  assert.equal(parseLaunchpadUrl(''), null);
  assert.equal(parseLaunchpadUrl(null), null);
});

test('normalizeSystem: host cleanup, default ports, legacy rows', () => {
  const n = (raw) => normalizeSystem({ key: 'k', ...raw });
  assert.equal(n({ host: 'https://ERP.Example.com:8443/sap/bc/ui2/flp?sap-client=1#x' }).host, 'erp.example.com:8443', 'a pasted URL in the host field is reduced to host:port');
  assert.equal(n({ host: ' erp.example ' }).host, 'erp.example');
  assert.equal(n({ host: 'erp.example:443' }).host, 'erp.example', 'default https port is dropped so URL.host comparisons match');
  assert.equal(n({ host: 'erp.example:443', scheme: 'http' }).host, 'erp.example:443', ':443 is a real port for http');
  assert.equal(n({ host: 'erp.example:80', scheme: 'http' }).host, 'erp.example', 'default http port is dropped');
  assert.equal(n({ host: 'erp.example:80' }).host, 'erp.example:80', ':80 is a real port for https');
  assert.equal(n({ host: 'erp.example:8443' }).host, 'erp.example:8443');
  assert.equal(n({ host: 'erp.example' }).scheme, 'https');
  assert.equal(n({ host: 'erp.example', scheme: 'http' }).scheme, 'http');
  assert.equal(n({ host: 'erp.example', scheme: 'HTTPS' }).scheme, 'https');
  assert.equal(n({ host: 'erp.example', scheme: 'gopher' }).scheme, 'https');
  assert.equal(n({ host: 'erp.example' }).launchpadPath, '/ui');
  assert.equal(n({ host: 'erp.example', launchpadPath: '  /sap/bc/ui2/flp  ' }).launchpadPath, '/sap/bc/ui2/flp');
  assert.equal(n({ host: 'erp.example', launchpadPath: '   ' }).launchpadPath, '/ui');
  assert.equal(n({ host: 'erp.example', launchpadQuery: '?sap-client=600' }).launchpadQuery, 'sap-client=600');
  assert.equal(n({ host: 'erp.example' }).launchpadQuery, '');
  // a row written by v0.1 (no scheme/query fields) builds the same URL as before
  const legacy = n({ host: 'my1.s4hana.cloud.sap', launchpadPath: '/ui' });
  assert.equal(homeUrl(legacy), 'https://my1.s4hana.cloud.sap/ui#Shell-home');
  assert.equal(legacy.edition, 'public');
  assert.equal(n({ host: 'erp.example:8443' }).edition, 'onprem');
  assert.deepEqual(validateSystems([n({ host: 'erp.example', launchpadPath: 'ui' })]).filter((e) => /launchpadPath/.test(e)).length, 1, 'a path without a leading slash is a validation error (launchpadBase would still repair it)');
  assert.ok(validateSystems([n({ host: 'erp.example:99999' })]).some((e) => /host/.test(e)) === false, 'HOST_RE only checks digit count; URL() is the real gate at paste time');
});

test('isOnHost: port and scheme sensitivity', () => {
  const op = { key: 'fin', host: 'acd.finteq.io:8443', scheme: 'https' };
  assert.equal(isOnHost('https://acd.finteq.io:8443/sap/bc/ui2/flp?sap-client=600#Shell-home', op), true);
  assert.equal(isOnHost('https://ACD.FINTEQ.IO:8443/other/path', op), true, 'any path on the host counts; the hash navigation handles the rest');
  assert.equal(isOnHost('https://acd.finteq.io/sap/bc/ui2/flp', op), false, 'same hostname, default port: a different system');
  assert.equal(isOnHost('https://acd.finteq.io:8444/sap/bc/ui2/flp', op), false);
  assert.equal(isOnHost('http://acd.finteq.io:8443/sap/bc/ui2/flp', op), true, 'scheme is not compared (URL.host ignores it)');
  const plain = { key: 'p', host: 'acd.finteq.io', scheme: 'https' };
  assert.equal(isOnHost('https://acd.finteq.io:443/ui', plain), true, 'URL() drops the default port');
  assert.equal(isOnHost('https://acd.finteq.io:8443/ui', plain), false);
  assert.equal(isOnHost('https://acd.finteq.io.evil.example/ui', plain), false);
  assert.equal(isOnHost('https://evil.example/?u=acd.finteq.io', plain), false);
  assert.equal(isOnHost('https://acd.finteq.io/ui', { host: '' }), false);
  assert.equal(isOnHost('https://acd.finteq.io/ui', null), false);
});

test('originPattern: scheme and port are part of the pattern', () => {
  assert.equal(originPattern({ host: 'acd.finteq.io:8443', scheme: 'https' }), 'https://acd.finteq.io:8443/*');
  assert.equal(originPattern({ host: 'erp.internal.example:8000', scheme: 'http' }), 'http://erp.internal.example:8000/*');
  assert.equal(originPattern({ host: 'Erp.Example' }), 'https://erp.example/*', 'no scheme → https, host lowercased');
  assert.equal(originPattern('acd.finteq.io:8443'), 'https://acd.finteq.io:8443/*', 'a bare host string works too');
  // both patterns derived from the same system agree with the URLs slashn generates for it
  for (const f of FLAVOURS) {
    const sys = systemFromUrl(f.pasted, []);
    const prefix = originPattern(sys).slice(0, -1);
    assert.ok(homeUrl(sys).startsWith(prefix), `${f.name}: ${homeUrl(sys)} starts with ${prefix}`);
    assert.ok(buildUrl(sys, po, '1').startsWith(prefix));
  }
});

test('systemFromUrl: key, customer and uniqueness for on-prem hosts', () => {
  const a = systemFromUrl('https://acd.finteq.io:8443/sap/bc/ui2/flp?sap-client=600', []);
  assert.equal(a.key, 'acd', 'port never leaks into the key');
  assert.equal(a.customer, 'finteq');
  assert.equal(a.name, 'acd.finteq.io:8443');
  assert.equal(a.isDefault, true);
  const b = systemFromUrl('https://acd.finteq.io/sap/bc/ui2/flp?sap-client=100', [a]);
  assert.equal(b.key, 'acd2', 'same hostname on another port is a second system with a unique key');
  assert.equal(b.host, 'acd.finteq.io');
  assert.equal(b.isDefault, false);
  assert.equal(systemFromUrl('https://10.0.0.5:8443/sap/bc/ui2/flp', []).key, '10');
  assert.equal(systemFromUrl('https://10.0.0.5:8443/sap/bc/ui2/flp', []).customer, '0');
  assert.equal(systemFromUrl('https://erp.example.com/', []).customer, 'example');
  assert.equal(systemFromUrl('https://erp.example/', []).customer, '', 'two labels: no customer guess');
  assert.equal(systemFromUrl('https://-dash.example.com/', []).key, 'dash');
  assert.deepEqual(validateSystems([a, b]), []);
});
