# Changelog

## 1.3.0 – scan files

- Discovered apps › Export scan… / Import scan…: one system's scan as a `slashn-scan` JSON file (system row, discovered apps, scan summary). Import stores the scan under the system's host/client and adds the system when it is unknown; an existing system keeps its key and settings. slashn for Mac imports the same file, which is how a desktop launcher without a browser gets to know what a system offers.
- Embedding API: `importConfig` accepts `slashn-scan` files; `exportScan(system, record)` builds one.

## 1.2.1 – one host, several clients; systems files

- Options: the key field accepts `/` and `.` too (the browser-side pattern lagged behind the 1.1.2 rule).
- Launcher: click the system key in the header to rename it in place (Enter saves, Esc cancels); the launch history follows.
- A tab on a client nobody registered (acd.example.com client 600 when only client 400 is a system) is unregistered: the launcher offers to add it instead of treating it as the other client.
- Fix: the launcher stuck at "Checking current tab…" on an unregistered launchpad (a variable lost in the 1.2.0 refactor).
- Systems › Import… / Export…: the system list as a `slashn-systems` JSON file to share with colleagues (no aliases, no scan results). Import merges: a row with the same key or the same host/client updates that system, new rows are added, your default stays. A full backup file is accepted too.
- Two clients of the same system are two systems: pasting a launchpad URL with `sap-client=400` creates `acd400`, and `sap-client=600` creates `acd600`, each with its own scan. The tab you are on is recognised by host and client, so suggestions, tab reuse and scans go to the right client. Scan results of systems with a client move to a `host/client` key once (storage schema 2).

## 1.1.2 – embedding API (unreleased)

- System keys may contain `/` and `.` (for example `acd/400`).

- `suggest` returns the launchpad home URL for an empty line or a bare system key.

- `src/embed.js`: a synchronous, JSON-in/JSON-out API over the resolver (init, setConfig, suggest, resolve, recordLaunch, importConfig, systemFromParts) for hosts without `chrome.*`, used by the macOS launcher through JavaScriptCore. Tested in Node (`npm test`) and in the bare JavaScriptCore shell (`npm run test:jsc`).
- Systems may carry desktop-only fields: `gui` (a SAP Logon landscape entry with client and language), `launchpad: false` for classic systems without a Fiori launchpad, `browserBundleId`. The extension stores them untouched; nothing changes for rows without them.
- `package.json` exports the core modules and seed files for consumers of the repository.

## 1.0.0 – first public release

- Address bar launcher: `s [system] alias [value]` opens Fiori apps and classic transactions by alias, t-code, app ID, intent or title, with ranked suggestions.
- Launcher overlay (Alt+Shift+S or the toolbar button): Spotlight-style panel over the page, availability chips, action chips for app variants, Recent list, filters for available apps and sources, Tab to switch systems.
- Systems: SAP S/4HANA Cloud Public Edition out of the box; private cloud and on-premise launchpads (custom hosts, ports, paths, `sap-client`) after a per-site grant. Paste a launchpad URL to add a system; first-add scan offer.
- Discovery: scans the launchpad shell for the apps your user can reach; live availability check against an open tab; rescans on request without reloading your tab.
- T-codes: ~370 classic codes mapped to Fiori successors, including Basis monitoring replacements for the cloud (SM12, SM13, SM21, SM19/SM20, SM36/SM37, ST22, gCTS), plus a prefix guesser and `/n<code>` for SAP GUI transactions.
- Options: system cards, search-first aliases with CSV import/export, discovered apps per system, open SAP tabs, settings, JSON backup, system-info dialog, shell debug window with catalogued calls.
- Security: the launcher frame renders only when opened by the extension (nonce), scan results are bounded and sender-checked, imports are sanitized, no network calls, no remote code.
