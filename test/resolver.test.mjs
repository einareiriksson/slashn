import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInput, mergeEntries, buildIndex, rank, buildUrl, homeUrl, appFinderUrl, isOnHost,
  escapeXml, formatSuggestion, formatSystemSuggestion, formatDefaultDescription, MATCH, normalizeEntry,
  tcodeLike, forcedTcode, guiEntry, titleWords,
} from '../src/resolver.js';

const systems = [
  { key: 'acd', name: 'Customer A Dev', customer: 'A', host: 'my1.s4hana.cloud.sap', launchpadPath: '/ui', env: 'DEV', isDefault: true },
  { key: 'tst', name: 'Customer A Test', customer: 'A', host: 'my2.s4hana.cloud.sap', launchpadPath: '/ui', env: 'TST', isDefault: false },
];
const noDefault = systems.map((s) => ({ ...s, isDefault: false }));

const seed = [
  { alias: 'me21n', semanticObject: 'PurchaseOrder', action: 'create', appId: 'F0842A', tcodes: ['me21n'], title: 'Create Purchase Order', source: 'seed' },
  { alias: 'po', semanticObject: 'PurchaseOrder', action: 'manage', appId: 'F0842', tcodes: ['me22n', 'me2l'], title: 'Manage Purchase Orders', paramKey: 'PurchaseOrder', source: 'seed' },
  { alias: 'me23n', semanticObject: 'PurchaseOrder', action: 'displayFactSheet', tcodes: ['me23n'], title: 'Purchase Order', paramKey: 'PurchaseOrder', source: 'seed' },
  { alias: 'f1600', semanticObject: 'PurchaseContract', action: 'manage', appId: 'F1600', tcodes: [], title: 'Manage Purchase Contracts', source: 'library' },
  { alias: 'va02', semanticObject: 'SalesOrder', action: 'manage', appId: 'F1873', tcodes: ['va02'], title: 'Manage Sales Orders', source: 'seed' },
  { alias: 'amp', semanticObject: 'Test', action: 'amp', tcodes: [], title: 'Tom & Jerry <Ltd>', source: 'seed' },
];

const idx = (entries) => buildIndex(mergeEntries({ seed: entries }));

test('parseInput: empty, systems, home, query', () => {
  assert.equal(parseInput('', systems).kind, 'empty');
  assert.equal(parseInput('?', systems).kind, 'systems');
  assert.equal(parseInput('list', systems).kind, 'systems');
  assert.equal(parseInput('OPTIONS', systems).kind, 'systems');
  assert.equal(parseInput('acd list', systems).kind, 'query'); // reserved words only in first position
  const home = parseInput('acd', systems);
  assert.equal(home.kind, 'home');
  assert.equal(home.system.key, 'acd');
  assert.equal(home.systemExplicit, true);
  const q = parseInput('  ACD   me23n\t4500001234 ', systems);
  assert.equal(q.kind, 'query');
  assert.equal(q.system.key, 'acd');
  assert.equal(q.head, 'me23n');
  assert.deepEqual(q.rest, ['4500001234']);
  assert.equal(q.query, 'me23n 4500001234');
});

test('parseInput: default and last-used fallback', () => {
  const d = parseInput('me21n', systems);
  assert.equal(d.system.key, 'acd');
  assert.equal(d.systemExplicit, false);
  assert.equal(parseInput('me21n', noDefault, { lastUsedKey: 'tst' }).system.key, 'tst');
  assert.equal(parseInput('me21n', noDefault).system.key, 'acd'); // first system
  assert.equal(parseInput('me21n', []).system, null);
  assert.equal(parseInput('me21n', []).kind, 'query');
  assert.equal(parseInput('me21n', systems, { preferredKey: 'tst' }).system.key, 'tst'); // current tab beats default
  assert.equal(parseInput('acd me21n', systems, { preferredKey: 'tst' }).system.key, 'acd'); // explicit key still wins
  assert.equal(parseInput('me21n', systems, { preferredKey: 'nope' }).system.key, 'acd');
});

test('parseInput: system key collision with alias – system wins', () => {
  const sys = [...systems, { key: 'po', host: 'my3.s4hana.cloud.sap', isDefault: false }];
  const p = parseInput('po', sys);
  assert.equal(p.kind, 'home');
  assert.equal(p.system.key, 'po');
});

test('rank: tier order alias > tcode > appId > intent', () => {
  const entries = [
    { alias: 'x', semanticObject: 'A', action: 'one', title: 'alias hit' },
    { alias: 'b', semanticObject: 'B', action: 'two', tcodes: ['x'], title: 'tcode hit' },
    { alias: 'c', semanticObject: 'C', action: 'three', appId: 'X', title: 'appid hit' },
    { alias: 'd', semanticObject: 'X', action: '', intent: 'x', title: 'intent hit' },
  ];
  const r = rank(parseInput('acd x', systems), idx(entries));
  assert.deepEqual(r.map((m) => m.type), [MATCH.ALIAS, MATCH.TCODE, MATCH.APP_ID, MATCH.INTENT]);
});

