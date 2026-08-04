/**
 * sqlite-store.js — Wiederverwendbarer, server-loser SQLite-Speicher für Browser-Tools.
 *
 * Kombiniert drei Browser-Mechanismen:
 *   1. sql.js (SQLite via WebAssembly) — echte SQL-Datenbank, läuft im RAM des Tabs.
 *   2. File System Access API — schreibt die DB als echte .db-Datei auf die Platte.
 *   3. IndexedDB — merkt sich nur den FileSystemFileHandle, damit dieselbe Datei
 *      beim nächsten Start automatisch wiedergeöffnet werden kann.
 *
 * Kein Server, keine Build-Tools. Funktioniert nur in Chromium-Browsern
 * (Chrome/Edge), da die File System Access API anderswo fehlt.
 *
 * Einbindung:
 *   <script src="https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.js"></script>
 *   <script type="module">
 *     import { SqliteStore } from './sqlite-store.js';
 *     const store = new SqliteStore({
 *       schema: `CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT)`,
 *       dbName: 'meinetool',          // IndexedDB-Name (pro Tool eindeutig)
 *       suggestedFileName: 'meinetool.db',
 *     });
 *     await store.init();             // versucht, zuletzt genutzte Datei zu reöffnen
 *     if (!store.isReady) await store.createFile();   // oder store.openFile()
 *     store.run('INSERT INTO items (name) VALUES (?)', ['Hallo']);
 *     await store.save();             // zurück in die Datei schreiben
 *   </script>
 */

export class SqliteStore {
  /**
   * @param {object} opts
   * @param {string} opts.schema             - CREATE TABLE ... Statement(s), idempotent (IF NOT EXISTS).
   * @param {string} [opts.dbName]           - IndexedDB-Name, pro Tool eindeutig. Default 'sqlite-store'.
   * @param {string} [opts.suggestedFileName]- Vorgeschlagener Dateiname beim Speichern.
   * @param {string} [opts.fileExtension]    - Dateiendung. Default '.db'.
   * @param {string} [opts.sqlJsCdn]         - Basis-URL für die sql.js-WASM-Datei.
   * @param {() => void} [opts.onStatusChange]- Callback nach jeder Zustandsänderung (für UI-Update).
   */
  constructor(opts = {}) {
    if (!opts.schema) throw new Error('SqliteStore: opts.schema ist erforderlich.');
    this.schema = opts.schema;
    this.dbName = opts.dbName || 'sqlite-store';
    this.suggestedFileName = opts.suggestedFileName || 'data.db';
    this.fileExtension = opts.fileExtension || '.db';
    this.sqlJsCdn = opts.sqlJsCdn || 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/';
    this.onStatusChange = opts.onStatusChange || (() => {});

    this._SQL = null;        // sql.js Modul
    this.db = null;          // sql.js Database (im RAM) — direkter Zugriff erlaubt
    this.fileHandle = null;  // FileSystemFileHandle der .db-Datei

    this._fileTypes = [{
      description: 'SQLite-Datenbank',
      accept: { 'application/x-sqlite3': [this.fileExtension] },
    }];
  }

  // ── Statusabfragen ───────────────────────────────────────
  /** true, wenn DB im Speicher offen und beschreibbar ist. */
  get isReady() { return !!this.db && !!this.fileHandle; }
  /** true, wenn eine Datei bekannt ist, aber (noch) der Zugriff fehlt. */
  get needsPermission() { return !!this.fileHandle && !this.db; }
  /** Name der aktuellen Datei oder null. */
  get fileName() { return this.fileHandle?.name ?? null; }

  static get isSupported() { return 'showSaveFilePicker' in window; }

  // ── Lebenszyklus ─────────────────────────────────────────
  /** Lädt sql.js und versucht, die zuletzt genutzte Datei automatisch zu öffnen. */
  async init() {
    this._SQL = await initSqlJs({ locateFile: f => this.sqlJsCdn + f });
    const handle = await this._idbGet('fileHandle');
    if (handle) {
      this.fileHandle = handle;
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') await this._loadFromHandle(handle);
    }
    this.onStatusChange();
    return this;
  }

