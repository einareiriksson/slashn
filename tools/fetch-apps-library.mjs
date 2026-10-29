#!/usr/bin/env node
// Builds src/seed/library.csv from the SAP Fiori Apps Reference Library.
//
//   node tools/fetch-apps-library.mjs                     # fetch Public Cloud apps from the library's OData service
//   node tools/fetch-apps-library.mjs --from export.csv   # parse a manual "Export to CSV" from the library UI instead
//   options: --out <file> (default src/seed/library.csv)  --dry-run  --page <n> (default 1000)
//            --filter "<OData $filter>"  --endpoint <url>
//
// The OData service is undocumented (it is what the library UI itself calls). If its shape changes this script
// exits non-zero with a message; fall back to the UI's List view → select all → Export to CSV and use --from.
// It yields intent, app ID and title only; transaction codes are not exposed and come from src/seed/tcodes.csv.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { parseObjects, serializeCsv, ALIAS_COLUMNS } from '../src/csv.js';

const DEFAULT_ENDPOINT = 'https://fioriappslibrary.hana.ondemand.com/sap/fix/externalViewer/services/SingleApp.xsodata';
const DEFAULT_FILTER = "substringof('Public Cloud',releaseGroupTextCombined)";
const SELECT = 'appId,AppName,IntentsCombined,ApplicationType,releaseId';
const INTENT_RE = /^([A-Za-z0-9_]+)-([A-Za-z0-9_]+)$/;

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes(name);
const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const outFile = path.resolve(root, opt('--out', 'src/seed/library.csv'));
const endpoint = opt('--endpoint', DEFAULT_ENDPOINT);
const filter = opt('--filter', DEFAULT_FILTER);
const pageSize = Number(opt('--page', 1000));
const from = opt('--from', null);
const dryRun = flag('--dry-run');

function fail(msg) {
  console.error(`\nERROR: ${msg}\n\nFallback: open https://fioriappslibrary.hana.ondemand.com, choose "All apps for SAP S/4HANA Cloud Public Edition",\nList view → Settings → Export to CSV, then run:  node tools/fetch-apps-library.mjs --from <that file>\n`);
  process.exit(1);
}

function splitIntents(combined) {
  // "$PurchaseOrder-create$ * $PurchaseOrder-manage$" → ["PurchaseOrder-create", "PurchaseOrder-manage"]
  return String(combined || '').split('*').map((s) => s.replace(/\$/g, '').trim()).filter((s) => INTENT_RE.test(s));
}

async function fetchJson(u) {
  const res = await fetch(u, { headers: { Accept: 'application/json' } });
  if (!res.ok) fail(`HTTP ${res.status} from ${u}`);
  return res.json();
}

async function fetchFromLibrary() {
  const base = `${endpoint}/InputFilterParam(InpFilterValue='')/Results`;
  const q = (extra) => `${base}?$format=json&$select=${encodeURIComponent(SELECT)}&$filter=${encodeURIComponent(filter)}&${extra}`;
  const first = await fetchJson(q(`$inlinecount=allpages&$top=${pageSize}`));
  const results = first && first.d && first.d.results;
  if (!Array.isArray(results)) fail('unexpected response shape (no d.results) – the library service may have changed');
  const total = Number(first.d.__count ?? results.length);
  if (!results.length || !('appId' in results[0]) || !('IntentsCombined' in results[0])) fail('rows lack appId/IntentsCombined – the library service may have changed');
  console.error(`library reports ${total} apps; fetching in pages of ${pageSize}`);
  const rows = [...results];
  for (let skip = pageSize; skip < total; skip += pageSize) {
    const page = await fetchJson(q(`$top=${pageSize}&$skip=${skip}`));
    const r = page && page.d && page.d.results;
    if (!Array.isArray(r)) fail(`page at $skip=${skip} has no d.results`);
    rows.push(...r);
    console.error(`  ${rows.length}/${total}`);
  }
  return rows.map((r) => ({ appId: r.appId, title: r.AppName, intents: splitIntents(r.IntentsCombined), type: r.ApplicationType }));
}