test('rank: exact beats title prefix beats fuzzy; limit; no match', () => {
  const r = rank(parseInput('acd manage pur', systems), idx(seed));
  assert.ok(r.length >= 2);
  assert.equal(r[0].entry.intent, 'PurchaseOrder-manage');
  assert.equal(r[0].type, MATCH.TITLE_PREFIX);
  assert.equal(r[1].entry.intent, 'PurchaseContract-manage');
  assert.equal(r[1].type, MATCH.TITLE_PREFIX);
  assert.deepEqual(rank(parseInput('acd zzzz', systems), idx(seed)), []);
  const many = Array.from({ length: 9 }, (_, i) => ({ alias: `k${i}`, semanticObject: 'S', action: `a${i}`, title: `Manage thing ${i}` }));
  assert.equal(rank(parseInput('acd manage', systems), idx(many)).length, 6);
  assert.equal(rank(parseInput('acd manage', systems), idx(many), { limit: 3 }).length, 3);
});

test('rank: fuzzy token-prefix, order-insensitive, no subsequence', () => {
  const r1 = rank(parseInput('acd pur man', systems), idx(seed));
  assert.ok(r1.some((m) => m.entry.intent === 'PurchaseOrder-manage' && m.type === MATCH.TITLE_FUZZY));
  const inOrder = rank(parseInput('acd man pur', systems), idx(seed)).find((m) => m.entry.intent === 'PurchaseOrder-manage');
  const outOfOrder = r1.find((m) => m.entry.intent === 'PurchaseOrder-manage');
  assert.ok(inOrder.score > outOfOrder.score);
  assert.deepEqual(rank(parseInput('acd mp', systems), idx(seed)).filter((m) => m.type === MATCH.TITLE_FUZZY), []);
  const punct = idx([{ alias: 'sup', semanticObject: 'Supplier', action: 'displayFactSheet', title: 'Supplier (Object Page)' }]);
  assert.equal(rank(parseInput('acd object page', systems), punct).length, 1);
});

test('rank: param only on keyed matches; key prefix needs 2 chars', () => {
  const keyed = rank(parseInput('acd me23n 4500001234', systems), idx(seed));
  assert.equal(keyed[0].type, MATCH.TCODE === keyed[0].type ? MATCH.TCODE : MATCH.ALIAS);
  assert.equal(keyed[0].param, '4500001234');
  const title = rank(parseInput('acd manage purchase', systems), idx(seed));
  assert.equal(title[0].param, null);
  const prefix = rank(parseInput('acd me2', systems), idx(seed));
  assert.deepEqual(prefix.map((m) => m.entry.intent).sort(), ['PurchaseOrder-create', 'PurchaseOrder-displayFactSheet', 'PurchaseOrder-manage']);
  assert.ok(prefix.every((m) => m.type === MATCH.KEY_PREFIX));
  assert.deepEqual(rank(parseInput('acd m', systems), idx(seed)).filter((m) => m.type === MATCH.KEY_PREFIX), []);
});

test('rank: discovered on target outranks static with same tier; dedupe by intent', () => {
  const discovered = [{ intent: '#PurchaseOrder-manage', title: 'Manage Purchase Orders (tenant)', appId: 'F0842' }];
  const merged = mergeEntries({ seed, discovered });
  const r = rank(parseInput('acd manage pur', systems), buildIndex(merged));
  const po = r.filter((m) => m.entry.intent === 'PurchaseOrder-manage');
  assert.equal(po.length, 1);
  assert.equal(po[0].entry.source, 'discovered');
});

test('rank: deterministic ordering regardless of input order', () => {
  const a = rank(parseInput('acd manage', systems), idx(seed)).map((m) => m.entry.intent);
  const b = rank(parseInput('acd manage', systems), idx([...seed].reverse())).map((m) => m.entry.intent);
  assert.deepEqual(a, b);
});

test('rank: t-code guess only when intent exists and no exact keyed match', () => {
  const guesser = (head) => (head === 'va41' ? ['SalesContract-create', 'SalesContract-manage'] : []);
  const withContract = idx([...seed, { alias: null, semanticObject: 'SalesContract', action: 'manage', title: 'Manage Sales Contracts' }]);
  const r = rank(parseInput('acd va41 123', systems), withContract, { guesser });
  assert.equal(r.length, 1);
  assert.equal(r[0].type, MATCH.TCODE_GUESS);
  assert.equal(r[0].entry.intent, 'SalesContract-manage');
  assert.equal(r[0].param, '123');
  assert.deepEqual(rank(parseInput('acd va41', systems), idx(seed), { guesser }), []);
  const exact = rank(parseInput('acd va02', systems), withContract, { guesser: () => ['SalesContract-manage'] });
  assert.ok(exact.every((m) => m.type !== MATCH.TCODE_GUESS));
});

