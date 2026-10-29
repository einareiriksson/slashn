# slashn (SAP app launcher)

Chrome/Edge extension (Manifest V3) that turns the address bar into a transaction-code launcher for SAP S/4HANA Cloud Public Edition. Type `s`, a space, then an alias and you land directly in the Fiori app on the right tenant.

```
s [<system-key>] <alias> [<value>]
```

| You type | What opens |
|---|---|
| `s me21n` | `#PurchaseOrder-create` on the default system |
| `s acd me23n 4500001234` | `#PurchaseOrder-displayFactSheet?PurchaseOrder=4500001234` on system `acd` |
| `s acd` | launchpad home on `acd` |
| `s acd manage purchase` | title search; up to six suggestions |
| `s va41` | guessed from the t-code prefix, offered only if the tenant has `SalesContract-*` |
| `s ?` or `s list` | lists your systems; Enter opens the options page (Chrome may treat a leading `?` as a search, so prefer `list`) |

A parameter only follows a keyed match (alias, t-code, app ID, intent or guess); multi-word title searches cannot carry one.

Plain Enter reuses the current tab when it is already on the target tenant (hash-only navigation, no reload), otherwise a new tab opens. Alt+Enter opens a new foreground tab, Ctrl/Cmd+Enter a background tab (that is how Chrome reports omnibox dispositions).

## Install (unpacked)

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → pick this folder. Same for `edge://extensions`.
2. Open the extension's options page (right-click the icon → Options, or `s ?` + Enter) and add a system: key, host such as `my123456.s4hana.cloud.sap`, environment, default flag.
3. Type `s me21n` in the address bar.

Open the launchpad on a registered tenant once and the extension discovers every intent your roles allow (see below); from then on suggestions use the tenant's own app titles.

## How aliases resolve

Each system has an **edition** (Public Cloud, Private Cloud, On-Premise). It defaults from the host (`*.s4hana.cloud.sap` → Public Cloud, otherwise On-Premise) and is editable; the library's apps are tagged with the editions they exist in and only matching ones are suggested, while seed, imported and personal aliases always apply. A scan that finds `Shell-startGUI` on a system marked Public Cloud (or vice versa) is flagged on the Systems tab, since the hostname cannot tell private cloud from on-premise.

Candidates are merged from four tiers, by precedence: **your aliases** (synced) > **discovered on the tenant** > **seed** (`src/seed/aliases.csv`, `src/seed/tcodes.csv`) > **library** (`src/seed/library.csv`, ~17,000 S/4HANA apps from the Fiori Apps Reference Library, tagged by edition). Ranking: exact alias > exact t-code > exact app ID > exact intent > t-code guess > key prefix > title prefix > title words. Entries discovered on the target tenant win ties.

### Legacy transaction codes

The library does not publish t-codes, so they come from a curated table (`src/seed/tcodes.csv`, ~360 codes with a confidence level) plus a prefix-based guesser (`src/tcodes.js`): `ME2x` → `PurchaseOrder`, `VA4x` → `SalesContract`, `XK/MK` → `Supplier`, last digit `1/2/3` → `create/manage/displayFactSheet`, and so on. A guess is only offered when that intent exists on the target tenant, and low-confidence table rows are dropped once a scan shows the tenant lacks the intent. Suggestions mark these with `guess`. Map or correct t-codes on the options page (Aliases → Transaction codes); your changes shadow the seed.

### Discovery

Two content scripts run on `https://*.s4hana.cloud.sap/ui*`. The MAIN-world script waits for `sap.ushell.Container`, then (after the shell has rendered and the browser is idle) calls the shell's `Navigation` service (`getLinks`, `getSemanticObjects`; `CrossApplicationNavigation` as fallback) and, best effort, `SearchableContent` / `CommonDataModel` for app IDs. Results are posted to the isolated script, which forwards them to the service worker. Everything is read-only and wrapped in try/catch; it never touches the page DOM. Logs are prefixed `[SAPQS]`.

