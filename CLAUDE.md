# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

`haushaltsbuch.html` is a single-file German household-budget analyzer. It runs entirely in the browser — no server, no build step, no npm. Open the file directly in a browser to use it.

External dependencies (CDN):
- Chart.js 4.4.1
- sql.js 1.10.3 (SQLite compiled to WebAssembly)

## Running / testing

Open `haushaltsbuch.html` directly in any modern browser (Chrome/Edge required for File System Access API). There is no build, no dev server, and no test suite.

## Architecture

Everything lives in one HTML file: CSS variables with dark-mode support and inline JavaScript.

**Data flow:**
1. User drops/selects CSV files → `handleFiles()` reads each with `FileReader`
2. `detectAndParse()` identifies the bank format (Volksbank/Sparkasse by `Buchungstag` header, ING by `Buchung;` prefix, generic fallback) and delegates to `parseTableFormat()`
3. `parseTableFormat()` maps columns by name (with fuzzy matching), returns `rows[]`
4. `toFloat()` handles German decimal format (`1.234,56`) and `parseDate()` handles `DD.MM.YYYY` and `YYYY-MM-DD`
5. Rows are inserted into a SQLite DB via sql.js and persisted to a user-chosen `.db` file via the File System Access API
6. `runReport()` classifies each transaction via `categorize()` / `categorizeInc()` (first-keyword-match wins, last category is fallback), then builds a large HTML string for the report and calls Chart.js after a 60ms `setTimeout`

**State:**
- `allTx[]` — global array of parsed transactions (loaded from SQLite on DB open)
- `chartInstances{}` — Chart.js instances, destroyed and recreated on each `runReport()` call
- `pendingCatChanges` — counter of in-place badge reassignments since last `runReport()`
- `configChanged` — boolean, set when category keywords/exclusions are edited since last `runReport()`

**Persistence — SQLite DB (primary):**
All user data is stored in a single SQLite file chosen by the user via the File System Access API. The file handle is remembered across sessions via IndexedDB (`haushaltsbuch` / `meta` store, key `fileHandle`).

Tables:
- `transactions` — raw imported data (date_iso, amount, payee, purpose, bank); UNIQUE constraint prevents duplicates
- `settings` — key/value store for all configuration (JSON-encoded values)

Settings keys:
| Key | Content |
|---|---|
| `expense_cats` | Expense category definitions (name, kw, color, budget) |
| `income_cats` | Income category definitions (name, kw, color) |
| `cat_overrides` | Manual transaction→category overrides (txKey → catName) |
| `exclude_kw` | Exclusion keywords string |
| `fonds` | Budget-Töpfe definitions |
| `zeitraum` | Date range filter {from, to} |

**Persistence — localStorage (fallback only):**
Used when no DB is connected. Keys: `ausgaben_cats_v3`, `inc_cats_v1`, `cat_overrides_v1`, `ausgaben_exclude`, `mittelfonds_v1`, `zeitraum_filter`.

**Migration:** `migrateLocalStorageToDb()` runs on every DB open/create. It copies any localStorage keys not yet present in the `settings` table into the DB (per-key, idempotent). After migration, DB is authoritative.

**DB save debouncing:** `dbSetSetting()` calls `scheduleDbSave()` which debounces `saveDbToFile()` by 1500ms. `beforeunload` flushes any pending save immediately.

**Category grids:**
- Expense categories rendered into `#catGrid`, read back by `getCats()`
- Income categories rendered into `#incCatGrid`, read back by `getIncCats()`
- Both grids share `appendCatEl()` for rendering individual category rows
- Last category in each list acts as the catch-all fallback
- Row order is changeable via ▲▼ buttons (`moveCat()`)

**Pending-changes banner:**
A fixed bottom banner appears when the report is stale:
- `pendingCatChanges > 0`: user reassigned transaction categories in-place (badge clicks) without re-running the report
- `configChanged = true`: user edited category keywords, names, or exclusion keywords
- Both flags are reset by `hidePendingBanner()` at the start of `runReport()`
- `saveCats()`, `saveIncCats()`, `saveExclude()` set `configChanged = true`; `runReport()` resets it before and after the internal save calls to prevent reflexive re-triggering

**In-place category reassignment:**
Clicking a category badge opens `showCatPopup()`. The popup has two sections:
1. Category list — click to reassign this transaction (override stored in `cat_overrides`); badge is updated in DOM without re-running the full report
2. Keyword section — text field pre-filled with first word of payee, category dropdown, "Hinzufügen" button; calls `addKeywordToCat()` which appends the keyword to the category's `kw` field in the DOM grid and saves

**Known issue:** `filterInc()` is defined twice — the second definition shadows the first generic wrapper. The second definition handles income chip filtering directly instead of going through `filterChips()`.

**Security:** `esc()` HTML-escapes all user/CSV data before inserting into the report string. CSV data never leaves the browser.