test('mergeEntries: precedence, hidden, auto-alias, inheritance', () => {
  const user = [{ alias: 'po', semanticObject: 'PurchaseOrder', action: 'displayFactSheet', title: 'My PO' }];
  const discovered = [
    { intent: 'PurchaseOrder-manage', title: 'Tenant title' },
    { intent: 'Custom-thing', title: 'Custom App' },
    { intent: 'Other-app', title: 'Other', appId: 'F9999' },
  ];
  const m = mergeEntries({ user, seed, hidden: ['me21n'], discovered });
  const byAlias = (a) => m.find((e) => e.alias === a);
  assert.equal(byAlias('po').source, 'user');
  assert.equal(byAlias('po').intent, 'PurchaseOrder-displayFactSheet');
  assert.equal(mergeEntries({ user: [{ alias: 'x', intent: 'A-b', title: 'x', discoveredOnTarget: true }] })[0].discoveredOnTarget, false); // pinned rows get no tenant bonus
  assert.equal(byAlias('me21n'), undefined); // hidden
  const disc = m.find((e) => e.source === 'discovered' && e.intent === 'PurchaseOrder-manage');
  assert.equal(disc.appId, 'F0842'); // inherited
  assert.equal(disc.alias, 'f0842');
  assert.deepEqual(disc.tcodes.sort(), ['me22n', 'me2l']);
  assert.equal(disc.paramKey, 'PurchaseOrder');
  assert.equal(m.find((e) => e.intent === 'Custom-thing').alias, null); // no alias invented from title
  assert.equal(m.find((e) => e.intent === 'Other-app').alias, 'f9999');
  assert.equal(m.filter((e) => e.alias === 'po').length, 1);
});

test('normalizeEntry derives intent and parts', () => {
  const e = normalizeEntry({ intent: '#SalesOrder-manage?SalesOrder=1', title: ' T ', tcodes: 'VA02; VA05' });
  assert.equal(e.intent, 'SalesOrder-manage');
  assert.equal(e.semanticObject, 'SalesOrder');
  assert.equal(e.action, 'manage');
  assert.deepEqual(e.tcodes, ['va02', 'va05']);
  assert.equal(e.title, 'T');
});

test('urls', () => {
  const sys = systems[0];
  const e = normalizeEntry(seed[2]);
  assert.equal(buildUrl(sys, normalizeEntry(seed[0])), 'https://my1.s4hana.cloud.sap/ui#PurchaseOrder-create');
  assert.equal(buildUrl(sys, e, '4500001234'), 'https://my1.s4hana.cloud.sap/ui#PurchaseOrder-displayFactSheet?PurchaseOrder=4500001234');
  assert.equal(buildUrl(sys, normalizeEntry({ semanticObject: 'X', action: 'y', title: 'x' }), 'a b&c'), 'https://my1.s4hana.cloud.sap/ui#X-y?X=a%20b%26c');
  assert.equal(buildUrl({ ...sys, launchpadPath: '/sap/bc/ui2/flp' }, e), 'https://my1.s4hana.cloud.sap/sap/bc/ui2/flp#PurchaseOrder-displayFactSheet');
  assert.equal(buildUrl({ ...sys, launchpadPath: '' }, e), 'https://my1.s4hana.cloud.sap/ui#PurchaseOrder-displayFactSheet');
  assert.equal(homeUrl(sys), 'https://my1.s4hana.cloud.sap/ui#Shell-home');
  assert.equal(appFinderUrl(sys), 'https://my1.s4hana.cloud.sap/ui#Shell-appfinder');
  assert.equal(isOnHost('https://my1.s4hana.cloud.sap/ui#Shell-home', sys), true);
  assert.equal(isOnHost('https://MY1.s4hana.cloud.sap/', sys), true);
  assert.equal(isOnHost('https://my2.s4hana.cloud.sap/ui', sys), false);
  assert.equal(isOnHost(undefined, sys), false);
  assert.equal(isOnHost('not a url', sys), false);
  const onprem = { key: 'acd', host: 'acd.finteq.io:8443', scheme: 'https', launchpadPath: '/sap/bc/ui2/flp', launchpadQuery: 'sap-client=600' };
  assert.equal(buildUrl(onprem, e, '4500001234'), 'https://acd.finteq.io:8443/sap/bc/ui2/flp?sap-client=600#PurchaseOrder-displayFactSheet?PurchaseOrder=4500001234');
  assert.equal(homeUrl({ ...onprem, scheme: 'http' }), 'http://acd.finteq.io:8443/sap/bc/ui2/flp?sap-client=600#Shell-home');
  assert.equal(isOnHost('https://acd.finteq.io:8443/sap/bc/ui2/flp?sap-client=600#Shell-home', onprem), true);
  assert.equal(isOnHost('https://acd.finteq.io/ui', onprem), false);
  assert.equal(isOnHost('https://acd.finteq.io:443/ui', { host: 'acd.finteq.io' }), true);
});

