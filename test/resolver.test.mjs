import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInput, mergeEntries, buildIndex, rank, buildUrl, homeUrl, appFinderUrl, isOnHost,
  escapeXml, formatSuggestion, formatSystemSuggestion, formatDefaultDescription, MATCH, normalizeEntry,
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
