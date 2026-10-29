# SAP QuickStart — Fiori app launcher for S/4HANA Cloud Public Edition

Handoff spec for Claude Code. Build this as a Chrome/Edge extension (Manifest V3) in a fresh repo. No framework; plain ES modules, no build step. Target Chrome 120+.

## 1. Problem

I work in several S/4HANA Cloud Public Edition tenants for several customers. Every app launch today means: find the right tenant tab, open the launchpad, type the app name into search, pick the right result. I want the equivalent of a transaction code: type a short alias in the omnibox, land directly in the app, in the right tenant.

## 2. Core concept

Every Fiori app is addressable by an **intent** `#SemanticObject-action`. The URL `https://<tenant-host>/ui#<SemanticObject>-<action>[?param=value]` opens the app regardless of which space/page it sits on, provided the user's business roles grant it. Aliases (`me21n`, `po`, `f0842`) therefore resolve to intents, not to tiles.

Two sources of aliases:

1. **Discovered** per tenant, read from the launchpad's own shell services while a tab is logged in. This reflects what the user is actually authorised for, including custom apps. Primary source.
2. **Seeded/overridden** by the user: a static table that maps classic t-codes and Fiori app IDs to intents (importable from a Fiori Apps Reference Library export), plus personal aliases. Secondary source and fallback for tenants not yet scanned.

## 3. User-facing behaviour

### 3.1 Omnibox

Keyword: `s`. Grammar:

```
s [<system-key>] <alias> [<param-value>]
```

Examples:

- `s me21n` → opens `#PurchaseOrder-create` on the default system
- `s acd me23n 4500001234` → opens `#PurchaseOrder-displayFactSheet?PurchaseOrder=4500001234` on system `acd`
- `s acd` → opens the launchpad home (`#Shell-home`) on `acd`
- `s acd manage purchase` → fuzzy-matches titles, shows suggestions
- `s ?` → shows all systems as suggestions

Rules:

- The first token is treated as a system key if it matches a registered system key (case-insensitive). Otherwise the default system is used, falling back to the most recently used system.
- Suggestions (`chrome.omnibox.onInputChanged`) show up to 6 matches, formatted `<alias>  <title>  [<system>]`, ranked: exact alias → exact t-code → exact app ID → title prefix → title fuzzy. Discovered entries for the target system rank above static entries.
- Enter on a suggestion navigates. Modifier handling: plain Enter reuses the current tab if it is already on the target tenant host, otherwise opens a new tab; Ctrl/Cmd+Enter always opens a new tab (use the `disposition` argument of `onInputEntered`).
- If the alias is unknown, open the launchpad with the shell search pre-filled: `#Shell-home&/?searchTerm=<alias>` is not reliable across releases, so instead open `#Shell-appfinder` and copy the alias to the clipboard. Document this limitation.

### 3.2 Options page

Single page, two tabs.

**Systems tab** — table with inline editing:

| field | type | notes |
|---|---|---|
| key | string, unique, lowercase | what the user types |
| name | string | e.g. "Customer A – Quality" |
| customer | string | grouping label |
| host | string | e.g. `my123456.s4hana.cloud.sap`, no scheme, no path |
| env | enum DEV/TST/PRD | drives colour |
| isDefault | boolean | exactly one |
| lastScanned | ISO date, read-only | set by discovery |
| appCount | int, read-only | set by discovery |

Actions per row: "Open launchpad", "Rescan now", "Delete".
Validation: host must match `^[a-z0-9.-]+$`; key must be unique.

**Aliases tab** — table of static entries with inline editing, plus:

- "Import CSV" (columns `alias,semanticObject,action,appId,tcodes,title,paramKey`; `tcodes` is `;`-separated).
- "Export CSV" of the static table.
- Read-only view of discovered entries per system (dropdown to pick the system, search filter), with a "Pin as alias" action that copies a discovered entry into the static table with a user-chosen alias.

### 3.3 Toolbar popup

Minimal: current system (if the active tab is on a known host), an input box behaving like the omnibox, last 10 launches. Optional for v1; omnibox is the primary surface.

## 4. Discovery (the hybrid part)

### 4.1 Mechanism

Content scripts run in an isolated world and cannot see `sap.ushell`. Register a second content script with `"world": "MAIN"` (MV3 supports this statically in `manifest.json`), matched on `https://*.s4hana.cloud.sap/ui*`. It:

1. Waits for `window.sap?.ushell?.Container` to exist (poll every 500 ms, give up after 60 s).
2. Gets the navigation service: `sap.ushell.Container.getServiceAsync("Navigation")` (UI5 1.120+). Fall back to `getServiceAsync("CrossApplicationNavigation")` and its `getLinks` if the former is absent.
3. Calls `getLinks({ semanticObject: "*" })` or, if that is rejected, iterates `getSemanticObjects()` and calls `getLinks` per object. Each link yields `intent` (`#SO-action`) and `text` (title).
4. Additionally pulls the app finder catalog data for richer titles and the technical app ID: `sap.ushell.Container.getServiceAsync("CommonDataModel")` → `getAllPages()` / `getApplications()`; CDM `sap.app.id` and `sap.fiori.registrationIds` give the app ID (e.g. `F0842`). Treat this step as best-effort; if it fails, keep intent + title only.
5. Posts the result to the isolated-world content script via `window.postMessage({ type: "SAPQS_DISCOVERY", host, entries })`. The isolated script forwards to the service worker with `chrome.runtime.sendMessage`.

Service worker stores entries under `discovered[<host>]` and updates `lastScanned`/`appCount` on the matching system.

### 4.2 Triggering

- Automatic: on each launchpad load for a registered host, if `lastScanned` is older than 7 days or missing.
- Manual: "Rescan now" from options → service worker finds or opens a tab on that host, sends `{type:"SAPQS_RESCAN"}` to the content script.

### 4.3 Normalisation

Discovered entry shape:

```json
{
  "intent": "PurchaseOrder-manage",
  "semanticObject": "PurchaseOrder",
  "action": "manage",
  "title": "Manage Purchase Orders",
  "appId": "F0842",
  "paramKey": null
}
```

Auto-generate aliases for discovered entries: lowercased `appId` when present (`f0842`), and the static table's t-codes if a static entry with the same intent exists. Do not invent aliases from titles.

### 4.4 Robustness

Everything in step 4.1 uses undocumented-but-stable public UI5 APIs. Wrap each call in its own try/catch, log at `debug` level, and degrade to whatever subset succeeded. Never block the launchpad; never throw into the page. Version the storage schema (`schemaVersion`) and migrate on `chrome.runtime.onInstalled`.

## 5. Storage

`chrome.storage.sync` for `systems` and `aliases` (user-maintained, small, should roam). `chrome.storage.local` for `discovered` (can be large; 100 KB sync limit would be exceeded). Keep `recent` (last 20 launches) in local.

Export/import of the full config as JSON from the options page.

## 6. Seed data

`tools/fetch-apps-library.mjs` (Node 20, no deps): downloads the Fiori Apps Reference Library's public JSON/OData export for S/4HANA Cloud Public Edition, filters to apps with a semantic object + action, and writes `src/seed/aliases.csv` in the import format above, with classic t-codes in `tcodes`. Verify the current endpoint by inspecting network calls on https://fioriappslibrary.hana.ondemand.com before writing the script; if there is no stable public endpoint, fall back to documenting the manual "Export to CSV" path in the library UI and ship a parser for that file. Ship a small hand-made `src/seed/aliases.csv` (~30 common PO/SO/FI/MM apps) so the extension is useful before any import.

## 7. Repo layout

```
manifest.json
src/
  background.js        # service worker: omnibox, resolution, navigation, storage, rescan orchestration
  resolver.js          # pure: parse(input, systems) → {systemKey, alias, param}; rank(candidates)
  storage.js           # typed get/set, schema migration
  content-isolated.js  # bridge page ↔ service worker
  content-main.js      # runs in MAIN world, does discovery
  options/ options.html options.js options.css
  popup/   popup.html popup.js
  seed/aliases.csv
tools/fetch-apps-library.mjs
test/resolver.test.mjs  # node --test, covers parsing + ranking
README.md
```

## 8. Non-goals for v1

- Switching Chrome profiles per customer (sessions/IAS tenants colliding is a real issue; document the workaround of one Chrome profile per customer, each with the extension installed and its own `systems` list).
- On-premise S/4HANA support (different hostnames and `/sap/bc/ui2/flp` path). Design `host` + a `launchpadPath` field (default `/ui`) so it can be added later without a migration.
- Any writes to the SAP tenant. Read-only throughout.

## 9. Acceptance

1. Fresh install, add one system, type `s me21n` → lands on `#PurchaseOrder-create` on that host.
2. After one launchpad load on that system, `s manage pur` shows discovered titles in suggestions.
3. `s acd f0842 4500000001` opens the display app with the PO pre-selected (paramKey from static table).
4. Options page survives reload with edits; export → wipe → import round-trips.
5. `node --test` passes; resolver tests cover system-key detection, default fallback, ranking order, and parameter extraction.
6. Launchpad load time is not measurably affected (discovery runs after `Container` is ready, off the critical path).

## 10. Working notes for Claude Code

- Start with `resolver.js` + tests, then `background.js` omnibox wiring with static aliases only, then options page, then discovery. Each step should be loadable via `chrome://extensions` → Load unpacked.
- Keep `content-main.js` free of `chrome.*` calls; it has no access to them in the MAIN world.
- Log with a `[SAPQS]` prefix so console filtering is easy.