test('formatting: escaping and round-trippable content', () => {
  assert.equal(escapeXml(`a&b<c>"d'`), 'a&amp;b&lt;c&gt;&quot;d&apos;');
  const r = rank(parseInput('acd me23n 4500001234', systems), idx(seed));
  const s = formatSuggestion(r[0], systems[0]);
  assert.equal(s.content, 'acd me23n 4500001234');
  assert.ok(s.description.includes('<match>me23n</match>'));
  assert.ok(s.description.includes('<dim>'));
  const amp = formatSuggestion(rank(parseInput('acd amp', systems), idx(seed))[0], systems[0]);
  assert.ok(amp.description.includes('Tom &amp; Jerry &lt;Ltd&gt;'));
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(amp.description));
  // alias-less discovered entry uses intent as content and re-parses to the same entry
  const merged = mergeEntries({ seed, discovered: [{ intent: 'Custom-thing', title: 'Custom App' }] });
  const m = rank(parseInput('acd custom', systems), buildIndex(merged));
  const sug = formatSuggestion(m[0], systems[0]);
  assert.equal(sug.content, 'acd Custom-thing');
  const again = rank(parseInput(sug.content, systems), buildIndex(merged));
  assert.equal(again[0].entry.intent, 'Custom-thing');
  assert.equal(again[0].type, MATCH.INTENT);
  const sys = formatSystemSuggestion(systems[0]);
  assert.equal(sys.content, 'acd');
  assert.ok(sys.description.includes('DEV') && sys.description.includes('my1.s4hana.cloud.sap'));
  assert.ok(formatDefaultDescription(parseInput('acd', systems)).includes('launchpad'));
  assert.ok(formatDefaultDescription(parseInput('acd me21n', systems), r[0]).includes('<match>'));
  assert.ok(formatDefaultDescription(parseInput('acd zzz', systems), null).includes('App Finder'));
  assert.ok(formatDefaultDescription(parseInput('x', [])).includes('No systems'));
});

test('mergeEntries: low-confidence seed rows are dropped once a scan proves them absent', () => {
  const low = [
    { alias: null, semanticObject: 'SalesContract', action: 'manage', tcodes: ['va41'], title: 'guess', confidence: 'low' },
    { alias: null, semanticObject: 'PurchaseOrder', action: 'manage', tcodes: ['me22n'], title: 'guess kept', confidence: 'low' },
    { alias: 'hi', semanticObject: 'Some-thing', action: 'x', title: 'high stays', confidence: 'high' },
  ];
  const before = mergeEntries({ seed: low });
  assert.equal(before.length, 3);
  const after = mergeEntries({ seed: low, discovered: [{ intent: 'PurchaseOrder-manage', title: 'T' }] });
  assert.deepEqual(after.filter((e) => e.source !== 'discovered').map((e) => e.title).sort(), ['guess kept', 'high stays']);
});

test('mergeEntries: alias-less rows are hidden by "#intent" tombstones', () => {
  const seed = [{ alias: null, semanticObject: 'SalesContract', action: 'manage', tcodes: ['va41'], title: 'x' }, { alias: 'po', semanticObject: 'PurchaseOrder', action: 'manage', title: 'y' }];
  assert.equal(mergeEntries({ seed, hidden: ['#salescontract-manage'] }).length, 1);
  assert.equal(mergeEntries({ seed, hidden: ['po'] })[0].intent, 'SalesContract-manage');
});