// Column names in the library UI's CSV export vary; match loosely.
const COLUMN_MAP = {
  appId: ['app id', 'fiori id', 'fioriid', 'appid', 'application id'],
  title: ['app name', 'appname', 'name', 'title'],
  intent: ['intent', 'intents', 'semantic object & action'],
  semanticObject: ['semantic object', 'semanticobject'],
  action: ['semantic action', 'action'],
  tcodes: ['transaction code', 'transaction codes', 'tcode', 'tcodes', 'transactioncodes'],
};
function readManualExport(file) {
  const text = fs.readFileSync(file, 'utf8');
  const { objects, errors } = parseObjects(text);
  if (errors.length || !objects.length) fail(`could not parse ${file}: ${errors.map((e) => e.message).join(', ') || 'no rows'}`);
  const keys = Object.keys(objects[0]).filter((k) => k !== '__line');
  const find = (names) => keys.find((k) => names.includes(k.trim().toLowerCase())) || keys.find((k) => names.some((n) => k.toLowerCase().includes(n)));
  const col = Object.fromEntries(Object.entries(COLUMN_MAP).map(([k, v]) => [k, find(v)]));
  if (!col.appId || !(col.intent || (col.semanticObject && col.action))) fail(`export is missing app id / intent columns; found: ${keys.join(', ')}`);
  return objects.map((o) => {
    const intents = col.intent ? splitIntents(o[col.intent]) : [`${o[col.semanticObject]}-${o[col.action]}`].filter((s) => INTENT_RE.test(s));
    return { appId: o[col.appId], title: col.title ? o[col.title] : '', intents, tcodes: col.tcodes ? o[col.tcodes] : '' };
  });
}

// "/AIFX/WDA_MSG_MONITOR (/AIFX/WDAC_MSG_MONITOR)" → "aifx/wda_msg_monitor"; aliases must match ^[a-z0-9][a-z0-9_./-]*$
function aliasFromAppId(appId) {
  return String(appId).toLowerCase().split(' (')[0].replace(/[^a-z0-9_./-]+/g, '').replace(/^[^a-z0-9]+/, '');
}
// Primary alias goes to the "real" intent; hub-style navigation shims come last.
const intentRank = (intent) => (/-navigateToFiori$|^ProcurementHub/i.test(intent) ? 1 : 0);

function toRows(apps) {
  const seen = new Set();
  const usedAliases = new Set();
  const out = [];
  for (const app of apps) {
    const appId = String(app.appId || '').trim();
    if (!appId || !app.intents.length) continue;
    const base = aliasFromAppId(appId);
    if (!base) continue;
    [...app.intents].sort((a, b) => intentRank(a) - intentRank(b)).forEach((intent, i) => {
      const key = `${appId.toLowerCase()}|${intent.toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      let alias = i === 0 ? base : `${base}-${i + 1}`;
      for (let n = 2; usedAliases.has(alias); n++) alias = `${base}-${n}`;
      usedAliases.add(alias);
      const [, semanticObject, action] = INTENT_RE.exec(intent);
      const tcodes = String(app.tcodes || '').split(/[,;]+/).map((t) => t.trim().toLowerCase()).filter(Boolean).join(';');
      out.push([alias, semanticObject, action, appId, tcodes, String(app.title || '').trim(), '']);
    });
  }
  out.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  return out;
}

const apps = from ? readManualExport(path.resolve(from)) : await fetchFromLibrary();
const rows = toRows(apps);
if (!rows.length) fail('no rows with a valid intent were produced');
const header = `# Generated by tools/fetch-apps-library.mjs from ${from ? path.basename(from) : 'the Fiori Apps Reference Library OData service'}; ${rows.length} intents across ${new Set(rows.map((r) => r[3])).size} apps. Do not edit by hand.\n`;
const csv = header + serializeCsv([ALIAS_COLUMNS, ...rows]);
if (dryRun) {
  process.stdout.write(csv.split('\n').slice(0, 12).join('\n') + `\n... (${rows.length} rows)\n`);
} else {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, csv);
  console.error(`wrote ${rows.length} rows to ${path.relative(root, outFile)}`);
}
