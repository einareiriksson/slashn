# slashn (SAP app launcher)

Chrome/Edge extension (Manifest V3) that launches SAP Fiori apps and classic transactions the way you think of them: by alias, old transaction code or app ID, on the system you mean. Type `s`, a space and an alias in the address bar, click the toolbar button, or press Alt+Shift+S for a Spotlight-style launcher over any page, and you land in the app on the right tenant – S/4HANA Cloud Public or Private Edition, or an on-premise system, with classic transactions opened in SAP GUI for HTML where the Fiori successor does not exist. It learns what each system actually offers your user by scanning its launchpad, maps some 400 classic codes to their successor apps, and carries a 17,000-app reference library.

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
| `s fin /nse16` | transaction SE16 in SAP GUI for HTML on system `fin` (`#Shell-startGUI?sap-ui2-tcode=SE16`); On-Premise and Private Cloud systems only |

A parameter only follows a keyed match (alias, t-code, app ID, intent or guess); multi-word title searches cannot carry one.

Plain Enter reuses the current tab when it is already on the target tenant (hash-only navigation, no reload), otherwise a new tab opens. Alt+Enter opens a new foreground tab, Ctrl/Cmd+Enter a background tab (that is how Chrome reports omnibox dispositions).

## Install (unpacked)

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → pick this folder. Same for `edge://extensions`.
2. Open the extension's options page (right-click the icon → Options, or `s ?` + Enter) and add a system: key, host such as `my123456.s4hana.cloud.sap`, environment, default flag.
3. Type `s me21n` in the address bar.

Open the launchpad on a registered tenant once and the extension discovers every intent your roles allow (see below); from then on suggestions use the tenant's own app titles.

## How aliases resolve