test('mergeEntries: edition filter keeps untagged rows and drops rows for other editions', () => {
  const seed = [
    { alias: 'pub', semanticObject: 'A', action: 'x', title: 'public only', editions: ['public'] },
    { alias: 'op', semanticObject: 'B', action: 'x', title: 'private/onprem', editions: 'private;onprem' },
    { alias: 'all', semanticObject: 'C', action: 'x', title: 'everywhere' },
    { alias: 'junk', semanticObject: 'D', action: 'x', title: 'bad tag ignored', editions: ['mars'] },
  ];
  const keys = (edition) => mergeEntries({ seed, edition }).map((e) => e.alias).sort();
  assert.deepEqual(keys('public'), ['all', 'junk', 'pub']);
  assert.deepEqual(keys('onprem'), ['all', 'junk', 'op']);
  assert.deepEqual(keys('private'), ['all', 'junk', 'op']);
  assert.deepEqual(keys(null), ['all', 'junk', 'op', 'pub']);
  assert.deepEqual(mergeEntries({ user: [{ alias: 'mine', intent: 'A-x', title: 'm', editions: ['onprem'] }], edition: 'public' }).map((e) => e.alias), ['mine']); // user rows always apply
});

test('mergeEntries: onTarget is null before a scan, true/false after, never judged for Shell-* intents', () => {
  const unscanned = mergeEntries({ seed });
  assert.ok(unscanned.every((e) => e.onTarget === null));
  const discovered = [{ intent: 'PurchaseOrder-manage', title: 'Manage Purchase Orders' }];
  const merged = mergeEntries({ seed: [...seed, { alias: 'home', intent: 'Shell-home', title: 'Home', source: 'seed' }], discovered, user: [{ alias: 'mine', intent: 'SalesOrder-manage', title: 'Mine' }] });
  const by = Object.fromEntries(merged.map((e) => [e.alias, e]));
  assert.equal(by.po.onTarget, true); // static row, intent offered by the tenant
  assert.equal(by.po.discoveredOnTarget, false); // but no ranking bonus; that stays with discovered rows
  assert.equal(by.me21n.onTarget, false);
  assert.equal(by.mine.onTarget, false); // user rows are judged too
  assert.equal(by.home.onTarget, null);
});

test('rank: absent-after-scan rows sink within their tier but never below a lower tier', () => {
  const discovered = [{ intent: 'PurchaseOrder-manage', title: 'Manage Purchase Orders' }];
  const merged = mergeEntries({ seed, discovered });
  const r = rank(parseInput('acd me2', systems), buildIndex(merged)); // key prefix: me21n (absent), po via me22n/me2l (present), me23n (absent)
  assert.equal(r[0].entry.intent, 'PurchaseOrder-manage');
  assert.ok(r.slice(1).every((m) => m.entry.onTarget === false));
  const exact = rank(parseInput('acd me21n', systems), buildIndex(merged));
  assert.equal(exact[0].entry.alias, 'me21n'); // an exact alias still wins over a present fuzzy/prefix match
});

test('rank: availableOnly keeps scanned-present rows only, GUI rows included when the scan has Shell-startGUI', () => {
  const discovered = [{ intent: 'PurchaseOrder-manage', title: 'Manage Purchase Orders' }];
  const merged = mergeEntries({ seed, discovered });
  const ix = buildIndex(merged);
  const r = rank(parseInput('acd me2', systems), ix, { availableOnly: true });
  assert.deepEqual(r.map((m) => m.entry.intent), ['PurchaseOrder-manage']);
  assert.deepEqual(rank(parseInput('acd me21n', systems), ix, { availableOnly: true }), [], 'the exact alias is absent after the scan: nothing');
  const withGui = rank(parseInput('acd me21n', systems), ix, { availableOnly: true, gui: { enabled: true, available: true } });
  assert.deepEqual(withGui.map((m) => m.entry.intent), ['Shell-startGUI'], 'the GUI transaction is "available" when the scan saw Shell-startGUI');
  assert.deepEqual(rank(parseInput('acd me21n', systems), ix, { availableOnly: true, gui: { enabled: true, available: null } }), [], 'unverified GUI is not');
  assert.ok(rank(parseInput('acd me2', systems), ix).length > 1, 'off: everything as before');
  const unscanned = rank(parseInput('acd me2', systems), buildIndex(mergeEntries({ seed })), { availableOnly: true });
  assert.deepEqual(unscanned, [], 'before a scan nothing is judged present – callers must not set it');
});

test('formatting: availability tags and default-description warning', () => {
  const discovered = [{ intent: 'PurchaseOrder-manage', title: 'Manage Purchase Orders' }];
  const merged = mergeEntries({ seed, discovered });
  const parsedAbsent = parseInput('acd me21n', systems);
  const absent = rank(parsedAbsent, buildIndex(merged))[0];
  assert.ok(formatSuggestion(absent, systems[0]).description.includes('not found on acd'));
  assert.ok(formatDefaultDescription(parsedAbsent, absent).includes('not found on acd in the last scan'));
  const present = rank(parseInput('acd po', systems), buildIndex(merged))[0];
  assert.ok(formatSuggestion(present, systems[0]).description.includes('on tenant'));
  const unknown = rank(parseInput('acd po', systems), buildIndex(mergeEntries({ seed })))[0];
  const d = formatSuggestion(unknown, systems[0]).description;
  assert.ok(!d.includes('tenant') && !d.includes('not found'));
});

