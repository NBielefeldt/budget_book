# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

`haushaltsbuch.html` is a single-file, zero-dependency (except a CDN Chart.js) German household-budget analyzer. It runs entirely in the browser — no server, no build step, no npm. Open the file directly in a browser to use it.

## Running / testing

Open `haushaltsbuch.html` directly in any modern browser. There is no build, no dev server, and no test suite.

## Architecture

Everything lives in one HTML file: CSS variables with dark-mode support, inline JavaScript, and a `<script src>` for Chart.js 4.4.1 from cdnjs.

**Data flow:**
1. User drops/selects CSV files → `handleFiles()` reads each with `FileReader`
2. `detectAndParse()` identifies the bank format (Volksbank/Sparkasse by `Buchungstag` header, ING by `Buchung;` prefix, generic fallback) and delegates to `parseTableFormat()`
3. `parseTableFormat()` maps columns by name (with fuzzy matching), returns `rows[]`
4. `toFloat()` handles German decimal format (`1.234,56`) and `parseDate()` handles `DD.MM.YYYY` and `YYYY-MM-DD`
5. `runReport()` classifies each transaction via `categorize()` / `categorizeInc()` (first-keyword-match wins, last category is fallback), then builds a large HTML string for the report and calls Chart.js after a 60ms `setTimeout`

**State:**
- `allTx[]` — global array of parsed transactions (accumulated across all loaded files)
- `chartInstances{}` — Chart.js instances, destroyed and recreated on each `runReport()` call
- `localStorage` keys: `ausgaben_cats_v2` (expense categories), `inc_cats_v1` (income categories), `ausgaben_exclude` (exclusion keywords)

**Category grids:**
- Expense categories rendered into `#catGrid`, read back by `getCats()`
- Income categories rendered into `#incCatGrid`, read back by `getIncCats()`
- Both grids share `appendCatEl()` for rendering individual category rows
- Last category in each list acts as the catch-all fallback

**Known issue:** `filterInc()` is defined twice — the second definition (lines ~768–797) shadows the first generic wrapper. The second definition handles income chip filtering directly instead of going through `filterChips()`.

**Security:** `esc()` HTML-escapes all user/CSV data before inserting into the report string. CSV data never leaves the browser.
