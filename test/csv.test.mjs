import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, serializeCsv, aliasesFromCsv, aliasesToCsv, tcodesFromCsv } from '../src/csv.js';

test('parseCsv handles quotes, doubled quotes, embedded newlines, CRLF/LF, BOM', () => {
  const text = '﻿a,b,c\r\n1,"x, y","he said ""hi"""\n2,"multi\nline",\n';
  assert.deepEqual(parseCsv(text), [['a', 'b', 'c'], ['1', 'x, y', 'he said "hi"'], ['2', 'multi\nline', '']]);
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('a,b'), [['a', 'b']]);
});

test('serializeCsv round-trips', () => {
  const rows = [['alias', 'title'], ['x', 'a, "b"\nc'], ['y', '']];
  assert.deepEqual(parseCsv(serializeCsv(rows)), rows);
});

test('aliasesFromCsv: header order independence, tcodes split, errors with line numbers', () => {
  const text = '# comment\ntitle,ACTION,semanticObject,alias,tcodes\nManage POs,manage,PurchaseOrder,po,ME22N;me2l\n,create,,bad,\n';
  const { entries, errors } = aliasesFromCsv(text, { source: 'seed' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].alias, 'po');
  assert.deepEqual(entries[0].tcodes, ['me22n', 'me2l']);
  assert.equal(entries[0].source, 'seed');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 4);
  assert.equal(aliasesFromCsv('alias,title\nx,y').errors[0].message.includes('semanticObject'), true);
  const noAlias = aliasesFromCsv('alias,semanticObject,action,appId\n,PurchaseOrder,manage,F0842\n');
  assert.equal(noAlias.entries[0].alias, 'f0842');
});

test('aliasesToCsv → aliasesFromCsv round-trip', () => {
  const entries = [{ alias: 'po', semanticObject: 'PurchaseOrder', action: 'manage', appId: 'F0842', tcodes: ['me22n'], title: 'Manage, "POs"', paramKey: 'PurchaseOrder' }];
  const back = aliasesFromCsv(aliasesToCsv(entries), { source: 'user' }).entries;
  assert.deepEqual(back, [{ ...entries[0], source: 'user' }]);
});

test('tcodesFromCsv expands multi-code cells', () => {
  const { rows, errors } = tcodesFromCsv('tcode,semanticObject,action,appId,paramKey,confidence,note\nXK01;xk02;XK03,Supplier,manageMasterData,F1053,,high,Manage Supplier\n');
  assert.equal(errors.length, 0);
  assert.deepEqual(rows.map((r) => r.tcode), ['xk01', 'xk02', 'xk03']);
  assert.equal(rows[0].confidence, 'high');
  assert.equal(rows[0].note, 'Manage Supplier');
});