test('gui: tcodeLike and /n parsing', () => {
  for (const t of ['me21n', 'se16', 'su01', 'fbl1n', 'vl10b', 's_alr_87012357', '/sapapo/sdp94', 'ob52', 'f110', 'sm59']) assert.equal(tcodeLike(t), 'strong', t);
  for (const t of ['spro', 'pfcg', 'stms', 'po', 'cat', 'sale']) assert.equal(tcodeLike(t), 'weak', t);
  for (const t of ['manage', 'purchase', '123', '4500001234', 'a', '', '/n', 'me21n!', 'x'.repeat(41), 'ab-cd']) assert.equal(tcodeLike(t), false, JSON.stringify(t));
  assert.equal(forcedTcode('/nme21n'), 'me21n');
  assert.equal(forcedTcode('/NSE16'), 'se16');
  assert.equal(forcedTcode('/n/sapapo/sdp94'), '/sapapo/sdp94');
  assert.equal(forcedTcode('/n'), null);
  assert.equal(forcedTcode('/nmanage'), null, 'a word is not forced into a transaction');
  assert.equal(forcedTcode('me21n'), null);
  const e = guiEntry('me21n', true);
  assert.equal(e.alias, '/nme21n');
  assert.equal(e.intent, 'Shell-startGUI');
  assert.deepEqual(e.fixedParams, { 'sap-ui2-tcode': 'ME21N' });
  assert.equal(e.onTarget, true);
  assert.equal(e.source, 'gui');
  assert.equal(buildUrl(systems[0], e), 'https://my1.s4hana.cloud.sap/ui#Shell-startGUI?sap-ui2-tcode=ME21N');
  assert.equal(buildUrl(systems[0], e, 'ignored'), 'https://my1.s4hana.cloud.sap/ui#Shell-startGUI?sap-ui2-tcode=ME21N&Shell=ignored', 'buildUrl itself keeps a param; rank never passes one for GUI matches');
  assert.equal(buildUrl(systems[0], guiEntry('/sapapo/sdp94')), 'https://my1.s4hana.cloud.sap/ui#Shell-startGUI?sap-ui2-tcode=%2FSAPAPO%2FSDP94');
});

test('gui: Shell-startGUI rows from the library or user aliases get their transaction code', () => {
  const sys = systems[0];
  assert.equal(buildUrl(sys, normalizeEntry({ alias: 'se63', semanticObject: 'Shell', action: 'startGUI', appId: 'SE63', title: 'SE63' })), 'https://my1.s4hana.cloud.sap/ui#Shell-startGUI?sap-ui2-tcode=SE63');
  assert.equal(buildUrl(sys, normalizeEntry({ alias: 'users', intent: 'Shell-startGUI', tcodes: ['su01'], title: 'Users' })), 'https://my1.s4hana.cloud.sap/ui#Shell-startGUI?sap-ui2-tcode=SU01');
  assert.equal(buildUrl(sys, normalizeEntry({ alias: 'sm59', intent: 'Shell-startGUI', title: 'RFC' })), 'https://my1.s4hana.cloud.sap/ui#Shell-startGUI?sap-ui2-tcode=SM59', 'alias as a last resort');
  assert.equal(buildUrl(sys, normalizeEntry({ alias: 'gui', intent: 'Shell-startGUI', title: 'GUI', paramKey: 'sap-ui2-tcode' }), 'se16'), 'https://my1.s4hana.cloud.sap/ui#Shell-startGUI?sap-ui2-tcode=se16', 'an explicit paramKey takes the typed value');
  assert.equal(buildUrl(sys, normalizeEntry({ alias: 'home', intent: 'Shell-home', title: 'Home' })), 'https://my1.s4hana.cloud.sap/ui#Shell-home', 'other Shell intents are untouched');
});