Scans run when the launchpad loads on a registered host and the last scan is missing or older than 7 days, or when you click **Rescan now** in options.

## Toolbar popup

Click the toolbar icon for the same launcher as a small panel: it shows the tenant of the active tab (if registered), an input that behaves like the omnibox (type, arrow keys, Enter; Ctrl/Cmd+Enter for a new tab), and the last ten launches.

## On-premise and private cloud systems

Paste the full launchpad URL, for example `https://acd.finteq.io:8443/sap/bc/ui2/flp?sap-client=600#Shell-home`. The port, the launchpad path and the query (`sap-client`, `sap-language`) are stored on the system and reused on every generated URL, so `s acd me21n` opens `https://acd.finteq.io:8443/sap/bc/ui2/flp?sap-client=600#PurchaseOrder-create`. `http://` hosts are accepted for internal systems. Discovery uses the same shell services; on UI5 releases older than 1.120 it falls back to `CrossApplicationNavigation` automatically. The app library covers on-premise and private cloud apps as well (tagged by edition); the hand-made t-code table is Public Cloud oriented, so on-premise users will rely more on discovery and their own aliases for classic transactions.

## Options page

- **Systems**: settings (suggestion limit, auto-rescan interval, tab reuse), inline table (key, name, customer, host, env, default, optional launchpad path), per-row Open launchpad / Rescan now / Delete, last scan and app count, a warning when a system key collides with an alias, recent launches with **Pin as alias** for guesses and unresolved inputs. Export/import the whole config as JSON.
- **Aliases**: merged static table with inline editing (editing a seed/library row creates a personal copy; deleting one hides it), CSV import (into a local import table or into your synced aliases) and export, a transaction-code view with "map t-code", and a per-system view of discovered apps with **Pin as alias** plus a list of seed/personal intents that the scanned tenant does not offer.

CSV format: `alias,semanticObject,action,appId,tcodes,title,paramKey,editions`; `tcodes` and `editions` separated by `;`, editions ⊆ `public;private;onprem` (empty = all).

## Storage

`chrome.storage.sync` holds systems, your aliases (chunked under the 8 KB per-item limit), hidden-alias markers and settings, so they roam with your profile. `chrome.storage.local` holds the seed/library tables, imported aliases, discovered apps per host, scan metadata and the last 20 launches. Schema is versioned (`schemaVersion`) and migrated on install.

## Seed data

- `src/seed/aliases.csv` – hand-made short aliases with t-codes and parameter keys.
- `src/seed/tcodes.csv` – t-code → intent table with confidence (`high`/`medium`/`low`).
- `src/seed/library.csv` – generated: `npm run seed:library` (`tools/fetch-apps-library.mjs`, Node 20+, no dependencies). It pages the library's undocumented OData service (`.../externalViewer/services/SingleApp.xsodata`) for every S/4HANA app, expands each app's intents, tags each row with the editions it exists in (`public`, `private;onprem`, from the library's release groups) and writes deterministic, sorted CSV. If the service changes, the script fails with instructions; use the library UI's List view → Export to CSV and run the script with `--from <file>`.

## Development

```
npm test        # node --test: resolver, csv, tcodes, storage, and a service-worker harness with a fake chrome API
```

No build step; plain ES modules. `src/resolver.js`, `src/csv.js`, `src/tcodes.js` have no `chrome.*` references; `src/storage.js` takes injectable storage areas.

## Limitations (v1)

- Unknown alias: the App Finder opens and the typed text is copied to the clipboard (via an offscreen document); the finder's search box is not pre-filled because the `searchTerm` URL parameter is not stable across releases. Paste it.
- Seed intents with confidence `low` are educated guesses. Scan a tenant to verify them; the options page marks guesses.
- One Chrome profile per customer is recommended when IAS tenants collide; each profile keeps its own systems list.
- A deep link opened while your IAS session has expired may lose its hash after login; re-run the command.
