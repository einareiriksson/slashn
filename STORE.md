# Chrome Web Store listing notes

Working notes for the submission. Everything in here is verified against the code at the time of writing; keep it in step with `manifest.json`.

## Listing

- **Name**: slashn
- **Summary** (132 characters max; the manifest description is 128): Launch SAP Fiori apps and classic transactions by alias or t-code: address bar, toolbar or Alt+Shift+S, on cloud and on-premise.
- **Category**: Productivity · **Language**: English
- **Single purpose**: open SAP Fiori apps and transactions on the user's SAP systems by a short alias. Every feature (omnibox, launcher, scan, options) serves that.

**Detailed description** (draft)

> Type `s`, a space and a short alias in the address bar, and slashn opens the SAP Fiori app or classic transaction on the right system: `s me21n` creates a purchase order on your default system, `s tst me23n 4500001234` displays one on the test system. Alt+Shift+S or the toolbar button opens the same launcher as a Spotlight-style overlay on the page.
>
> Aliases come from three places: the classic transaction codes you already know (mapped to their Fiori successors), the Fiori Apps Reference Library (17,000 apps, public cloud, private cloud and on-premise), and a scan of your own launchpads, which lists exactly the apps your user can reach, including custom ones. Scanned systems rank present apps first and tell you when an app is not available before you launch it.
>
> Works with SAP S/4HANA Cloud Public Edition out of the box, and with private cloud and on-premise launchpads once you grant the site. Everything stays in your browser: there is no server, no account and no telemetry.

## Permission justifications

Copy into the dashboard's per-permission fields.

| Permission | Why | Where in code |
|---|---|---|
| `storage`, `unlimitedStorage` | Systems, aliases and settings; the bundled app library (2.5 MB of seed data) and scan results of each system in local storage, which exceeds the 10 MB default on large tenants | `src/storage.js` |
| `tabs` | Read tab URLs to grey out the toolbar button on pages that are not a SAP launchpad, to find an open launchpad tab of a system for a scan or a launch, and for the "Open tabs" list on the options page | `applyActionState`, `rescanTab`, `liveCheck` in `src/background.js`; `renderTabs` in `src/options/options.js` |
| `activeTab` | On the toolbar click or shortcut: show the launcher as an overlay on the current page, and read the About dialog of a launchpad page the user wants to add as a system | `openLauncher` in `src/background.js`; `src/probe.js` |
| `scripting` | Inject the overlay and the About-dialog reader into the current tab, and register the launchpad content scripts for hosts the user granted at runtime | `showLauncherOverlay`, `syncContentScripts` in `src/background.js` |
| `offscreen`, `clipboardWrite` | Copy an unresolved alias to the clipboard when the App Finder opens, so it can be pasted into its search box. Opt-in setting, off by default | `copyToClipboard` in `src/background.js`, `src/offscreen/` |
| Host permission `https://*.s4hana.cloud.sap/*` | Run the discovery content scripts on SAP S/4HANA Cloud launchpads: the launchpad shell is asked which apps the user can open | `manifest.json` content scripts, `src/content-main.js`, `src/content-isolated.js` |
| Optional host permissions `https://*/*`, `http://*/*` | Private cloud and on-premise launchpads live on customer hosts. Access is requested per origin when the user adds such a system, and the content scripts are registered only for granted origins | `src/options/options.js`, `src/popup/popup.js`, `syncContentScripts` |

Web-accessible resource `src/popup/popup.html` for `http(s)://*/*`: the launcher overlay frames the extension page inside the current tab. The page renders only after the service worker confirms a per-open nonce, so a web page that frames it on its own gets a blank frame.

**Remote code**: none. All scripts are in the package; the only `fetch` calls load bundled seed files.

## Data usage disclosure

- Collects: **website content** (the list of apps a SAP launchpad reports, stored on the device), **web history** in the narrow sense that tab URLs are read to recognise SAP pages (not stored, apart from the user's own last 20 launches). No personally identifiable information, no authentication information, no financial or health data, no personal communications, no location, no user activity tracking.
- Not sold, not transferred to third parties, not used for purposes unrelated to the single purpose, not used for creditworthiness or lending.
- Privacy policy URL: https://github.com/einareiriksson/slashn/blob/main/PRIVACY.md
- Homepage URL: https://github.com/einareiriksson/slashn · Support URL: https://github.com/einareiriksson/slashn/issues

## Assets

- [x] Icon 128×128 PNG: `icons/icon128.png`
- [x] Small promo tile 440×280: `store/promo-tile-440x280.png`; marquee 1400×560: `store/promo-marquee-1400x560.png` (both rendered from `store/promo.html`; edit the HTML and re-shoot to change them)
- [ ] Screenshots, 1280×800 PNG, 1 to 5, taken from the real extension. Set the Chrome window to 1280×800 (DevTools › device toolbar › Responsive 1280×800, or a macOS screenshot of the window resized to that size), light or dark theme consistently:
  1. The launcher overlay on a scanned launchpad with a typed query and results (chips visible on the selected row), the page dimmed behind it.
  2. The address bar with `s acd manage pur` and its suggestions.
  3. Options › Systems with two or three system cards (one with a last scan and app count).
  4. The system-info dialog of an on-premise system (product version, client, roles).
  5. Options › Settings (optional).
  Use demo-looking system names and hosts, or blur customer hosts before uploading.

## Before the first upload

- The policy is public at the URL above; it names the issue tracker as the contact. Add the support email you give the store to its Contact section if you want one there too.
- Decide on the `tabs` permission: it is what produces the "Read your browsing history" warning at install. It is needed only to grey out the toolbar button on non-SAP pages and for the Open tabs list; without it the launcher, scans and launches work unchanged. Keep it for the first release, or drop the greying feature and the permission for a quieter install prompt.
- Register the publisher account (one-time fee), and set the same support email in the listing as in the policy.

## Build and submit

1. `npm test` (all green), bump `version` in `manifest.json` and `package.json` together.
2. `npm run pack` writes `dist/slashn-<version>.zip` with `manifest.json`, `icons/` and `src/` only; the script checks that every file the manifest names is in the archive.
3. Smoke test the zip unpacked: install, options page opens on first run, add a system by URL, `s <key>` opens its home, Alt+Shift+S on an ordinary page opens the overlay and on `chrome://extensions` the window, a scan reports apps, the toolbar icon turns red on a non-SAP page.
4. Upload, fill the justifications and the data disclosure above, set visibility, submit. Microsoft Edge Add-ons accepts the same zip.