test('gui: ranking against present, absent and unverified Fiori matches; /n forces; public cloud never offers it', () => {
  const discovered = [{ intent: 'PurchaseOrder-manage', title: 'Manage Purchase Orders' }, { intent: 'Shell-startGUI', title: 'GUI' }];
  const scanned = buildIndex(mergeEntries({ seed, discovered }));
  const unscanned = idx(seed);
  const on = { enabled: true, available: true };
  const contents = (text, index, gui) => rank(parseInput(text, systems), index, { gui }).map((m) => `${m.entry.alias ?? m.entry.intent}${m.param ? ' ' + m.param : ''}`);
  assert.deepEqual(contents('acd me21n', scanned, on), ['/nme21n', 'me21n'], 'absent after scan: GUI first');
  assert.deepEqual(contents('acd po', scanned, on), ['po'], 'present: no GUI row for a letters-only alias');
  assert.deepEqual(contents('acd me22n 1', scanned, on).slice(0, 2), ['f0842 1', '/nme22n'], 'present via t-code (discovered row, alias from its app ID): Fiori first, GUI second without the value');
  assert.deepEqual(contents('acd me21n 1', unscanned, { enabled: true, available: null }), ['me21n 1', '/nme21n'], 'unverified: Fiori first');
  assert.deepEqual(contents('acd se16', unscanned, on), ['/nse16'], 'no Fiori match at all: GUI');
  assert.deepEqual(contents('acd spro', unscanned, on), ['/nspro']);
  assert.deepEqual(contents('acd sale', unscanned, on), ['va02'], 'letters-only head with a title match: no GUI row');
  assert.deepEqual(contents('acd manage purchase', scanned, on).some((c) => c.startsWith('/n')), false);
  assert.deepEqual(contents('acd /nme21n', unscanned, on), ['/nme21n'], 'forced: GUI only');
  assert.deepEqual(contents('acd /nme21n', unscanned, { enabled: false }), [], 'public cloud: nothing');
  assert.deepEqual(contents('acd me21n', unscanned, { enabled: false }), ['me21n']);
  assert.deepEqual(contents('acd se16', unscanned, { enabled: true, available: false }), [], 'scanned without Shell-startGUI: never offered');
  assert.deepEqual(contents('acd se16', unscanned, null), []);
  const guiMatch = rank(parseInput('acd me21n', systems), scanned, { gui: on })[0];
  assert.equal(guiMatch.type, MATCH.GUI);
  assert.equal(guiMatch.param, null);
  assert.equal(guiMatch.entry.onTarget, true);
  const s = formatSuggestion(guiMatch, systems[0]);
  assert.equal(s.content, 'acd /nme21n');
  assert.ok(s.description.includes('SAP GUI') && s.description.includes('on tenant') && s.description.includes('Transaction ME21N'));
  assert.equal(rank(parseInput(s.content, systems), scanned, { gui: on })[0].entry.intent, 'Shell-startGUI', 'suggestion content round-trips to the GUI launch');
  assert.ok(formatDefaultDescription(parseInput('acd me21n', systems), guiMatch).includes('/nme21n'));
  // a guess and the GUI row can coexist; the GUI row is first because the guess is not an exact match
  const guesser = (head) => (head === 'va41' ? ['SalesContract-manage'] : []);
  const withContract = idx([...seed, { alias: null, semanticObject: 'SalesContract', action: 'manage', title: 'Manage Sales Contracts' }]);
  assert.deepEqual(rank(parseInput('acd va41', systems), withContract, { guesser, gui: on }).map((m) => m.type), [MATCH.GUI, MATCH.TCODE_GUESS]);
});

test('rank: sources keeps only the named origins; a forced /n ignores it', () => {
  const discovered = [{ intent: 'PurchaseOrder-manage', title: 'Manage Purchase Orders' }];
  const ix = buildIndex(mergeEntries({ seed, discovered, user: [{ alias: 'mine', semanticObject: 'PurchaseOrder', action: 'create', title: 'My PO alias' }] }));
  const all = rank(parseInput('acd purchase', systems), ix, { limit: 20 });
  assert.ok(all.some((m) => m.entry.source === 'discovered') && all.some((m) => m.entry.source === 'seed'), 'unfiltered: several origins');
  const disc = rank(parseInput('acd purchase', systems), ix, { limit: 20, sources: ['discovered'] });
  assert.ok(disc.length && disc.every((m) => m.entry.source === 'discovered'));
  const mine = rank(parseInput('acd mine', systems), ix, { sources: ['user', 'import'] });
  assert.deepEqual(mine.map((m) => m.entry.alias), ['mine']);
  assert.deepEqual(rank(parseInput('acd mine', systems), ix, { sources: ['library'] }), [], 'a user alias is not a library row');
  const forced = rank(parseInput('acd /nse16', systems), ix, { sources: ['library'], gui: { enabled: true, available: null } });
  assert.equal(forced[0]?.entry.source, 'gui', 'forced GUI transactions ignore the source filter');
});

