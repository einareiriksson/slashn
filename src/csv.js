// RFC4180-ish CSV parse/serialize plus the alias and t-code row mappings. Pure module.

export const ALIAS_COLUMNS = ['alias', 'semanticObject', 'action', 'appId', 'tcodes', 'title', 'paramKey', 'editions'];
export const TCODE_COLUMNS = ['tcode', 'semanticObject', 'action', 'appId', 'paramKey', 'confidence', 'note'];

export function parseCsv(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function serializeCsv(rows) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\n') + '\n';
}

function isBlank(row) {
  return row.every((c) => String(c).trim() === '');
}
function isComment(row) {
  return String(row[0] ?? '').trimStart().startsWith('#');
}

/** Reads header + rows into objects; header names are matched case-insensitively. */
export function parseObjects(text, requiredColumns = []) {
  const rows = parseCsv(text);
  const errors = [];
  let headerIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    if (!isBlank(rows[i]) && !isComment(rows[i])) { headerIndex = i; break; }
  }
  if (headerIndex < 0) return { objects: [], errors: [{ line: 1, message: 'CSV is empty' }] };
  const header = rows[headerIndex].map((h) => String(h).trim());
  const lower = header.map((h) => h.toLowerCase());
  for (const col of requiredColumns) {
    if (!lower.includes(col.toLowerCase())) errors.push({ line: headerIndex + 1, message: `missing column "${col}"` });
  }
  if (errors.length) return { objects: [], errors };
  const objects = [];
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (isBlank(row) || isComment(row)) continue;
    const obj = { __line: i + 1 };
    header.forEach((h, j) => { obj[h] = (row[j] ?? '').trim(); });
    objects.push(obj);
  }
  return { objects, errors };
}

function pick(obj, name) {
  const key = Object.keys(obj).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? obj[key] : '';
}

export const splitList = (v) => String(v ?? '').split(/[;|]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);

/**
 * aliasesFromCsv(text, { source }) → { entries, errors }
 * Columns: alias,semanticObject,action,appId,tcodes,title,paramKey,editions  (tcodes and editions ';'-separated;
 * editions ⊆ public;private;onprem, empty = all)
 */
export function aliasesFromCsv(text, { source = 'seed' } = {}) {
  const { objects, errors } = parseObjects(text, ['semanticObject', 'action']);
  const entries = [];
  for (const o of objects) {
    const semanticObject = pick(o, 'semanticObject');
    const action = pick(o, 'action');
    const appId = pick(o, 'appId');
    const alias = pick(o, 'alias').toLowerCase() || appId.toLowerCase();
    if (!semanticObject || !action) { errors.push({ line: o.__line, message: 'semanticObject and action are required' }); continue; }
    if (!alias) { errors.push({ line: o.__line, message: 'alias or appId is required' }); continue; }
    entries.push({
      alias,
      semanticObject,
      action,
      appId: appId || null,
      tcodes: splitList(pick(o, 'tcodes')),
      title: pick(o, 'title') || `${semanticObject}-${action}`,
      paramKey: pick(o, 'paramKey') || null,
      editions: splitList(pick(o, 'editions')),
      source,
    });
  }
  return { entries, errors };
}

export function aliasesToCsv(entries) {
  const rows = [ALIAS_COLUMNS];
  for (const e of entries || []) {
    rows.push([e.alias ?? '', e.semanticObject ?? '', e.action ?? '', e.appId ?? '', (e.tcodes || []).join(';'), e.title ?? '', e.paramKey ?? '', (e.editions || []).join(';')]);
  }
  return serializeCsv(rows);
}

/**
 * tcodesFromCsv(text) → { rows:[{ tcode, semanticObject, action, appId, paramKey, confidence, note }], errors }
 * A `tcode` cell may hold several codes separated by ';'; each becomes its own row.
 */
export function tcodesFromCsv(text) {
  const { objects, errors } = parseObjects(text, ['tcode', 'semanticObject', 'action']);
  const rows = [];
  for (const o of objects) {
    const semanticObject = pick(o, 'semanticObject');
    const action = pick(o, 'action');
    const codes = splitList(pick(o, 'tcode'));
    if (!semanticObject || !action || !codes.length) { errors.push({ line: o.__line, message: 'tcode, semanticObject and action are required' }); continue; }
    for (const tcode of codes) {
      rows.push({
        tcode,
        semanticObject,
        action,
        appId: pick(o, 'appId') || null,
        paramKey: pick(o, 'paramKey') || null,
        confidence: pick(o, 'confidence').toLowerCase() || 'medium',
        note: pick(o, 'note') || '',
      });
    }
  }
  return { rows, errors };
}

export function tcodesToCsv(rows) {
  const out = [TCODE_COLUMNS];
  for (const r of rows || []) out.push([r.tcode, r.semanticObject, r.action, r.appId ?? '', r.paramKey ?? '', r.confidence ?? '', r.note ?? '']);
  return serializeCsv(out);
}
