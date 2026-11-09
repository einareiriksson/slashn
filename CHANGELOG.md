# Changelog

## 1.0.0 – first public release

- Address bar launcher: `s [system] alias [value]` opens Fiori apps and classic transactions by alias, t-code, app ID, intent or title, with ranked suggestions.
- Launcher overlay (Alt+Shift+S or the toolbar button): Spotlight-style panel over the page, availability chips, action chips for app variants, Recent list, filters for available apps and sources, Tab to switch systems.
- Systems: SAP S/4HANA Cloud Public Edition out of the box; private cloud and on-premise launchpads (custom hosts, ports, paths, `sap-client`) after a per-site grant. Paste a launchpad URL to add a system; first-add scan offer.
- Discovery: scans the launchpad shell for the apps your user can reach; live availability check against an open tab; rescans on request without reloading your tab.
- T-codes: ~370 classic codes mapped to Fiori successors, including Basis monitoring replacements for the cloud (SM12, SM13, SM21, SM19/SM20, SM36/SM37, ST22, gCTS), plus a prefix guesser and `/n<code>` for SAP GUI transactions.
- Options: system cards, search-first aliases with CSV import/export, discovered apps per system, open SAP tabs, settings, JSON backup, system-info dialog, shell debug window with catalogued calls.
- Security: the launcher frame renders only when opened by the extension (nonce), scan results are bounded and sender-checked, imports are sanitized, no network calls, no remote code.
