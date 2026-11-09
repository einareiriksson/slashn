// Legacy transaction code mapping. Pure module.
// 1. applyTcodeTable: merges the curated tcodes.csv rows into seed/library entries.
// 2. applyAppMap: merges the t-code → Fiori app table (tcode-apps.json) by app ID, then by app title.
// 3. guessIntentsForTcode: pattern-based best guess for codes not in the tables.
//    The resolver only offers a guess when that intent exists on the target tenant.

/** Ordered prefix rules: [regex on normalised code, semantic objects (best first)] */
export const PREFIX_RULES = [
  [/^me2[0-9]/, ['PurchaseOrder']],
  [/^me5[0-9a]/, ['PurchaseRequisition']],
  [/^me3[0-9]k$/, ['PurchaseContract']],
  [/^me3[0-9]l$/, ['PurchaseScheduleAgreement', 'PurchaseSchedulingAgreement']],
  [/^me3/, ['PurchaseContract', 'PurchaseScheduleAgreement']],
  [/^me4/, ['RequestForQuotation', 'SupplierQuotation']],
  [/^me1[0-9]/, ['PurchasingInfoRecord', 'PurchaseInfoRecord']],
  [/^me9/, ['PurchaseOrder']],
  [/^va0/, ['SalesOrder']],
  [/^va1/, ['SalesInquiry']],
  [/^va2/, ['SalesQuotation']],
  [/^va4/, ['SalesContract']],
  [/^va/, ['SalesOrder']],
  [/^vl/, ['OutboundDelivery', 'InboundDelivery']],
  [/^vf/, ['BillingDocument']],
  [/^vk1/, ['PricingCondition', 'SalesPrice']],
  [/^(xk|mk)/, ['Supplier']],
  [/^(xd|fd|vd)/, ['Customer']],
  [/^bp$/, ['BusinessPartner']],
  [/^mm0/, ['Product', 'Material']],
  [/^mm/, ['Product', 'Material']],
  [/^(mb|migo)/, ['MaterialDocument', 'GoodsReceipt', 'GoodsMovement']],
  [/^mmbe/, ['Material', 'Product']],
  [/^(miro|mir|mrbr)/, ['SupplierInvoice']],
  [/^md0/, ['Material', 'Product']],
  [/^md/, ['Material', 'MRPRun']],
  [/^co0/, ['ProductionOrder', 'ManufacturingOrder']],
  [/^co/, ['ProductionOrder']],
  [/^ks/, ['CostCenter']],
  [/^kp/, ['CostCenter']],
  [/^ka0/, ['CostElement', 'GLAccount']],
  [/^ko0/, ['InternalOrder']],
  [/^fs0/, ['GLAccount']],
  [/^(fb0|fb5|f-0)/, ['AccountingDocument', 'JournalEntry']],
  [/^fb6/, ['SupplierInvoice', 'AccountingDocument']],
  [/^fb7/, ['CustomerInvoice', 'AccountingDocument']],
  [/^fbl1/, ['Supplier']],
  [/^fbl3/, ['GLAccount']],
  [/^fbl5/, ['Customer']],
  [/^f110/, ['AutomaticPayment', 'PaymentProposal']],
  [/^f-2/, ['Customer', 'AccountingDocument']],
  [/^f-4/, ['Supplier', 'AccountingDocument']],
  [/^fagl/, ['GLAccount', 'AccountingDocument']],
  [/^iw2/, ['MaintenanceNotification']],
  [/^iw3/, ['MaintenanceOrder']],
  [/^ie0/, ['Equipment']],
  [/^il0/, ['FunctionalLocation']],
  [/^qa/, ['InspectionLot']],
  [/^qe/, ['InspectionLot', 'InspectionResult']],
  [/^cs0/, ['BillOfMaterial']],
  [/^ca0/, ['Routing']],
  [/^cr0/, ['WorkCenter']],
  [/^su0/, ['BusinessUser', 'User']],
  [/^pfcg/, ['BusinessRole']],
  [/^pa[0-9]/, ['Employee']],
  [/^cj/, ['Project', 'WBSElement']],
  [/^as0/, ['FixedAsset', 'MasterFixedAsset']],
];