Each system has an **edition** (Public Cloud, Private Cloud, On-Premise). It defaults from the host (`*.s4hana.cloud.sap` → Public Cloud, otherwise On-Premise) and is editable; the library's apps are tagged with the editions they exist in and only matching ones are suggested, while seed, imported and personal aliases always apply. A scan also records what the launchpad's **About** dialog shows (product name and version, system name, system and tenant role, read from `sap.ushell.Container.getLogonSystem()`, and the Application tab's version and app ID from the `AppLifeCycle` service); the product version is shown on the system card (an on-premise system answers with every installed product, one per line; the `SAP S/4HANA …` line is kept as the product version and the whole list is shown in the system-info dialog), and when it clearly contradicts the edition you set (for example `SAP S/4HANA CLOUD 2508` on a system marked On-Premise) the card says so. The classification is deliberately cautious: "Cloud" with a YYMM release or "Public" → Public Cloud, "Private" → Private Cloud, a year release such as `2023` or `1909` → classic stack, and anything else is left undecided. "Add as system" in the popup reads the same fields from the open page and presets the edition. Intents are never used for this (Public Cloud exposes `Shell-startGUI` too).

Candidates are merged from four tiers, by precedence: **your aliases** (synced) > **discovered on the tenant** > **seed** (`src/seed/aliases.csv`, `src/seed/tcodes.csv`) > **library** (`src/seed/library.csv`, ~17,000 S/4HANA apps from the Fiori Apps Reference Library, tagged by edition). Ranking: exact alias > exact t-code > exact app ID > exact intent > t-code guess > key prefix > title prefix > title words; after a scan, an exact keyed match the scan found present outranks one of a higher tier the scan found absent. Within a tier, apps you launched lately on that system come first (the boost fades over the last 20 launches, repeated launches add a little more, and neither ever lifts a row over a higher tier), fact sheets (`…FactSheet` intents, reached by navigation rather than typed) sit a notch below their siblings, then entries discovered on the target tenant win ties.

### Legacy transaction codes

The library does not publish t-codes, so they come from two tables and a guesser. `src/seed/tcodes.csv` (~370 codes with a confidence level) names the successor *intent*; when the row also names an app ID and the library has that app under the intent, the code attaches to that app alone (ApplicationLog-showList is shared by a dozen unrelated logs), otherwise to every app with the intent. Classic Basis monitoring without a cloud counterpart (SM12/SMENQ, SM13, SM21) points at the apps that take over the job there: user sessions, application logs, the AIF message dashboard, the authorization trace; on premise the scan marks those absent and `/n<code>` opens the GUI transaction. `src/seed/tcode-apps.json` (~300 classic codes across FI, CO, MM, SD, PP, PM, QM and Basis) names the successor *app* by Fiori app ID and title; each code is attached to that app's primary library entry (the one whose alias is the app ID, so a nine-intent app such as Manage Journal Entries yields one hit, not nine). An ID the table marks unverified is trusted only when the library's title for it agrees with the table's app name, otherwise the title alone is matched, and codes that match nothing (SNOTE, SM50, ADT-only tools) are logged at seed time and ignored. Once a tenant is scanned, a code whose mapped app is present outranks the same code's alias row whose app is absent, so `me21n` on a system without the create app opens Manage Purchase Orders instead of asking you to confirm an unavailable launch; the alias row and the SAP GUI transaction stay in the list. On top of that a prefix-based guesser (`src/tcodes.js`): `ME2x` → `PurchaseOrder`, `VA4x` → `SalesContract`, `XK/MK` → `Supplier`, last digit `1/2/3` → `create/manage/displayFactSheet`, and so on. A guess is only offered when that intent exists on the target tenant, and low-confidence table rows are dropped once a scan shows the tenant lacks the intent. Suggestions mark these with `guess`. Map or correct t-codes on the options page (Aliases → Transaction codes); your changes shadow the seed.

### Discovery

Two content scripts run on `https://*.s4hana.cloud.sap/ui*`. The MAIN-world script waits for `sap.ushell.Container`, then (after the shell has rendered and the browser is idle) calls the shell's `Navigation` service (`getLinks`, `getSemanticObjects`; `CrossApplicationNavigation` as fallback) and, best effort, `SearchableContent` / `CommonDataModel` for app IDs. Results are posted to the isolated script, which forwards them to the service worker. Everything is read-only and wrapped in try/catch; it never touches the page DOM. Logs are prefixed `[SAPQS]`.

Scans run when the launchpad loads on a registered host and the last scan is missing or older than 7 days, or when you click **Rescan now** in options. A scan you ask for runs where you asked for it: from the launcher it is the tab the launcher sits on, from options it is a launchpad tab of that system in the same window (the active one first), and when there is none there a new tab opens in that window; a launchpad tab in another window is never reloaded behind your back.

### Is the app available to me?

`getLinks` only returns intents the launchpad can resolve for the logged-in user, so a scan tells you what *you* can open on that system. slashn uses it two ways:

- **After a scan**, every suggestion for that system is judged: intents the scan offers are tagged `on tenant`; intents it lacks are tagged `not found on <key>` (omnibox) and sink below other matches of the same kind. The popup marks only the exceptions: an entry the last scan did not find on the system gets a grey `not assigned` chip, one a live check of an open tab rejects gets `not available`, and available entries carry no chip at all (nor does anything while the **available only** filter is on, since it leaves nothing unavailable). Unscanned systems and `Shell-*` intents get no tag. The omnibox still opens such an app on Enter (the launchpad then shows its own error); the popup asks once and opens on a second Enter.
- **Live check**: when a tab of the target system is already open, the popup asks that page `Navigation.isNavigationSupported` for the suggested intents and the chips then reflect your current session instead of the scan. The same check runs right before a popup launch, and a live answer overrides the scan. If live and scan disagree, the host is rescanned on its next load.

What the extension cannot tell apart is *not installed* versus *not authorised*: from the browser both look the same (the intent is missing). Data-level authorisations, for instance a company code you may not see, only surface once the app runs.

## Launcher window

Press **Alt+Shift+S** on any page (change it under chrome://extensions/shortcuts; Chrome can also make it a global shortcut that works while another app is in front) and the launcher appears Spotlight-style: on ordinary web pages as a translucent, frosted panel floating over the lightly dimmed page, which stays readable unless the setting **Blur the page behind the launcher overlay** is on (an overlay injected into the page under the `activeTab` grant the shortcut gives, with the launcher page in an iframe; `src/popup/popup.html` is web-accessible for that), and on pages that cannot be scripted – chrome:// pages, the Web Store, PDFs – as a small centred window instead, since Chrome cannot make an extension window transparent. Type, arrow keys, Enter; Esc, pressing the shortcut again or clicking outside closes it. It remembers which tab you were on, so a launch reuses that tab when it is already on the target system, and new tabs open next to it. **Open now** under Settings opens it from the options page too. It works on pages where the toolbar button is switched off.

## Toolbar popup

Click the toolbar icon and the same launcher opens as the overlay described above (or the centred window on pages that cannot be scripted); the button has no Chrome-anchored popup any more. It looks at the active tab: on a registered tenant, queries without a system key search that tenant; on an unregistered page that looks like a Fiori launchpad (SAP cloud host, `/sap/bc/ui2/flp` path, intent-style hash, or a page exposing `sap.ushell`) it offers **Add as system**, which derives the row from the URL, asks for site access on custom hosts, and then offers to scan the new system right away (**Scan now** reads the apps in that tab, or opens a fresh launchpad tab when this one has no content script yet so that unsaved work is never reloaded away, after which the launcher reopens by itself with the scan result in its hint line; **Later** leaves it to the next launchpad load). The options page makes the same offer on the card of a system you have just added. It also shows an input that behaves like the omnibox (type, arrow keys, Enter; Ctrl/Cmd+Enter for a new tab) and, while the search box is empty (fewer than three characters and no results), the last five launches across all systems, each tagged with its system key; the Recent section disappears as soon as there are results, and the result list grows with its rows so nothing gapes between the last hit and the footer. The footer holds the ⓘ system-info button (the header, which names the system, opens the same panel when clicked), two filters, icon-only keyboard hints with tooltips (↵, ⌘↵ or Ctrl↵, ⇥ followed by the key of the system one Tab away, esc; Tab cycles the target system by rewriting the key in front of your text, Shift+Tab goes back) and the options cog. The header shows the registry display name over the host, or, without one, a single line with a label derived from the host (`my420635`, `acd`) followed by the host in dim text. In the page overlay the panel shrinks to the rows shown and grows up to its maximum before scrolling. **available only** keeps just the apps the last scan found on the system (on an on-premise system that includes SAP GUI transactions once the scan has seen `Shell-startGUI`); the setting is remembered, and on a system that has not been scanned yet it is ignored with a note in the hint line. **source** narrows the suggestions to one origin: my aliases (your own and imported ones), discovered (what the scan found), built-in (the seed tables) or library; a forced `/n` transaction ignores it, and the choice is remembered too. The hint line under the search box stays empty for an ordinary launch on the current system; it shows the "Open … [system · host]" description only when Enter would do something non-obvious, namely open the app on another system than the tab's (in a new tab), and it carries notices such as an unscanned system or an empty filter result. Each hit is two lines: the key you type in front, the title on the first line and the intent (with the Fiori app ID when it differs from the key, and the t-code when that is what matched) on the second. Sibling library entries of one app – the generated codes `f1492`, `f1492-2`, `f1492-4` for its intents – are grouped into a single row keyed by the app ID; the selected row shows the intents' actions as a chip strip on a third line (display, maintain, compare …; two chips with the same action also name their object) that ←/→ or a click select, other grouped rows just say `· 3 actions`, Enter opens the chosen one, and a code typed for a particular variant preselects its chip. Rows with an alias of their own, yours or a t-code, stay separate, and your own aliases carry a small dot in the code column. An app ID on the second line is shown in the same lower case as the code column, only when it differs from the code. A row without a human-readable title shows its intent once, as the title, and uses the second line for its origin (my alias, discovered on the system, built-in alias, app library, SAP GUI transaction) rather than repeating the intent. The characters that matched are underlined where the match happened – in the key, app ID, t-code or intent for keyed matches, in the title for title matches – so it is clear why a row ranked. The result list and the recent list have fixed heights, so the panel does not resize while you type; a seventh or eighth hit scrolls.

The omnibox behaves the same way: while you are on a registered tenant's tab, `s me21n` opens the app there rather than on the default system. Prefix a system key to go elsewhere.

## On-premise and private cloud systems

Paste the full launchpad URL, for example `https://acd.finteq.io:8443/sap/bc/ui2/flp?sap-client=600#Shell-home`. The port, the launchpad path and the query (`sap-client`, `sap-language`) are stored on the system and reused on every generated URL, so `s acd me21n` opens `https://acd.finteq.io:8443/sap/bc/ui2/flp?sap-client=600#PurchaseOrder-create`. `http://` hosts are accepted for internal systems. A default port written explicitly (`:443` for https, `:80` for http) is dropped, because tabs and content scripts report the host without it; a non-default port is part of the system's identity, so `acd.finteq.io` and `acd.finteq.io:8443` are two different systems. Discovery uses the same shell services; on UI5 releases older than 1.120 it falls back to `CrossApplicationNavigation` automatically. The app library covers on-premise and private cloud apps as well (tagged by edition); the hand-made t-code table is Public Cloud oriented, so on-premise users will rely more on discovery and their own aliases for classic transactions.

### Classic transactions in SAP GUI

On systems whose edition is On-Premise or Private Cloud, a transaction code is also offered as a SAP GUI launch: `#Shell-startGUI?sap-ui2-tcode=ME21N`, which the launchpad runs in SAP GUI for HTML (the parameter is `sap-ui2-tcode`; the shell's GUI resolver reads exactly that name and starts transaction "undefined" for anything else). The suggestion shows as `/nme21n  Transaction ME21N in SAP GUI`, mirroring the GUI command field, and typing `/n` yourself forces it (`s fin /nse16`). The ranking follows the scan:

- the Fiori intent the t-code maps to is known to be absent on that system, or there is no Fiori match at all: the GUI launch comes first;
- the Fiori intent is present or not yet verified (no scan): the Fiori app stays first and the GUI launch is second;
- the scan shows the system does not offer `Shell-startGUI` (no WebGUI role): GUI launches are not offered at all.

Only inputs that look like transaction codes get the row: anything with a digit, underscore or namespace (`me21n`, `s_alr_87012357`, `/sapapo/sdp94`) always does; letters-only codes of up to four characters (`stms`, `pfcg`) only when nothing else matches, so a short word like `sale` still searches titles. A value typed after the code is not passed to the GUI transaction. Public Cloud systems never get GUI rows, since the intent exists there but almost no transactions are reachable.

## System information dialog

The ⓘ button in the popup (on a registered system's tab) and **Info** on a system card in options open a small popup-style window (no tabs, no address bar) for that system. It lists the system row, the launchpad URL slashn generates, and the fields the launchpad's About dialog shows, as recorded by the last scan. The **System** tab's fields come from `sap.ushell.Container.getLogonSystem()`: product name, product version, system name, system role, tenant role and client, plus the UI5 version. The **Application** tab's fields come from `AppLifeCycle.getCurrentApplication().getAllAppInfo()`, which is what the dialog itself calls (with `getInfo()` and the running component's manifest entry `/sap.app/applicationVersion/version` as fallbacks on older releases): version, application ID, intent, support and technical component, framework and framework version (title, transaction and content provider are read but not listed, as are the product name, the system name and the on-premise installed-products list behind the product version). The on-premise **Client role** is the client category from `T000` (SCC4), which the launchpad hands over as a single letter; the dialog decodes it (P Production, T Test, C Customizing, D Demo, E Training/Education, S SAP reference) and shows `D · Demo`. On S/4HANA the application version carries the stack version (for example `2025.0.23` on both On-Premise and Public Cloud), so the system card shows it after the product line; it describes whichever app was running when the fields were read, usually the home page. When the dialog opens it reads both tabs live from an open launchpad tab of that system (run through `chrome.scripting` in the page's MAIN world), stores them with the scan metadata and marks each row `live`; the scan date and app count are left alone. Without an open tab it shows what the last scan recorded, and **Refresh from open tab** re-reads later. A second click on the button focuses the existing window instead of opening another.

## Shell debug window

**Debug** in the system-info dialog, or **Open shell debug…** under Settings › Developer, opens a window where each launchpad API the extension relies on can be run on demand in an open tab of a system, with the raw answer shown as JSON next to the elapsed time and any error. The catalogue covers every getter of `getLogonSystem()` (one at a time, or all of them with the ones that throw marked), `AppLifeCycle.getCurrentApplication().getInfo()` with an editable key list, `sap.ui.version` and the ushell library version, the shell user, which services resolve and the methods they expose, `Navigation` and `CrossApplicationNavigation` links and semantic objects, a live `isNavigationSupported` check for intents you type, `SearchableContent.getApps()`, `CommonDataModel.getApplications()`, and a custom expression evaluated in the page (blocked where the page's CSP forbids eval). **Run whole group** runs every call of the selected group; **Copy output** copies the results as text for a bug report. Answers are bounded before they leave the page (depth, array length and string length), so a large catalogue shows a count and the first entries.

## Options page

Four sections in a sidebar:

- **Systems**: one card per system (key, name, environment, host, edition, last scan and app count). Paste a launchpad URL to add one; **Edit** opens the full form in place (key, name, customer, environment, edition, host, scheme, launchpad path, query, default). Cards warn when a custom host lacks site access and when a system key collides with an alias.
- **Aliases**: search-first. With nothing typed you see only your own aliases; a search covers all built-in and library rows (alias, t-code, app ID, intent, title) and shows up to 100 results. **Edit** opens a row editor; saving a built-in or library row stores a personal copy, **Hide** removes it from suggestions (restorable). **Add alias** takes an intent or an existing alias to copy, which is also how a legacy t-code gets mapped. CSV import and export live under a collapsed section.
- **Discovered apps**: what each scanned system offers, with **Pin as alias**, a rescan button and a collapsed list of built-in or personal aliases the system does not offer. **Export scan…** saves one system's scan as a `slashn-scan` file (the system row travels with it) for a colleague or for [slashn for Mac](https://github.com/einareiriksson/slashn-mac); **Import scan…** loads such a file, adding the system when you do not have it.
- **Open tabs**: every browser tab on a registered system or a launchpad-looking page, across all windows, with the system key, environment, page title and the intent in its hash; clicking a row (or **Go to tab**) switches to it and focuses its window, **Close** closes it, and the list follows tab changes while the page is open.
- **Settings**: suggestion limit, auto-rescan interval, tab reuse, whether the toolbar button is disabled on pages that are not a SAP launchpad, shown as a dimmed red tile (`icons/icon-off*.png`, the blue icons recoloured pixel for pixel so the edges stay identical; `icons/icon-off.svg` is the reference drawing; Chrome draws a disabled action with the extension's default icon, so the red tile is set as the default and SAP tabs get the blue one per tab) (on by default; a registered system's host or any page that looks like a launchpad keeps it active, and the address bar launcher works everywhere regardless; judging arbitrary pages needs the `tabs` permission, which is why the extension asks to read tab URLs), JSON backup and restore, and recent launches with **Pin as alias** for guesses and unresolved inputs.

CSV format: `alias,semanticObject,action,appId,tcodes,title,paramKey,editions`; `tcodes` and `editions` separated by `;`, editions ⊆ `public;private;onprem` (empty = all).

## Security and privacy

Source and issues: https://github.com/einareiriksson/slashn (MIT). See [PRIVACY.md](PRIVACY.md) for the policy text and [STORE.md](STORE.md) for the Chrome Web Store listing notes and permission justifications. In short: nothing is sent to any server; configuration syncs through the browser profile, discovered app lists stay on the device. Design points a reviewer may look for:

- The service worker accepts messages only from the extension itself (`sender.id`), and scan results only from a content script whose tab is on the host it reports; every field of a scan result is bounded before it is stored, and imported backups pass through the same sanitizers.
- `src/popup/popup.html` is web-accessible so the overlay can frame it, which means any web page could frame it too. The worker mints a nonce per open (kept in session storage, passed in the frame URL inside a closed shadow root) and the page renders nothing until the worker confirms it; a frame added by a web page stays blank, so its buttons cannot be clickjacked.
- A system added from the launcher is written only after the user has answered the site-access prompt.
- URLs are built from a validated host and scheme; intents and parameters live in the fragment and are encoded. No remote code, no `eval`; the shell debug window runs catalogued calls only.
- A requested rescan never reloads a tab: when the tab has no content script yet, a fresh launchpad tab scans instead.

## Storage

`chrome.storage.sync` holds systems, your aliases (chunked under the 8 KB per-item limit), hidden-alias markers and settings, so they roam with your profile. `chrome.storage.local` holds the seed/library tables, imported aliases, discovered apps per host, scan metadata and the last 20 launches. Schema is versioned (`schemaVersion`) and migrated on install.

## Seed data

- `src/seed/aliases.csv` – hand-made short aliases with t-codes and parameter keys.
- `src/seed/tcodes.csv` – t-code → intent table with confidence (`high`/`medium`/`low`).
- `src/seed/tcode-apps.json` – t-code → successor Fiori app table (`tcode`, `module`, `description`, `app`, `appId`, `idVerified`, `notes`); merged by app ID, then by title.
- `src/seed/library.csv` – generated: `npm run seed:library` (`tools/fetch-apps-library.mjs`, Node 20+, no dependencies). It pages the library's undocumented OData service (`.../externalViewer/services/SingleApp.xsodata`) for every S/4HANA app, expands each app's intents, tags each row with the editions it exists in (`public`, `private;onprem`, from the library's release groups) and writes deterministic, sorted CSV. If the service changes, the script fails with instructions; use the library UI's List view → Export to CSV and run the script with `--from <file>`.

## Development

```
npm test        # node --test, see below
```

| File | Covers |
|---|---|
| `test/resolver.test.mjs` | parsing, alias merging, ranking, suggestion formatting |
| `test/urls.test.mjs` | URL composition end to end: pasted launchpad URL → system row → generated URLs → host matching, for public cloud, private cloud and on-premise flavours (ports, `http`, `/sap/bc/ui2/flp`, `FioriLaunchpad.html`, `sap-client`), parameter encoding, default-port normalisation |
| `test/storage.test.mjs` | system rows, chunked sync storage, migration, export/import, edition detection |
| `test/csv.test.mjs`, `test/tcodes.test.mjs` | CSV parsing, t-code table and guesser |
| `test/content-scripts.test.mjs` | the two content scripts run in a `vm` sandbox with a fake `window`/`location`/`chrome` and a fake `sap.ushell` shell: what host they report (hostname plus non-default port), discovery payload shape, live check ordering, origin and namespace filtering |
| `test/background.test.mjs` | the service worker driven through a fake `chrome.*` API: omnibox, navigation and tab reuse, discovery handshake, rescan, popup messages, availability; a block of on-premise cases with port, path, query and `http`; the system-info window and live probe |
| `test/probe.test.mjs` | the About-dialog reader that `chrome.scripting` injects into the page, and the row model of the system-info dialog |
| `test/debug.test.mjs` | the shell debug runner injected into the page: every catalogued call against a fake shell, error reporting, and the bounded JSON-safe serialisation of answers |
| `tools/pack.mjs` | `npm run pack`: the store zip (`manifest.json`, `icons/`, `src/` only) in `dist/`, checked against the files the manifest names |
| `PRIVACY.md`, `STORE.md`, `LICENSE`, `CHANGELOG.md` | privacy policy, Chrome Web Store listing notes with permission justifications and asset checklist, MIT licence, release notes |
| `store/` | promo artwork for the store listing (`promo.html` and the rendered 440×280 tile and 1400×560 marquee) |

When adding a launchpad flavour, add a row to `FLAVOURS` in `test/urls.test.mjs`; every generated URL, re-parse round trip, tab-reuse check and origin pattern is asserted from that one row.

No build step; plain ES modules. `src/resolver.js`, `src/csv.js`, `src/tcodes.js` have no `chrome.*` references; `src/storage.js` takes injectable storage areas. `src/embed.js` wraps them in a synchronous JSON-in/JSON-out API for hosts without `chrome.*` (the [macOS launcher](https://github.com/einareiriksson/slashn-mac) runs it in JavaScriptCore); `package.json` exports the core modules and seed files, and `npm run test:jsc` runs the embedding tests in the bare JavaScriptCore shell.

## Limitations (v1)

- Unknown alias: the App Finder opens; the finder's search box is not pre-filled because the `searchTerm` URL parameter is not stable across releases. With the setting **Copy an unresolved alias to the clipboard** on (off by default, since it replaces the clipboard's content) the typed text is copied via an offscreen document so you can paste it.
- Availability is per host, not per user: if several people share one Chrome profile, the scan reflects whoever loaded the launchpad last. The live check always reflects the session in the open tab.
- Seed intents with confidence `low` are educated guesses. Scan a tenant to verify them; the options page marks guesses.
- One Chrome profile per customer is recommended when IAS tenants collide; each profile keeps its own systems list.
- A deep link opened while your IAS session has expired may lose its hash after login; re-run the command.
