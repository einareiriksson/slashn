import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessIntentsForTcode, normalizeTcode, applyTcodeTable, applyAppMap, makeGuesser } from '../src/tcodes.js';
import { mergeEntries, buildIndex, rank, parseInput, MATCH } from '../src/resolver.js';

const key = (g) => `${g.semanticObject}-${g.action}`;

test('normalizeTcode strips the N suffix only after a digit', () => {
  assert.equal(normalizeTcode('ME21N'), 'me21');
  assert.equal(normalizeTcode('vl01n'), 'vl01');
  assert.equal(normalizeTcode('MIGO'), 'migo');
  assert.equal(normalizeTcode('man'), 'man');
});

test('guessIntentsForTcode: best guess first', () => {
  assert.equal(key(guessIntentsForTcode('me21n')[0]), 'PurchaseOrder-create');
  assert.equal(key(guessIntentsForTcode('va03')[0]), 'SalesOrder-displayFactSheet');
  assert.ok(guessIntentsForTcode('xk02').map(key).includes('Supplier-manageMasterData'));
  assert.equal(key(guessIntentsForTcode('va41')[0]), 'SalesContract-create');
  assert.ok(guessIntentsForTcode('me31k').map(key).includes('PurchaseContract-create'));
  assert.ok(guessIntentsForTcode('me31l').map(key).includes('PurchaseScheduleAgreement-create'));
  assert.deepEqual(guessIntentsForTcode('zzz9'), []);
  assert.deepEqual(guessIntentsForTcode(''), []);
  assert.ok(guessIntentsForTcode('migo').every((g) => g.confidence === 'low'));
});

test('applyTcodeTable: a shared intent is narrowed to the row\'s app ID, a stale app ID yields to the intent', () => {
  const entries = [
    { alias: 'f1487', semanticObject: 'ApplicationLog', action: 'showList', appId: 'F1487', tcodes: [], title: 'Application Logs', source: 'library' },
    { alias: 'f2162-2', semanticObject: 'ApplicationLog', action: 'showList', appId: 'F2162', tcodes: [], title: 'Display Credit Management Log', source: 'library' },
    { alias: 'f8940', semanticObject: 'Customer', action: 'displayLineItems', appId: 'F8940', tcodes: [], title: 'Display Customer Line Items', source: 'library' },
    { alias: 'f0711', semanticObject: 'Customer', action: 'manageLineItems', appId: 'F0711', tcodes: [], title: 'Manage Customer Line Items', source: 'library' },
  ];
  const rows = [
    { tcode: 'sm13', semanticObject: 'ApplicationLog', action: 'showList', appId: 'F1487', confidence: 'medium' },
    { tcode: 'fbl5n', semanticObject: 'Customer', action: 'displayLineItems', appId: 'F0711', confidence: 'medium' }, // the intent belongs to F8940
  ];
  const out = applyTcodeTable(entries, rows);
  assert.deepEqual(out.map((e) => e.tcodes), [['sm13'], [], ['fbl5n'], []], 'F1487 alone gets SM13; FBL5N follows the intent, not the app ID the row names');
});

test('applyTcodeTable attaches by intent, then appId, else creates an entry', () => {
  const entries = [
    { alias: 'po', semanticObject: 'PurchaseOrder', action: 'manage', appId: 'F0842', tcodes: ['me22n'], title: 'Manage POs', source: 'seed' },
    { alias: 'f1600', semanticObject: 'PurchaseContract', action: 'manage', appId: 'F1600', tcodes: [], title: 'Manage Contracts', source: 'library' },
  ];
  const rows = [
    { tcode: 'me2l', semanticObject: 'PurchaseOrder', action: 'manage', paramKey: 'PurchaseOrder', confidence: 'high' },
    { tcode: 'me31k', semanticObject: 'PurchaseContract', action: 'somethingElse', appId: 'F1600', confidence: 'medium' },
    { tcode: 'va41', semanticObject: 'SalesContract', action: 'manage', confidence: 'low', note: 'Manage Sales Contracts' },
  ];
  const out = applyTcodeTable(entries, rows);
  assert.deepEqual(entries[0].tcodes, ['me22n']); // input untouched
  assert.deepEqual(out[0].tcodes, ['me22n', 'me2l']);
  assert.equal(out[0].paramKey, 'PurchaseOrder');
  assert.deepEqual(out[1].tcodes, ['me31k']); // matched via appId
  assert.equal(out.length, 3);
  assert.equal(out[2].intent, 'SalesContract-manage');
  assert.equal(out[2].title, 'Manage Sales Contracts');
  assert.equal(out[2].alias, null);
  assert.equal(out[2].confidence, 'low');
});