test('rank: tier order code > code prefix > title prefix > title substring, and recent launches reorder within a tier only', () => {
  const entries = [
    { alias: 'po', semanticObject: 'PurchaseOrder', action: 'manage', title: 'Manage Purchase Orders' },
    { alias: 'pox', semanticObject: 'PurchaseOrder', action: 'other', title: 'Something else' },
    { alias: 'zz1', semanticObject: 'Zeta', action: 'one', title: 'Po box' },
    { alias: 'zz2', semanticObject: 'Zeta', action: 'two', title: 'Report of po items' },
  ];
  const ix = buildIndex(mergeEntries({ seed: entries }));
  const order = rank(parseInput('acd po', systems), ix, { limit: 10 }).map((m) => m.type);
  assert.deepEqual(order, ['alias', 'keyPrefix', 'titlePrefix', 'titleFuzzy']);
  // two title-prefix rows: the recently launched one comes first
  const two = [
    { alias: 'a1', semanticObject: 'A', action: 'one', title: 'Payment run' },
    { alias: 'a2', semanticObject: 'A', action: 'two', title: 'Payment proposal' },
  ];
  const ix2 = buildIndex(mergeEntries({ seed: two }));
  assert.deepEqual(rank(parseInput('acd pay', systems), ix2).map((m) => m.entry.alias), ['a1', 'a2'], 'without recents: alias order');
  assert.deepEqual(rank(parseInput('acd pay', systems), ix2, { recentIntents: ['A-two'] }).map((m) => m.entry.alias), ['a2', 'a1'], 'recent first');
  // but never over a higher tier
  const mixed = buildIndex(mergeEntries({ seed: [...two, { alias: 'pay', semanticObject: 'B', action: 'x', title: 'Unrelated' }] }));
  assert.equal(rank(parseInput('acd pay', systems), mixed, { recentIntents: ['A-two'] })[0].entry.alias, 'pay', 'the exact alias stays first');
});

test('rank: fact sheets sit a notch below their siblings; frequent launches add to the recency boost', () => {
  const entries = [
    { alias: 'f1', semanticObject: 'SalesOrder', action: 'displayFactSheet', title: 'Sales Order' },
    { alias: 'f2', semanticObject: 'SalesOrder', action: 'manage', title: 'Manage Sales Orders' },
  ];
  const ix = buildIndex(mergeEntries({ seed: entries }));
  assert.deepEqual(rank(parseInput('acd ord', systems), ix).map((m) => m.entry.alias), ['f2', 'f1'], 'the shorter fact-sheet title no longer wins on coverage');
  const three = [
    { alias: 'a1', semanticObject: 'A', action: 'one', title: 'Payment run' },
    { alias: 'a2', semanticObject: 'A', action: 'two', title: 'Payment proposal' },
  ];
  const ix2 = buildIndex(mergeEntries({ seed: three }));
  const recents = ['A-one', 'A-two', 'A-two', 'A-two', 'A-two']; // one launched last, two launched often
  assert.equal(rank(parseInput('acd pay', systems), ix2, { recentIntents: recents })[0].entry.alias, 'a2', 'frequency outweighs a single more recent launch');
});

test('titleWords: underscores and camel case split, so intent-like titles are searchable by their parts', () => {
  assert.deepEqual(titleWords('NYH_AIDocument-process'), ['nyh', 'aidocument', 'ai', 'document', 'process']);
  assert.deepEqual(titleWords('SalesOrder-manage'), ['salesorder', 'sales', 'order', 'manage']);
  assert.deepEqual(titleWords('Manage Purchase Orders'), ['manage', 'purchase', 'orders']);
  const ix = buildIndex(mergeEntries({ discovered: [{ intent: 'NYH_AIDocument-process', title: '' }] }));
  assert.equal(rank(parseInput('acd aidocu', systems), ix)[0]?.entry.intent, 'NYH_AIDocument-process', 'found by a part of the object name');
  assert.equal(rank(parseInput('acd process', systems), ix)[0]?.entry.intent, 'NYH_AIDocument-process', 'and by the action');
});

test('rank: on a scanned system a present app found by a title word beats absent library apps whose titles start with it', () => {
  const library = Array.from({ length: 10 }, (_, i) => ({ alias: `lib${i}`, semanticObject: `Partner${i}`, action: 'run', title: `Partner report ${i}`, source: 'library' }));
  const discovered = [{ intent: 'BusinessPartner-display', title: '' }];
  const ix = buildIndex(mergeEntries({ seed: library, discovered }));
  const r = rank(parseInput('acd partner', systems), ix, { limit: 8 });
  assert.equal(r[0].entry.intent, 'BusinessPartner-display', 'the present app comes first');
  assert.ok(r.slice(1).every((m) => m.entry.onTarget === false));
  // unscanned: tier order as before (prefix of the whole title first)
  const ix2 = buildIndex(mergeEntries({ seed: [...library, { alias: 'bp', semanticObject: 'BusinessPartner', action: 'display', title: 'Business Partner' }] }));
  assert.equal(rank(parseInput('acd partner', systems), ix2, { limit: 20 }).at(-1).entry.alias, 'bp');
});
