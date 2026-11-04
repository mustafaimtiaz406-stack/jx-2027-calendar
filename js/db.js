/* JX 2027 Calendar — IndexedDB layer
 *
 * Schema versioning rules (read before adding a migration):
 *  1. SCHEMA_VERSION only ever goes UP by one per release that changes storage.
 *  2. Add a new entry MIGRATIONS[n]; never edit or remove an entry that has shipped.
 *  3. Migrations must be additive: create stores/indexes, or transform records in place.
 *     Never call deleteObjectStore() or clear() on a store that may hold user data.
 *  4. If a migration needs to transform records, copy the originals into a backup store
 *     first (see backupStore() helper) inside the same upgrade transaction.
 *  5. All migrations run inside ONE versionchange transaction. If any step throws, the
 *     transaction is aborted and the browser rolls the database back to the previous
 *     version with all data intact. The app then reports UPGRADE_FAILED.
 */

export const DB_NAME = 'jx2027-calendar';
export const SCHEMA_VERSION = 1;

export const MIGRATIONS = Object.freeze({
  1(db) {
    const events = db.createObjectStore('events', { keyPath: 'id' });
    events.createIndex('by_start', 'start', { unique: false });
    events.createIndex('by_updated', 'updatedAt', { unique: false });

    const tasks = db.createObjectStore('tasks', { keyPath: 'id' });
    tasks.createIndex('by_due', 'due', { unique: false });
    tasks.createIndex('by_updated', 'updatedAt', { unique: false });

    db.createObjectStore('settings', { keyPath: 'key' });
    // Internal bookkeeping only (schema history, first-launch time). Not a product feature.
    db.createObjectStore('meta', { keyPath: 'key' });
  },
});

