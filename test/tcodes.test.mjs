import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessIntentsForTcode, normalizeTcode, applyTcodeTable, makeGuesser } from '../src/tcodes.js';
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
