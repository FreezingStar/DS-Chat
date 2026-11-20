/* Chat storage: IndexedDB first (large quota), localStorage as fallback.
   localStorage only keeps small settings, so imports no longer hit the 5MB cap. */
(function (global) {
  'use strict';

  var DB_NAME = 'ds-chat-store';
  var STORE = 'chats';
  var VERSION = 1;
  var LS = { isolated: 'ds.chats.isolated.v1', shared: 'ds.chats.shared.v1' };
  var LEGACY = 'ds.chats.v1';

  var dbPromise = null;
  var supported = (function () {
    try { return !!global.indexedDB; } catch (e) { return false; }
  })();

  function openDB() {
    if (!supported) return Promise.reject(new Error('IndexedDB unavailable'));
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        var req = global.indexedDB.open(DB_NAME, VERSION);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error || new Error('IndexedDB open failed')); };
        req.onblocked = function () { reject(new Error('IndexedDB blocked')); };
      });
    }
    return dbPromise;
  }

  function idbGet(key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).get(key);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function idbPut(key, value) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  function readLocal(mode) {
    try {
      var raw = global.localStorage.getItem(LS[mode]);
      if (!raw && mode === 'isolated') raw = global.localStorage.getItem(LEGACY);
      var parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  async function load(mode) {
    var data = null;
    try { data = await idbGet(mode); } catch (e) { data = null; }
    if (Array.isArray(data)) return data;

    var legacy = readLocal(mode);
    if (legacy) {
      try { await idbPut(mode, legacy); } catch (e) { /* keep it in localStorage */ }
      return legacy;
    }
    return [];
  }

  async function save(mode, chats) {
    try {
      await idbPut(mode, chats);
      return 'indexeddb';
    } catch (e) {
      // browsers with IndexedDB disabled still work, just with the smaller quota
      global.localStorage.setItem(LS[mode], JSON.stringify(chats));
      return 'localstorage';
    }
  }

  function saveSync(mode, chats) {
    global.localStorage.setItem(LS[mode], JSON.stringify(chats));
  }

  async function clear(mode) {
    try {
      await idbPut(mode, []);
    } catch (e) { /* noop */ }
    try { global.localStorage.removeItem(LS[mode]); } catch (e) { /* noop */ }
  }

  global.DSChatStore = {
    load: load,
    save: save,
    saveSync: saveSync,
    clear: clear,
    backend: function () { return supported ? 'IndexedDB' : 'localStorage'; }
  };
})(window);