export class StorageError extends Error {
  /** @param {string} code  UNSUPPORTED | NEWER_VERSION | UPGRADE_FAILED | QUOTA | TIMEOUT | OPEN_FAILED | TX_FAILED */
  constructor(code, message, cause) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Copy every record of `storeName` into `${storeName}__backup_v${version}` within an upgrade,
 * then call `then()` — run any record transformation inside `then` so it starts only after
 * the full copy has been taken.
 */
export function backupStore(db, tx, storeName, version, then = () => {}) {
  const backupName = `${storeName}__backup_v${version}`;
  if (!db.objectStoreNames.contains(storeName)) { then(); return; }
  if (db.objectStoreNames.contains(backupName)) { then(); return; }
  const source = tx.objectStore(storeName);
  const backup = db.createObjectStore(backupName, { keyPath: source.keyPath });
  source.openCursor().onsuccess = (e) => {
    const cursor = e.target.result;
    if (cursor) { backup.put(cursor.value); cursor.continue(); }
    else then();
  };
}

function validateMigrations(migrations, version) {
  if (!Number.isInteger(version) || version < 1) {
    throw new StorageError('UPGRADE_FAILED', `Invalid schema version: ${version}`);
  }
  for (let v = 1; v <= version; v++) {
    if (typeof migrations[v] !== 'function') {
      throw new StorageError('UPGRADE_FAILED', `Missing migration for schema version ${v}`);
    }
  }
}

function classifyOpenError(err) {
  const name = err && err.name;
  if (name === 'VersionError') {
    return new StorageError('NEWER_VERSION',
      'Your saved data was created by a newer version of this app. It has not been changed.', err);
  }
  if (name === 'QuotaExceededError') {
    return new StorageError('QUOTA', 'This device has no storage space left for the app.', err);
  }
  if (name === 'AbortError') {
    return new StorageError('UPGRADE_FAILED',
      'A data update could not be completed. Your existing data was left unchanged.', err);
  }
  return new StorageError('OPEN_FAILED',
    'The browser would not open local storage. Private browsing or browser settings may be blocking it.', err);
}

/**
 * Open (and if needed, upgrade) the database.
 * @returns {Promise<{db: IDBDatabase, upgradedFrom: number|null}>}
 */
export function openDatabase({
  name = DB_NAME,
  version = SCHEMA_VERSION,
  migrations = MIGRATIONS,
  timeoutMs = 10000,
  onBlocked = () => {},
  onVersionChange = () => {},
} = {}) {
  return new Promise((resolve, reject) => {
    let idb;
    try {
      idb = globalThis.indexedDB;
    } catch (e) {
      // Some browsers throw on access when storage is disabled.
      reject(new StorageError('UNSUPPORTED', 'Local storage is not available in this browser.', e));
      return;
    }
    if (!idb) {
      reject(new StorageError('UNSUPPORTED', 'Local storage is not available in this browser.'));
      return;
    }

    try { validateMigrations(migrations, version); } catch (e) { reject(e); return; }

    let settled = false;
    let blocked = false;
    let upgradedFrom = null;
    let migrationError = null;

    const timer = setTimeout(() => {
      if (settled || blocked) return; // a blocked open has its own message and may still finish
      settled = true;
      reject(new StorageError('TIMEOUT', 'Local storage did not respond. Try reloading the app.'));
    }, timeoutMs);

    let request;
    try {
      request = idb.open(name, version);
    } catch (e) {
      clearTimeout(timer);
      reject(classifyOpenError(e));
      return;
    }

    request.onblocked = () => { blocked = true; onBlocked(); };

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction;
      const from = event.oldVersion;
      const to = event.newVersion;
      upgradedFrom = from;
      try {
        for (let v = from + 1; v <= to; v++) migrations[v](db, tx, { from, to });
        // Record schema history (meta store exists from v1 onward).
        if (db.objectStoreNames.contains('meta')) {
          const meta = tx.objectStore('meta');
          const req = meta.get('schema');
          req.onsuccess = () => {
            const prev = req.result || { key: 'schema', history: [] };
            const history = Array.isArray(prev.history) ? prev.history.slice(-19) : [];
            history.push({ from, to, at: new Date().toISOString() });
            meta.put({ key: 'schema', version: to, history });
          };
        }
      } catch (e) {
        migrationError = e;
        try { tx.abort(); } catch (_) { /* already aborting */ }
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      clearTimeout(timer);
      if (settled) { db.close(); return; }
      settled = true;
      db.onversionchange = () => { db.close(); onVersionChange(); };
      resolve({ db, upgradedFrom });
    };

    request.onerror = (event) => {
      clearTimeout(timer);
      if (event && event.preventDefault) event.preventDefault();
      if (settled) return;
      settled = true;
      const err = classifyOpenError(request.error);
      if (migrationError) {
        err.code = 'UPGRADE_FAILED';
        err.message = 'A data update could not be completed. Your existing data was left unchanged.';
        err.cause = migrationError;
      }
      reject(err);
    };
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(classifyTxError(tx.error));
    tx.onerror = () => { /* surfaced via onabort */ };
  });
}

function classifyTxError(err) {
  if (err && err.name === 'QuotaExceededError') {
    return new StorageError('QUOTA', 'This device has no storage space left for the app.', err);
  }
  return new StorageError('TX_FAILED', 'Saving to local storage failed.', err);
}

export async function get(db, store, key) {
  const tx = db.transaction(store, 'readonly');
  const req = tx.objectStore(store).get(key);
  await txDone(tx);
  return req.result;
}

export async function getAll(db, store) {
  const tx = db.transaction(store, 'readonly');
  const req = tx.objectStore(store).getAll();
  await txDone(tx);
  return req.result;
}

export async function count(db, store) {
  const tx = db.transaction(store, 'readonly');
  const req = tx.objectStore(store).count();
  await txDone(tx);
  return req.result;
}

/**
 * Consistent snapshot: read every record of several stores inside ONE read-only transaction.
 * Resolves (after the transaction completes) to { [store]: records[] }.
 */
export async function readStores(db, stores) {
  const tx = db.transaction(stores, 'readonly');
  const reqs = {};
  for (const s of stores) reqs[s] = tx.objectStore(s).getAll();
  await txDone(tx);
  const out = {};
  for (const s of stores) out[s] = reqs[s].result;
  return out;
}

/**
 * Atomic replace: inside ONE read-write transaction over all listed stores, clear each store and
 * put the given records. Any failure (thrown or asynchronous) aborts the transaction, and IndexedDB
 * rolls every store back to its previous contents. Resolves only after the commit.
 * Never touches stores that are not listed, the database version, or object-store definitions.
 */
export async function replaceStores(db, recordsByStore) {
  const stores = Object.keys(recordsByStore);
  const tx = db.transaction(stores, 'readwrite');
  const done = txDone(tx);
  try {
    for (const s of stores) {
      const os = tx.objectStore(s);
      os.clear();
      for (const rec of recordsByStore[s]) os.put(rec);
    }
  } catch (err) {
    try { tx.abort(); } catch (_) { /* already aborting */ }
    await done.catch(() => {});
    throw new StorageError('TX_FAILED', 'Saving to local storage failed.', err);
  }
  await done;
}

/** Delete one record by key. Resolves only after the transaction commits. */
export async function remove(db, store, key) {
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await txDone(tx);
}

/** Resolves only after the transaction commits. */
export async function put(db, store, value) {
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await txDone(tx);
  return value;
}