test('guesser integrates with rank and marks guesses', () => {
  const seed = [
    { alias: 'po', semanticObject: 'PurchaseOrder', action: 'manage', title: 'Manage POs' },
    { alias: null, semanticObject: 'SalesContract', action: 'manage', title: 'Manage Sales Contracts' },
  ];
  const index = buildIndex(mergeEntries({ seed }));
  const systems = [{ key: 'acd', host: 'h.s4hana.cloud.sap', isDefault: true }];
  const r = rank(parseInput('acd va42', systems), index, { guesser: makeGuesser() });
  assert.equal(r.length, 1);
  assert.equal(r[0].type, MATCH.TCODE_GUESS);
  assert.equal(r[0].entry.intent, 'SalesContract-manage');
  assert.deepEqual(rank(parseInput('acd va42', systems), buildIndex(mergeEntries({ seed: [seed[0]] })), { guesser: makeGuesser() }), []);
});

test('applyAppMap: primary entry per app ID, title fallback across apps, unmapped reported, input untouched', () => {
  const entries = [
    { alias: 'f0717', appId: 'F0717', intent: 'AccountingDocument-display', title: 'Manage Journal Entries', tcodes: [] },
    { alias: 'f0717-2', appId: 'F0717', intent: 'AccountingDocument-manage', title: 'Manage Journal Entries', tcodes: [] },
    { alias: 'f1234', appId: 'F1234', intent: 'Reservation-manage', title: 'Manage Reservations', tcodes: ['mb21'] },
    { alias: 'f1234-2', appId: 'F1234', intent: 'Reservation-display', title: 'Manage Reservations', tcodes: [] },
    { alias: 'f9999', appId: 'F9999', intent: 'ReservationX-manage', title: 'Manage Reservations', tcodes: [] },
    { alias: 'po', appId: null, intent: 'PurchaseOrder-manage', title: 'Manage Purchase Orders', tcodes: [] },
  ];
  const rows = [
    { tcode: 'FB03', app: 'Manage Journal Entries', appId: 'F0717', idVerified: true },
    { tcode: 'STMS', app: 'Import Collection', appId: 'F0717', idVerified: false },
    { tcode: 'FB02', app: 'Manage Journal Entries - Version 2', appId: 'F0717', idVerified: false },
    { tcode: 'MB22', app: 'Manage Reservations', appId: null },
    { tcode: 'MB21', app: 'Manage Reservations', appId: null },
    { tcode: 'ME23N', app: 'Manage Purchase Orders', appId: 'F0842A' },
    { tcode: 'SNOTE', app: 'Not available', appId: null },
    { tcode: '', app: 'ignored' },
  ];
  const { entries: out, unmapped } = applyAppMap(entries, rows);
  assert.deepEqual(entries[0].tcodes, [], 'input untouched');
  assert.deepEqual(out[0].tcodes, ['fb03', 'fb02'], 'the primary entry of the app gets the code; an unverified ID is accepted when the titles agree');
  assert.deepEqual(out[1].tcodes, [], 'the -2 variant does not');
  assert.deepEqual(out[2].tcodes, ['mb21', 'mb22'], 'title match: primary of each app; no duplicate for mb21');
  assert.deepEqual(out[3].tcodes, []);
  assert.deepEqual(out[4].tcodes, ['mb22', 'mb21'], 'a second app with the same title also gets it');
  assert.deepEqual(out[5].tcodes, ['me23n'], 'app ID unknown → matched by title, alias-less entry is its own primary');
  assert.deepEqual(unmapped, [{ tcode: 'STMS', app: 'Import Collection', appId: 'F0717' }, { tcode: 'SNOTE', app: 'Not available', appId: null }], 'an unverified ID whose library title disagrees is not trusted');
  assert.deepEqual(applyAppMap(entries, []).entries.map((e) => e.tcodes), entries.map((e) => e.tcodes));
});