const ACTIONS_BY_LAST_CHAR = {
  1: ['create', 'manage', 'maintain'],
  2: ['manage', 'change', 'maintain', 'edit'],
  3: ['displayFactSheet', 'display', 'manage', 'maintain'],
  4: ['manage', 'release', 'displayList'],
  5: ['manage', 'displayList', 'list', 'monitor'],
  6: ['manage', 'displayList', 'list'],
  8: ['manage', 'displayList', 'list', 'monitor'],
  9: ['manage', 'displayList', 'list', 'monitor'],
  0: ['manage', 'displayList', 'list', 'monitor'],
  a: ['manage', 'displayList', 'list'],
  l: ['manage', 'displayList', 'list'],
  m: ['manage', 'displayList', 'list'],
  n: ['manage', 'displayList', 'list'],
};
const DEFAULT_ACTIONS = ['manage', 'create', 'maintain', 'display', 'post', 'manageMasterData'];

const MASTER_DATA_OBJECTS = new Set(['Supplier', 'Customer', 'Product', 'Material', 'BusinessPartner', 'GLAccount', 'CostCenter', 'Employee', 'Equipment', 'FunctionalLocation']);

/** Lowercase, trim, drop the "N" suffix of new-style GUI codes (ME21N → me21). */
export function normalizeTcode(tcode) {
  let s = String(tcode ?? '').trim().toLowerCase();
  if (/\dn$/.test(s)) s = s.slice(0, -1);
  return s;
}

/**
 * guessIntentsForTcode('va41') → [{ semanticObject:'SalesContract', action:'create', confidence:'low' }, ...]
 * Returns [] when no prefix rule applies.
 */
