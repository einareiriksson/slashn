# slashn privacy policy

_Last updated: 9 November 2026_

slashn is a browser extension that opens SAP Fiori apps and classic transactions on the SAP systems you register, from the address bar, the toolbar button or a keyboard shortcut. This page describes what it stores, where, and what never happens.

## What slashn does not do

- It does not send any data to the developer or to any third party. There is no server, no analytics, no telemetry, no crash reporting.
- It does not read or store SAP business data. It never writes to a SAP system.
- It does not read pages other than SAP Fiori launchpads you registered or granted access to, and on those it reads only the launchpad shell's own list of apps.

## What it stores

**Synced with your browser profile** (`chrome.storage.sync`, encrypted and roamed by your browser vendor's account sync when you have it switched on; otherwise kept on the device):

- the systems you register: a short key, an optional name and customer label, the launchpad host name, scheme, path and query (for example a `sap-client` number), environment tier and edition;
- your personal aliases and the built-in rows you hid;
- settings.

**On this device only** (`chrome.storage.local`):

- the built-in app library and transaction tables shipped with the extension;
- for each system you scanned: the list of apps the launchpad reported for your user (intent, title, app ID), when the scan ran, the UI5 version, and the product and system information the launchpad's About dialog shows (product version, system ID, client, system and client role). No user name, password, token or cookie is stored;
- your last 20 launches (the system, the alias and the URL opened), for the Recent list and for ranking.

Nothing is stored in cookies or in any web page's storage.

## What it reads, and when

- **Launchpad pages** of registered systems: a content script asks the launchpad shell which apps your user can navigate to, so that suggestions reflect what exists there. It runs on `*.s4hana.cloud.sap` launchpads by default, and on other hosts only after you grant that site in the browser's own permission prompt. The same page access lets the toolbar launcher show whether an app is available in your current session.
- **Tab URLs and titles** (the `tabs` permission): to grey out the toolbar button on pages that are not a SAP launchpad, to find an open launchpad tab for a scan or a launch, and for the Open tabs list on the options page. URLs are compared with your registered hosts and are not stored, except as part of the last 20 launches you made yourself.
- **The current page** when you click the toolbar button or press the shortcut (the `activeTab` permission): to show the launcher as an overlay on that page, and, on a page that looks like a launchpad, to read its About dialog so the system can be added with the right edition.
- **Clipboard**: only when you switch on the setting that copies an unresolved alias to the clipboard. It is off by default.

## The shell debug window

The options page has a developer window that runs a fixed list of launchpad API calls in an open tab of one of your systems and shows the raw answer. It runs only when you click, only against your own open tab, and it executes nothing you type. Answers are shown, not stored.

## Removing your data

Uninstalling the extension deletes everything it stored in the browser. The options page can also delete discovered app lists per system, clear recent launches and remove systems and aliases one by one; the Export button gives you a copy first.

## Changes

Changes to this policy are published with the extension's release notes and on this page.

## Contact

Open an issue at https://github.com/einareiriksson/slashn/issues, or write to the support address shown on the store listing. The source code is public at https://github.com/einareiriksson/slashn under the MIT licence, so everything described here can be verified.
