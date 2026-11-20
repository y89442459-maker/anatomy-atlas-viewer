/* 个人数据统一存储层 v2（2026-11-02）
 *
 * 一个键管四类信息，以病例/条目 id 为关联键：
 *   atlas_person_v2 = {
 *     version: 2,
 *     rev: 0,
 *     migratedAt: 时间戳,
 *     items: { "<id>": { starred, lastViewedAt, note, indexEntry } }
 *   }
 *
 * 旧键只读迁移（保留不删）：
 *   atlas_marks_v1         { id: { fav, note, updatedAt } }
 *   atlas_recent_v1        [{ id, at }]
 *   atlas_personal_cases_v1 { version, rev, items: [...] }
 *
 * 所有写入必须走 PersonStore，避免多处各写各的键。
 */
(function (global) {
  'use strict';

  var KEY = 'atlas_person_v2';
  var MARKS_KEY = 'atlas_marks_v1';
  var RECENT_KEY = 'atlas_recent_v1';
  var INDEX_KEY = 'atlas_personal_cases_v1';
  var MAX_RECENT = 50;
  var MAX_CHARS = 4.5 * 1024 * 1024;   // 接近 localStorage 5MB 配额时拒绝写入
  var BAD_IDS = { '__proto__': 1, 'constructor': 1, 'prototype': 1 };

  var readonly = false;       // atlas_person_v2 损坏时停止写入，避免覆盖原数据
  var persistError = false;   // 迁移/写入落盘失败
  var migrationErrors = [];   // 部分旧键损坏，未能迁移的键名

  function emptyStore() {
    // 用无原型对象，避免 id="constructor" 之类命中继承属性
    return { version: 2, rev: 0, migratedAt: 0, items: Object.create(null) };
  }

  function emptyItem() {
    return { starred: false, lastViewedAt: 0, note: '', indexEntry: null };
  }

  function isSafeId(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= 200 && !BAD_IDS[id];
  }

  function readRaw(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  /* 解析结果：null = 没有这个键；undefined = JSON 损坏 */
  function parse(key) {
    var raw = readRaw(key);
    if (raw === null) return null;
    try { return JSON.parse(raw); } catch (e) { return undefined; }
  }

  function sanitizeItem(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    return {
      starred: !!v.starred,
      lastViewedAt: Number.isFinite(v.lastViewedAt) ? v.lastViewedAt : 0,
      note: typeof v.note === 'string' ? v.note : '',
      indexEntry: (v.indexEntry && typeof v.indexEntry === 'object' && !Array.isArray(v.indexEntry))
        ? v.indexEntry : null
    };
  }

  function normalize(store) {
    var out = emptyStore();
    if (!store || typeof store !== 'object') return out;
    out.rev = Number.isInteger(store.rev) ? store.rev : 0;
    out.migratedAt = Number.isFinite(store.migratedAt) ? store.migratedAt : 0;
    var src = store.items;
    if (!src || typeof src !== 'object' || Array.isArray(src)) return out;
    Object.keys(src).forEach(function (id) {
      if (!isSafeId(id)) return;
      var it = sanitizeItem(src[id]);
      if (!it) return;
      // 四类信息全空就不留记录
      if (!it.starred && !it.lastViewedAt && !it.note && !it.indexEntry) return;
      out.items[id] = it;
    });
    return out;
  }

  function ensureItem(store, id) {
    if (!isSafeId(id)) return null;
    if (!Object.prototype.hasOwnProperty.call(store.items, id)) store.items[id] = emptyItem();
    return store.items[id];
  }

  function dropIfEmpty(store, id) {
    var it = store.items[id];
    if (it && !it.starred && !it.lastViewedAt && !it.note && !it.indexEntry) delete store.items[id];
  }

  /* 把三个旧键合并进新结构。任一旧键损坏时不写 migratedAt，下次刷新会重试；
     旧键本身始终原样保留。 */
  function migrate(store) {
    var errors = [];
    if (store.migratedAt) return errors;
    var changed = false;

    var marks = parse(MARKS_KEY);
    if (marks === undefined) {
      errors.push(MARKS_KEY);
    } else if (marks && typeof marks === 'object' && !Array.isArray(marks)) {
      Object.keys(marks).forEach(function (id) {
        var v = marks[id];
        if (!v || typeof v !== 'object' || !isSafeId(id)) return;
        var it = ensureItem(store, id);
        if (!it) return;
        if (v.fav) it.starred = true;
        if (typeof v.note === 'string' && v.note) it.note = v.note;
        if (Number.isFinite(v.updatedAt)) it.lastViewedAt = Math.max(it.lastViewedAt, v.updatedAt);
        changed = true;
      });
    }

    var recent = parse(RECENT_KEY);
    if (recent === undefined) {
      errors.push(RECENT_KEY);
    } else if (Array.isArray(recent)) {
      recent.forEach(function (r) {
        if (!r || !isSafeId(r.id)) return;
        var it = ensureItem(store, r.id);
        if (!it) return;
        if (Number.isFinite(r.at)) it.lastViewedAt = Math.max(it.lastViewedAt, r.at);
        changed = true;
      });
    }

    var idx = parse(INDEX_KEY);
    var entries = [];
    if (idx === undefined) {
      errors.push(INDEX_KEY);
    } else if (Array.isArray(idx)) {
      entries = idx;
    } else if (idx && typeof idx === 'object' && Array.isArray(idx.items)) {
      entries = idx.items;
    }
    entries.forEach(function (e) {
      if (!e || typeof e !== 'object' || !isSafeId(e.id)) return;
      var it = ensureItem(store, e.id);
      if (!it) return;
      it.indexEntry = e;
      changed = true;
    });

    if (errors.length) return errors;   // 有坏键：不标记完成，下次重试
    // 没有旧键也算「已检查」，避免每次 load 都重扫
    store.migratedAt = Date.now();
    if (changed) store.rev = (store.rev || 0) + 1;
    return [];
  }

  function write(store) {
    if (readonly) return false;
    var text;
    try { text = JSON.stringify(store); } catch (e) { return false; }
    if (text.length > MAX_CHARS) { persistError = true; return false; }
    try {
      localStorage.setItem(KEY, text);
      return true;
    } catch (e) {
      persistError = true;
      return false;
    }
  }

  /* 读取：首次会迁移旧键并落盘；损坏时进入只读保护 */
  function load() {
    var raw = readRaw(KEY);
    if (raw === null) {
      var base = emptyStore();
      migrationErrors = migrate(base);
      if (!migrationErrors.length) {
        persistError = false;
        if (!write(base)) persistError = true;
      }
      return base;
    }
    var parsed = parse(KEY);
    if (parsed === undefined) {
      readonly = true;
      return emptyStore();
    }
    // 新键已可解析：其他标签修复后，本页也应退出只读
    readonly = false;
    var store = normalize(parsed);
    if (!store.migratedAt) {
      migrationErrors = migrate(store);
      if (!migrationErrors.length) {
        persistError = false;
        if (!write(store)) persistError = true;
      }
    } else {
      migrationErrors = [];
    }
    return store;
  }

  /* 读-改-写：Web Locks 串行；无 Web Locks 时用 rev 做 CAS 重试（最多 3 次） */
  function update(mutate) {
    function run() {
      var cur = load();
      if (readonly) return null;
      var next = normalize(cur);
      var res = mutate(next);
      if (res === false) return null;
      next = res || next;
      next.rev = (cur.rev || 0) + 1;
      if (!write(next)) return null;
      persistError = false;
      return next;
    }

    if (global.navigator && navigator.locks && navigator.locks.request) {
      return navigator.locks.request(KEY, { mode: 'exclusive' }, run);
    }

    return Promise.resolve().then(function () {
      for (var i = 0; i < 3; i++) {
        var cur = load();
        if (readonly) return null;
        var next = normalize(cur);
        var res = mutate(next);
        if (res === false) return null;
        next = res || next;
        // 写前再读一次，rev 变了说明别的标签刚写过，重试
        var latest = load();
        if (latest.rev !== cur.rev) continue;
        next.rev = (cur.rev || 0) + 1;
        if (!write(next)) return null;
        persistError = false;
        return next;
      }
      return null;
    });
  }

  /* ---------- 对外 API ---------- */

  function toggleFav(id) {
    return update(function (store) {
      var it = ensureItem(store, id);
      if (!it) return false;
      it.starred = !it.starred;
      dropIfEmpty(store, id);
    });
  }

  function setNote(id, text) {
    var value = String(text == null ? '' : text).trim();
    return update(function (store) {
      var it = ensureItem(store, id);
      if (!it) return false;
      it.note = value;
      dropIfEmpty(store, id);
    });
  }

  function touchRecent(id) {
    return update(function (store) {
      var it = ensureItem(store, id);
      if (!it) return false;
      it.lastViewedAt = Date.now();
      // 最近最多 50 条：按 lastViewedAt 倒序，超出部分只清时间，不动收藏/笔记/索引
      var withRecent = Object.keys(store.items)
        .filter(function (k) { return store.items[k].lastViewedAt > 0; })
        .sort(function (a, b) { return store.items[b].lastViewedAt - store.items[a].lastViewedAt; });
      withRecent.slice(MAX_RECENT).forEach(function (k) {
        store.items[k].lastViewedAt = 0;
        dropIfEmpty(store, k);
      });
    });
  }

  function clearRecent() {
    return update(function (store) {
      Object.keys(store.items).forEach(function (k) {
        store.items[k].lastViewedAt = 0;
        dropIfEmpty(store, k);
      });
    });
  }

  function upsertIndex(entry) {
    if (!entry || !isSafeId(entry.id)) return Promise.resolve(null);
    return update(function (store) {
      var it = ensureItem(store, entry.id);
      if (!it) return false;
      it.indexEntry = entry;
    });
  }

  function deleteIndex(id) {
    return update(function (store) {
      var it = store.items[id];
      if (!it) return;
      it.indexEntry = null;
      dropIfEmpty(store, id);
    });
  }

  /* 索引列表整体替换：一次读改写内完成 upsert + 删除，避免多次提交只成功一半 */
  function replaceIndex(entries) {
    var list = Array.isArray(entries)
      ? entries.filter(function (e) { return e && isSafeId(e.id); })
      : [];
    return update(function (store) {
      var keep = Object.create(null);
      list.forEach(function (e) { keep[e.id] = true; });
      Object.keys(store.items).forEach(function (id) {
        if (store.items[id].indexEntry && !keep[id]) {
          store.items[id].indexEntry = null;
          dropIfEmpty(store, id);
        }
      });
      list.forEach(function (e) {
        var it = ensureItem(store, e.id);
        if (it) it.indexEntry = e;
      });
    });
  }

  function importIndex(entries) {
    if (!Array.isArray(entries) || !entries.length) return Promise.resolve(null);
    return update(function (store) {
      entries.forEach(function (e) {
        if (!e || !isSafeId(e.id)) return;
        var it = ensureItem(store, e.id);
        if (it) it.indexEntry = e;
      });
    });
  }

  /* 合并完整备份（person 字段）：收藏取并集、最近取较新、笔记以备份为准 */
  function merge(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || !snapshot.items) {
      return Promise.resolve(null);
    }
    return update(function (store) {
      Object.keys(snapshot.items).forEach(function (id) {
        var src = sanitizeItem(snapshot.items[id]);
        if (!src || !isSafeId(id)) return;
        var it = ensureItem(store, id);
        if (!it) return;
        if (src.starred) it.starred = true;
        if (src.lastViewedAt) it.lastViewedAt = Math.max(it.lastViewedAt, src.lastViewedAt);
        if (src.note) it.note = src.note;
        if (src.indexEntry) it.indexEntry = src.indexEntry;
      });
    });
  }

  /* 完整导入：一次 update 内合并收藏/最近/笔记，并按 id upsert 索引。
     只改传入的记录，不动其他已有索引；maxRecords 在事务内检查。
     snapshot 可以是 null（旧备份没有 person 字段）。原子写入，失败不留半份数据。 */
  function importSnapshot(snapshot, entries, maxRecords) {
    var list = Array.isArray(entries)
      ? entries.filter(function (e) { return e && isSafeId(e.id); })
      : [];
    var limit = Number.isInteger(maxRecords) && maxRecords > 0 ? maxRecords : 2000;
    return update(function (store) {
      if (snapshot && typeof snapshot === 'object' && snapshot.items &&
          typeof snapshot.items === 'object' && !Array.isArray(snapshot.items)) {
        Object.keys(snapshot.items).forEach(function (id) {
          var src = sanitizeItem(snapshot.items[id]);
          if (!src || !isSafeId(id)) return;
          var it = ensureItem(store, id);
          if (!it) return;
          if (src.starred) it.starred = true;
          if (src.lastViewedAt) it.lastViewedAt = Math.max(it.lastViewedAt, src.lastViewedAt);
          if (src.note) it.note = src.note;
        });
      }
      list.forEach(function (e) {
        var it = ensureItem(store, e.id);
        if (it) it.indexEntry = e;
      });
      // 事务内数一遍索引条目，防止并发写入越过上限
      var count = 0;
      Object.keys(store.items).forEach(function (id) {
        if (store.items[id].indexEntry) count++;
      });
      if (count > limit) return false;
    });
  }

  function isReadonly() { return readonly; }
  function hasPersistError() { return persistError; }
  function getMigrationErrors() { return migrationErrors.slice(); }

  /* 损坏恢复：用户明确要求清空时，用空 store 覆盖并退出只读 */
  function reset() {
    var store = emptyStore();
    store.migratedAt = Date.now();
    store.rev = 1;
    try {
      localStorage.setItem(KEY, JSON.stringify(store));
      readonly = false;
      persistError = false;
      migrationErrors = [];
      return true;
    } catch (e) {
      return false;
    }
  }

  global.PersonStore = {
    KEY: KEY,
    load: load,
    update: update,
    toggleFav: toggleFav,
    setNote: setNote,
    touchRecent: touchRecent,
    clearRecent: clearRecent,
    upsertIndex: upsertIndex,
    deleteIndex: deleteIndex,
    replaceIndex: replaceIndex,
    importIndex: importIndex,
    merge: merge,
    importSnapshot: importSnapshot,
    isReadonly: isReadonly,
    hasPersistError: hasPersistError,
    getMigrationErrors: getMigrationErrors,
    reset: reset
  };
})(window);

/* App 内访问埋点加载器（2026-11-12）：
 * 病例详情页（/legacy/<case>/index.html，185 份，来自数据包）只引用本文件，
 * 在这里按 person-store.js 的真实地址推导 static/visit-app.js 并加载。
 * 网页端不会注入；App 内 visit-app.js 自己带防重复标记。 */
(function () {
  try {
    if (!(location.port === '18080' || window.AtlasBridge)) return;
    if (window.__atlasVisitApp || document.querySelector('script[data-atlas-visit-app]')) return;
    var cur = document.currentScript;
    var url = cur && cur.src ? new URL('visit-app.js', cur.src).href : '/static/visit-app.js';
    var s = document.createElement('script');
    s.src = url;
    s.defer = true;
    s.setAttribute('data-atlas-visit-app', '');
    (document.head || document.documentElement).appendChild(s);
  } catch (e) { /* 静默失败 */ }
})();