export function guessIntentsForTcode(tcode) {
  const code = normalizeTcode(tcode);
  if (!code || code.length < 2) return [];
  const rule = PREFIX_RULES.find(([re]) => re.test(code));
  if (!rule) return [];
  // action hint: the last digit (me31k → 1); for digit-less codes use the last character
  const digit = code.match(/(\d)[a-z]*$/);
  const last = digit ? digit[1] : code[code.length - 1];
  const actions = ACTIONS_BY_LAST_CHAR[last] ?? DEFAULT_ACTIONS;
  const out = [];
  const seen = new Set();
  for (const so of rule[1]) {
    const list = [...actions];
    if (MASTER_DATA_OBJECTS.has(so)) list.push('manageMasterData', 'displayFactSheet', 'maintain');
    for (const action of list) {
      const key = `${so}-${action}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ semanticObject: so, action, confidence: 'low' });
    }
  }
  return out;
}

/** A guesser for resolver.rank(): head → ["SO-action", ...] */
export function makeGuesser() {
  return (head) => guessIntentsForTcode(head).map((g) => `${g.semanticObject}-${g.action}`);
}

/**
 * applyTcodeTable(entries, rows) → entries (new array, shallow copies).
 * Each table row attaches its tcode to the entries with the same intent, narrowed to the row's app ID when one of them
 * carries it; failing any intent match, to the entries with that app ID.
 * Rows without a matching entry become their own seed entry so they resolve before any scan.
 */
export function applyTcodeTable(entries, rows) {
  const out = (entries || []).map((e) => ({ ...e, tcodes: [...(e.tcodes || [])] }));
  const byIntent = new Map();
  const byAppId = new Map();
  const add = (map, key, e) => { if (!key) return; const k = key.toLowerCase(); if (!map.has(k)) map.set(k, []); map.get(k).push(e); };
  for (const e of out) {
    add(byIntent, e.intent || `${e.semanticObject}-${e.action}`, e);
    add(byAppId, e.appId, e);
  }
  for (const r of rows || []) {
    const intent = `${r.semanticObject}-${r.action}`;
    const tcode = String(r.tcode).toLowerCase();
    // intent first, narrowed by the app ID when both are known: generic intents such as ApplicationLog-showList are
    // shared by unrelated apps, so a row naming F1487 attaches to F1487 alone. An app ID the intent's entries lack is
    // treated as a stale guess and the intent wins; the app ID alone counts only when the intent is unknown here.
    const intentTargets = byIntent.get(intent.toLowerCase()) || [];
    const idTargets = r.appId ? byAppId.get(r.appId.toLowerCase()) || [] : [];
    const both = intentTargets.filter((e) => idTargets.includes(e));
    const targets = both.length ? both : intentTargets.length ? intentTargets : idTargets;
    if (targets.length) {
      for (const t of targets) {
        if (!t.tcodes.includes(tcode)) t.tcodes.push(tcode);
        if (!t.paramKey && r.paramKey) t.paramKey = r.paramKey;
        if (!t.appId && r.appId) t.appId = r.appId;
        if (!t.confidence && r.confidence) t.confidence = r.confidence;
      }
      continue;
    }
    const e = {
      alias: null,
      semanticObject: r.semanticObject,
      action: r.action,
      intent,
      appId: r.appId || null,
      tcodes: [tcode],
      title: r.note || intent,
      paramKey: r.paramKey || null,
      source: 'seed',
      confidence: r.confidence || 'low',
    };
    out.push(e);
    add(byIntent, intent, e);
    add(byAppId, e.appId, e);
  }
  return out;
}

/**
 * applyAppMap(entries, rows) → { entries, unmapped }
 * rows: [{ tcode, app, appId, module, description, idVerified, notes }] – a t-code → successor-app table that names
 * apps, not intents. Each code is attached to the app's primary library entry (the one whose alias is the app ID; the
 * "-2", "-3" variants of multi-intent apps are left alone so one code does not produce nine hits). Without an app ID,
 * or when the ID is not in the library, the app title is matched instead; a title shared by several apps attaches to
 * each app's primary entry (at most 3). An app ID the table marks unverified (idVerified false) is only trusted when the
 * library entry's title agrees with the table's app name, since such IDs are guesses (STMS → F3408 names "Import
 * Collection" while the library's F3408 is "Predicted Delivery Delay"). Codes that match nothing are reported in
 * `unmapped` and otherwise ignored.
 */
export function applyAppMap(entries, rows) {
  const out = (entries || []).map((e) => ({ ...e, tcodes: [...(e.tcodes || [])] }));
  const lcs = (v) => String(v ?? '').trim().toLowerCase();
  const byAppId = new Map();
  const byTitle = new Map();
  const push = (map, key, e) => { if (!key) return; if (!map.has(key)) map.set(key, []); map.get(key).push(e); };
  for (const e of out) {
    push(byAppId, lcs(e.appId), e);
    push(byTitle, lcs(e.title), e);
  }
  const primaryOf = (list) => {
    const prim = list.filter((e) => e.appId && lcs(e.alias) === lcs(e.appId));
    return prim.length ? prim : list;
  };
  const words = (v) => lcs(v).replace(/[^a-z0-9]+/g, ' ').trim();
  const sameApp = (title, app) => { const a = words(title); const b = words(app); return Boolean(a && b) && (a === b || a.startsWith(b) || b.startsWith(a)); };
  const unmapped = [];
  for (const r of rows || []) {
    const tcode = lcs(r.tcode);
    if (!tcode) continue;
    let byId = r.appId ? byAppId.get(lcs(r.appId)) || [] : [];
    if (byId.length && r.idVerified !== true) byId = byId.filter((e) => sameApp(e.title, r.app));
    let targets = primaryOf(byId);
    if (!targets.length) {
      const titled = byTitle.get(lcs(r.app)) || [];
      const groups = new Map();
      for (const e of titled) push(groups, lcs(e.appId) || lcs(e.intent || `${e.semanticObject}-${e.action}`), e);
      targets = [...groups.values()].slice(0, 3).flatMap((g) => primaryOf(g).slice(0, 1));
    }
    if (!targets.length) { unmapped.push({ tcode: r.tcode, app: r.app || null, appId: r.appId || null }); continue; }
    for (const t of targets) if (!t.tcodes.includes(tcode)) t.tcodes.push(tcode);
  }
  return { entries: out, unmapped };
}