  /** Öffnet den Dateidialog zum Anlegen einer neuen, leeren .db-Datei. */
  async createFile() {
    this._assertSupported();
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: this.suggestedFileName,
        types: this._fileTypes,
      });
      this.fileHandle = handle;
      await this._idbPut('fileHandle', handle);
      this.db = new this._SQL.Database();
      this.db.run(this.schema);
      await this.save();
      this.onStatusChange();
      return true;
    } catch (e) {
      if (e.name !== 'AbortError') console.error(e);
      return false;
    }
  }

  /** Öffnet eine bestehende .db-Datei. */
  async openFile() {
    this._assertSupported();
    try {
      const [handle] = await window.showOpenFilePicker({ types: this._fileTypes });
      this.fileHandle = handle;
      await this._idbPut('fileHandle', handle);
      await this._loadFromHandle(handle);
      this.onStatusChange();
      return true;
    } catch (e) {
      if (e.name !== 'AbortError') console.error(e);
      return false;
    }
  }

  /**
   * Fordert erneut Schreibzugriff auf die bekannte Datei an (Browser vergessen
   * die Erlaubnis teils zwischen Sitzungen). Muss aus einem Klick-Handler kommen.
   */
  async requestAccess() {
    if (!this.fileHandle) return false;
    try {
      const perm = await this.fileHandle.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        await this._loadFromHandle(this.fileHandle);
        this.onStatusChange();
        return true;
      }
    } catch (e) { console.error(e); }
    return false;
  }

  /** Schreibt den aktuellen DB-Zustand zurück in die Datei. Nach jedem run() aufrufen. */
  async save() {
    if (!this.db || !this.fileHandle) return;
    const writable = await this.fileHandle.createWritable();
    await writable.write(this.db.export());
    await writable.close();
  }

  // ── SQL-Helfer (dünne Wrapper um sql.js) ────────────────
  /** Führt ein Statement aus (INSERT/UPDATE/DELETE/CREATE). Vergiss save() nicht. */
  run(sql, params = []) {
    if (!this.db) throw new Error('SqliteStore: keine offene Datenbank.');
    this.db.run(sql, params);
    return this.db.getRowsModified();
  }

  /** SELECT → Array von Objekten [{col: val, ...}, ...]. */
  query(sql, params = []) {
    if (!this.db) return [];
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const out = [];
    while (stmt.step()) out.push(stmt.getAsObject());
    stmt.free();
    return out;
  }

  /** Erste Spalte der ersten Zeile (z. B. COUNT(*)). */
  scalar(sql, params = []) {
    const rows = this.query(sql, params);
    if (!rows.length) return null;
    return Object.values(rows[0])[0];
  }

  // ── Intern ───────────────────────────────────────────────
  _assertSupported() {
    if (!SqliteStore.isSupported) {
      alert('Ihr Browser unterstützt die Dateizugriff-API nicht.\nBitte Chrome oder Edge verwenden.');
      throw new Error('File System Access API nicht verfügbar.');
    }
  }

  async _loadFromHandle(handle) {
    const file = await handle.getFile();
    const buf = new Uint8Array(await file.arrayBuffer());
    this.db = buf.byteLength > 0 ? new this._SQL.Database(buf) : new this._SQL.Database();
    this.db.run(this.schema); // sicherstellen, dass Tabellen existieren
  }

  _openIDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = e => reject(e.target.error);
    });
  }

  async _idbPut(key, val) {
    const idb = await this._openIDB();
    return new Promise((resolve, reject) => {
      const tx = idb.transaction('meta', 'readwrite');
      tx.objectStore('meta').put(val, key);
      tx.oncomplete = resolve;
      tx.onerror = e => reject(e.target.error);
    });
  }

  async _idbGet(key) {
    try {
      const idb = await this._openIDB();
      return new Promise(resolve => {
        const tx = idb.transaction('meta', 'readonly');
        const req = tx.objectStore('meta').get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => resolve(null);
      });
    } catch { return null; }
  }
}
