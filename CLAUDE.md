# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Reachable from the hub.** `../HUB.html` ("Werkzeuge") links every tool in `tools/` and registers this one as id `ausgaben` → `Ausgabentool/haushaltsbuch.html`, with the note `"Chrome/Edge"` (see below for why). Renaming this file or its folder breaks that link — update the `TOOLS` entry and the filename table in `../CLAUDE.md` in the same change. Folder-wide conventions live in `../CLAUDE.md`.

## What this is

`haushaltsbuch.html` ("Ausgaben-Auswertung") is a single-file German household-budget analyzer: no build step, no package.json. It imports bank/account CSV exports, categorizes every transaction by keyword, and turns that into reports, category trend charts, and budget "Töpfe" (pots) that track spending against a source of money rather than just a category. German is the UI language; keep new UI copy in German. Code comments are German too.

Two CDN dependencies, both loaded at the top of `<head>`: **Chart.js 4.4.1** (all charts in this tool are Chart.js, not hand-rolled SVG — see Charts below) and **sql.js 1.10.x** (SQLite compiled to WebAssembly, the tool's actual persistence layer).

This tool is architecturally the odd one out in the `tools/` collection: everything else uses `localStorage` directly; this one uses a real SQLite database file. It also does **not** share the `--pine`/`--sky`/`--clay`/`--amber`/`--gold` design-token family described in `../CLAUDE.md` — its `:root` block defines its own semantic tokens (`--accent`, `--success`, `--danger`, `--amber`, each with a `-light` pair) and dark-mode values inline under `@media (prefers-color-scheme: dark)`. There is **no manual theme toggle and no `data-theme` attribute** — dark mode here follows the OS setting only, unlike the shared-family tools. There are **no keyboard shortcuts**. It does carry the shared `.hub-back` component verbatim, same as every other tool.

## Running / testing

No build, lint, or test tooling. Open `haushaltsbuch.html` directly in a browser — but the File System Access API (the whole point of the persistence model, see below) is Chrome/Edge only, which is why `HUB.html` flags this tool with `note: "Chrome/Edge"`. In Safari/Firefox the tool still loads but can never open or create a `.db` file. There are no automated tests; verify changes by interacting with the UI manually.

The folder also contains `haushaltsbuch.db` (the author's real financial data, gitignored via `.gitignore`'s `*.db`) and `sqlite-store.js` — see **Known dead code** below for why that second file matters.

## Architecture

### Persistence — SQLite file, not localStorage

All transaction and settings data lives in a single SQLite database that the user explicitly creates/opens via the File System Access API (`createDbFile()` / `openDbFile()`), then the *file handle itself* is remembered across sessions in IndexedDB (store `haushaltsbuch`, key `meta`/`fileHandle` — see `openIDB()`/`idbPut()`/`idbGet()`) so the tool can silently reopen it next time. Browsers still forget the actual *permission* between sessions, so a returning user has to click through `requestFileAccess()` once per session before the tool can read/write again — this can't be automated away, it is a browser security requirement.

Schema (`CREATE_SCHEMA`, applied via `CREATE TABLE IF NOT EXISTS` so it's safe to run against an existing file):
```sql
CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date_iso TEXT NOT NULL, amount REAL NOT NULL,
  payee TEXT NOT NULL DEFAULT '', purpose TEXT NOT NULL DEFAULT '', bank TEXT NOT NULL DEFAULT '',
  dup_seq INTEGER NOT NULL DEFAULT 0,
  UNIQUE(date_iso, amount, payee, purpose, bank, dup_seq)
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```
`dup_seq` is a per-import occurrence counter (see Import below); it's a relatively recent addition, so `migrateDupSeqColumn()` runs on every DB open and, if an older file lacks the column, does an online `RENAME TO … _pre_dupseq` → recreate → copy-back → drop migration to add it with `dup_seq = 0` for all existing rows. `settings` is a generic key→JSON-string blob store, read/written only through `dbGetSetting(key)` / `dbSetSetting(key, value)` — never query it directly.

Writes are debounced: `dbSetSetting()` and any transaction mutation call `scheduleDbSave()`, which coalesces into a single `saveDbToFile()` 1500 ms later; `beforeunload` flushes immediately so a quick edit-then-close doesn't get lost.

**Settings keys**, each with a `localStorage` fallback used only when no `.db` file is connected yet:

| DB key | localStorage fallback | Shape |
|---|---|---|
| `expense_cats` | `ausgaben_cats_v3` | `[{name, kw, color, budget}]` |
| `income_cats` | `inc_cats_v1` | `[{name, kw, color}]` |
| `cat_overrides` | `cat_overrides_v1` | `{ txKey: catName }` |
| `exclude_kw` | `ausgaben_exclude` | comma-separated string |
| `fonds` | `mittelfonds_v1` | `[{id, name, mode, budget, incomeKeys[], expenseKeys[]}]` |
| `zeitraum` | `zeitraum_filter` | `{from, to}` (YYYY-MM) |

`migrateLocalStorageToDb()` runs once per DB open/create and copies any of the six `localStorage` keys above into `settings` if not already present there — after that, the DB is authoritative and the `localStorage` copy is stale. **`trend_visible_cats`** (`trend_visible_cats_v1` in `localStorage`) is a seventh, *de facto* setting handled the same read/write way via `dbGetSetting`/`loadTrendVisibleCats()`, but it is **not** in `migrateLocalStorageToDb()`'s list — a user's chart-legend visibility picks (see Charts) saved before ever connecting a `.db` file won't be carried over automatically the way the other six are. Treat this as a known inconsistency, not a deliberate design choice, if you touch this area.

### Known dead code — read before "cleaning up"

- **`sqlite-store.js`** (in this same folder) is a complete, cleanly documented, standalone class (`SqliteStore`) that wraps sql.js + File System Access + IndexedDB into exactly the same responsibility this file implements inline (`init()`/`createFile()`/`openFile()`/`requestAccess()`/`save()`/`run()`/`query()`/`scalar()`). **It is not imported anywhere** — not by `haushaltsbuch.html`, not by any other tool. It looks like an extraction meant to be reused (by this tool and/or future ones) that was never wired back in. Don't assume it's live architecture; the actual persistence code is 100% inline in `haushaltsbuch.html`'s own `initDB()`/`createDbFile()`/`openDbFile()`/`requestFileAccess()`/`saveDbToFile()`/`loadAndOpenHandle()` plus its own `openIDB()`/`idbPut()`/`idbGet()`. If you ever do wire it in, remember to delete the duplicated inline copy rather than keeping both.
- **`filterInc()` is defined twice** — once as a one-line delegate to the shared `filterChips('inc', …)` helper (which `filterTx()` also uses), and again later as a full standalone reimplementation with its own inline filtering logic. JS function declarations in the same scope silently overwrite each other, so **the second, duplicated definition wins** and the first (shared-helper) one is dead. This is leftover from before `filterChips()` existed, not intentional — if you touch income-chip filtering, work on the surviving (second) definition, and consider deleting the dead first one in the same change.

### Data model

Categories (both expense and income) are **not** kept in a JS state object — they're read live out of the DOM (`#catGrid` / `#incCatGrid`, one `.cat-rule` row per category, both rendered by the shared `appendCatEl()`) via `getCats()` / `getIncCats()`, and written back with `saveCats()` / `saveIncCats()`, which just serialize whatever the DOM currently holds. **The last entry in each list is the catch-all fallback** (`categorize()`/`categorizeInc()` both fall back to `cats[cats.length - 1]` when nothing matches) — this is depended on throughout, so never assume a specific name like "Sonstiges" is guaranteed, only that *some* last entry exists. `moveCat()` handles ▲/▼ reordering of either grid.

`DEFAULT_CATS` (18 entries) / `DEFAULT_INC_CATS` (6 entries) are the seed data used when no categories exist yet. **These are the author's real household categories and real merchant keywords** (Rewe, Aldi, Amazon, Netflix, a few others), not a generic placeholder template — don't "simplify" or genericize them without checking with the user first. `COLORS` (10 hex values) / `INC_COLORS` (7 hex values) are plain arrays cycled by array index for category swatches; they're unrelated to any shared design-token system (see above).

In-memory transactions live in `allTx[]`, (re)loaded from the `transactions` table via `loadAllTxFromDb()` on every DB (re)open. Each in-memory tx object gets computed fields not stored in SQL: `monthKey`, `absAmt`, `isExpense`/`isIncome`, `desc` (`payee · purpose`), `dupSeq`, and a transient `cat` filled in by whichever code path classifies it (`runReport()`, `searchTx()`) — `cat` is never persisted, it's recomputed from keywords + overrides every time.

**Budget-Töpfe** ("Mittelherkunft-Tracker", section banner `// ── Budget-Töpfe (Topf-Tracking) ──`): a `Topf` (`{id, name, mode: 'income'|'manual', budget, incomeKeys[], expenseKeys[]}`) is a bucket of money a set of transactions get manually assigned into, independent of category. `mode: 'income'` pots compute their available budget from the income transactions assigned to them; `mode: 'manual'` pots just use a fixed `budget` number. Assignment keys transactions via `getTxKey(tx)` — a stable content hash (`date|amount|payee|purpose`, with `|dupSeq` appended **only when `dupSeq > 0`**, deliberately, so pot assignments made before the `dup_seq` column existed keep matching). Reached through the "Budget-Töpfe" button injected at the top of the report (`openFondsModal()` → `renderFondsModal()`), with its own search/filter (`filterFondsTx()`: `all`/`inc`/`exp`/`unassigned`) and per-pot + overview charts (`renderFondsCharts()`).

### Import & categorization

`handleFiles(files)` (bound to `#dropZone`'s drag-and-drop and click-to-browse) requires a connected DB file first. For each dropped file, `detectAndParse(text)` picks one of three bank-CSV formats, all funneled through the shared `parseTableFormat(lines, headerIdx, colMap, bank, isING)`:
1. **Volksbank/Sparkasse** — detected by a `Buchungstag` header; columns matched by fuzzy header name.
2. **ING** — detected by a `^"?Buchung"?;` line; ING's export has two "Betrag"-ish columns, so header matching searches **from the end** (the `isING` flag flips this in `parseTableFormat`) to find the right one.
3. **Generic fallback** — the first line (within the first 20) with more than 3 semicolons, matched against a broad list of common German/English header names.

`splitSemi()` is a hand-rolled, quote-aware semicolon CSV splitter; `toFloat()` sniffs German (`1.234,56`) vs. US (`1,234.56`) decimal format; `parseDate()` handles `DD.MM.YYYY` and `YYYY-MM-DD`. Within one imported file, rows that look identical (same date/amount/payee/purpose/bank) get an incrementing `dupSeq` from a per-file `Map`, so re-importing the exact same file is idempotent (`INSERT OR IGNORE` + the `UNIQUE` constraint dedupes them the same way each time) while two genuinely separate, identical-looking transactions on the same day both survive.

**Keyword matching is word-boundary-aware, not substring matching** — `keywordMatches(haystackLower, keyword)` builds a regex with a custom boundary class `[^a-z0-9äöüß]` (not JS's native `\b`, which is ASCII-only and would let German umlauts break a word boundary in the wrong place) so `"rewe"` matches "REWE Markt" but not "Brewery". `categorize()` / `categorizeInc()` walk each category's comma-separated keyword list, first match wins, falling back to the last category. A manual entry in `cat_overrides` (keyed by `getTxKey()`) always wins over any keyword match.

### Ambiguity modal — non-obvious control flow

`runReport()` (the largest function in the file, ~700 lines) starts with a **dry pre-pass**: for every in-range, non-excluded transaction it calls `getAllMatches(desc, catList)` (the same keyword logic as `categorize()`, but collecting *every* matching category instead of stopping at the first). Any transaction with more than one match — and no existing override, unless category keywords were just edited (tracked via `configChanged`, in which case even already-overridden transactions get re-checked) — goes into an `ambiguous[]` list. If that list is non-empty, `runReport()` calls `showAmbiguityModal(ambiguous, () => runReport())` **and returns early** — it does not render a report. The modal shows each ambiguous transaction with a radio-button chip per matching category; confirming writes each choice into `cat_overrides` and **re-invokes `runReport()`**, which this time finds no ambiguity and actually proceeds to render. Cancelling just closes the modal, leaving the report stale/unrendered. If you touch `runReport()`, keep this early-return-and-recurse shape in mind — it's easy to assume `runReport()` always renders when called.

A separate, lighter-weight, always-available path exists for single-transaction recategorization: clicking a category badge in any transaction table calls `showCatPopup()`, a small positioned popup that can (a) reassign just that transaction (writes `cat_overrides`, updates the DOM badge directly, no full report re-render) or (b) add a new keyword to a category directly from that transaction's payee/purpose, with a live match-count preview (`updateKwMatchPreview()`) before saving.

### Charts — Chart.js, not hand-rolled SVG

All charts are built with the CDN-loaded **Chart.js**, tracked in module-level `chartInstances{}` / `fondsChartInstances{}` maps and explicitly `.destroy()`-ed before `runReport()` rebuilds the report (the underlying `<canvas>` elements get thrown away and recreated each render). Types in use: horizontal bar (category totals), doughnut (`makePie()` factory — overall split, per-month, per-year), line (category trends, one dataset per category, clickable legend that toggles a dataset and persists the choice via `trend_visible_cats`), grouped vertical bar (monthly/yearly Ausgaben-vs-Einnahmen overview), and doughnut again for each Budget-Topf's spent/remaining ring plus a grouped bar comparing all pots. Chart chrome colors are picked once per render by checking `window.matchMedia('(prefers-color-scheme: dark)').matches` directly — charts aren't reactive to a live OS theme flip, they just get the right colors next time `runReport()` rebuilds them.

The only genuinely hand-rolled visuals in this file are plain CSS width-percentage `<div>` bars (`.bar-fill` inside `.bar-wrap`, used for category breakdown bars and Budget-Topf progress) — not SVG, and not charts.

### Search, Zeitraum, reports, cash entries

- **Global search** (`searchTx()`): substring match (min. 2 chars) over payee/purpose, respecting the active Zeitraum filter and exclusion keywords, with matched text highlighted via `hlRaw()`.
- **Zeitraum filter**: two `<input type=month>` fields, persisted as the `zeitraum` setting, bounded to the actual min/max months present in the data.
- **`runReport()`** (after the ambiguity pre-check above) categorizes/excludes every transaction, then builds one large HTML string: Gesamtübersicht (multi-month only), Kategorie-Trends (line chart + a table switchable between "Monat vs. Vorjahresmonat" and "Kumuliert bis Stichtag", including a per-category linear-regression trend rate labeled steigend/fallend/stabil), Einkommensquote, an overview chart, then a collapsible per-year block containing collapsible per-month blocks with their own transaction tables and category filter chips (`filterChips()`/`filterTx()`/`filterInc()`), and a CSV export button (`exportCSV()`, `;`-delimited with a UTF-8 BOM for Excel).
- **Cash entries ("Bar-Buchung")**: a form (`#cashFormBody`) for manually adding an expense or income row with `bank = 'Bar'`; `setCashType()` toggles the pill, `saveCashExpense()`/`editCashExpense()`/`deleteCashExpense()` give full CRUD through the same `transactions` table and the same `UNIQUE` constraint (shown as "Diese Buchung existiert bereits (Duplikat)" on conflict), so cash entries participate in categorization, search, and Fonds assignment exactly like imported rows. Amounts accept German decimal commas.

### Git

This folder has its own real git repository (3 commits: initial import, Budget-Töpfe, SQLite persistence) with `.gitignore` excluding `*.db` and `.DS_Store` — the live `haushaltsbuch.db` must never be committed, since it holds real financial data.
