// 应用的数据中心：当前所有记录、对记录的修改、和存储端的同步、缩略图的读取。
//
// 数据结构（保存成 birdlog.json）：
//   photos[id]    一张照片：文件信息、拍摄时间 t、地点 loc、鸟种 sp、相机参数…
//   locations[id] 一个地点：名称、经纬度
//   records[key]  一条记录的数量和备注；key = 日期|地点|鸟种，同一天同一地点同一种鸟的照片属于同一条记录
// 每一项都带修改时间 m。两台设备各自改过之后合并时，同一项取修改时间较新的那份；
// 删除的项留一个带 del 标记的「墓碑」，这样删除也能同步到另一台设备。

import { idbGet, idbSet, idbDel, idbClear } from './cache.js';
import { uid, dateOf, push, debounce, limiter } from './util.js';
import { groupCode } from './taxonomy.js';

export const S = {
  phase: 'boot',          // boot 启动中 | welcome 选择存储方式 | ready 可以用了
  backend: null,
  user: null,
  db: emptyDb(),
  dbv: 0,                 // 数据每变一次加一，界面据此刷新
  rev: null,              // 上次同步时存储端记录文件的版本
  dirty: false,           // 本地有还没上传的修改
  sync: { state: 'idle', error: '', at: 0 }, // idle | syncing | offline | error
  needAuth: false,
  taxonomy: false,
  viewer: null,           // { ids, i }
  dialogs: [],
  toasts: [],
};

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
let notifyQueued = false;
export function notify() {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    for (const fn of [...listeners]) fn();
  });
}

export function emptyDb() {
  return { v: 1, photos: {}, locations: {}, records: {} };
}

function normalizeDb(d) {
  const db = emptyDb();
  if (d && typeof d === 'object') {
    for (const k of ['photos', 'locations', 'records']) if (d[k] && typeof d[k] === 'object') db[k] = d[k];
  }
  return db;
}

const TOMBSTONE_KEEP_MS = 180 * 24 * 3600 * 1000;

/** 写出去之前清掉太旧的删除标记 */
function serializeDb(db) {
  const cutoff = Date.now() - TOMBSTONE_KEEP_MS;
  const clean = (coll) => {
    const out = {};
    for (const [k, v] of Object.entries(coll)) if (!(v.del && (v.m || 0) < cutoff)) out[k] = v;
    return out;
  };
  return { v: 1, app: 'BirdLog', savedAt: new Date().toISOString(), photos: clean(db.photos), locations: clean(db.locations), records: clean(db.records) };
}

/** 合并本地和存储端的两份数据。返回合并结果，以及本地是否有比存储端新的内容。 */
export function mergeDb(local, remote) {
  let localNewer = false;
  const mergeColl = (a = {}, b = {}) => {
    const out = { ...b };
    for (const [k, v] of Object.entries(a)) {
      const r = b[k];
      if (!r || (v.m || 0) > (r.m || 0)) { out[k] = v; localNewer = true; }
    }
    return out;
  };
  const db = {
    v: 1,
    photos: mergeColl(local.photos, remote.photos),
    locations: mergeColl(local.locations, remote.locations),
    records: mergeColl(local.records, remote.records),
  };
  return { db, localNewer };
}

// ---------- 派生数据（按日期 / 地点 / 鸟种分好组），数据不变就不重算 ----------

let idx = null;
let idxV = -1;

export const recKey = (p) => `${dateOf(p.t)}|${p.loc || ''}|${p.sp || ''}`;

export function index() {
  if (idx && idxV === S.dbv) return idx;
  const photos = Object.values(S.db.photos).filter((p) => !p.del);
  photos.sort((a, b) => (b.t || '').localeCompare(a.t || '') || (b.added || 0) - (a.added || 0) || (a.id < b.id ? -1 : 1));
  const byDate = new Map(), byLoc = new Map(), byGroup = new Map(), byHash = new Map(), byRec = new Map();
  const years = new Set();
  for (const p of photos) {
    push(byDate, dateOf(p.t), p);
    push(byLoc, p.loc || '', p);
    push(byGroup, groupCode(p.sp), p);
    push(byRec, recKey(p), p);
    if (p.hash) byHash.set(p.hash, p);
    if (p.t) years.add(p.t.slice(0, 4));
  }
  const locs = Object.values(S.db.locations).filter((l) => !l.del);
  idx = { photos, byDate, byLoc, byGroup, byHash, byRec, locs, years: [...years].sort().reverse() };
  idxV = S.dbv;
  return idx;
}

export const locName = (id) => (id && S.db.locations[id] && !S.db.locations[id].del ? S.db.locations[id].name : '');

// ---------- 修改 ----------

const persistSoon = debounce(() => { persist().catch(() => {}); }, 400);
let syncTimer = null;

function touched() {
  S.dbv++;
  S.dirty = true;
  persistSoon();
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync(), 2500);
  notify();
}

/** 本地修改的时间戳：保证比它所基于的那一版新，即使另一台设备的时钟快了几分钟也不会把这次修改盖掉 */
const stamp = (prev) => Math.max(Date.now(), ((prev && prev.m) || 0) + 1);

export function addPhoto(p) {
  S.db.photos[p.id] = { ...p, m: stamp(S.db.photos[p.id]) };
  touched();
}

/** 批量修改照片的鸟种 / 地点 / 时间等。记录的数量和备注会跟着照片走。 */
export function patchPhotos(ids, patch) {
  const moved = new Map(); // 旧记录 → 新记录
  for (const id of ids) {
    const p = S.db.photos[id];
    if (!p || p.del) continue;
    const before = recKey(p);
    const next = { ...p, ...patch, m: stamp(p) };
    if (typeof patch.dateOnly === 'string') {
      delete next.dateOnly;
      next.t = patch.dateOnly + (p.t && p.t.length > 10 ? p.t.slice(10) : 'T12:00:00');
      next.tSrc = 'manual';
    }
    S.db.photos[id] = next;
    const after = recKey(next);
    if (after !== before) moved.set(before, after);
  }
  if (moved.size) {
    idxV = -1;
    S.dbv++;
    const ix = index();
    for (const [from, to] of moved) {
      const rec = S.db.records[from];
      if (!rec || rec.del || ix.byRec.has(from)) continue; // 旧记录下还有照片，备注留在原处
      const target = S.db.records[to];
      if (!target || target.del || (!target.note && target.count == null)) {
        S.db.records[to] = { ...rec, m: stamp(target) };
      }
      S.db.records[from] = { m: stamp(rec), del: 1 };
    }
  }
  touched();
}

export function setCover(id) {
  const p = S.db.photos[id];
  if (!p) return;
  const g = groupCode(p.sp);
  for (const q of index().byGroup.get(g) || []) {
    if (q.cover && q.id !== id) S.db.photos[q.id] = { ...q, cover: false, m: stamp(q) };
  }
  S.db.photos[id] = { ...p, cover: !p.cover, m: stamp(p) };
  touched();
}

/** 删除照片：记录里打上删除标记，存储端的文件移到回收站 */
export async function deletePhotos(ids) {
  const files = [];
  for (const id of ids) {
    const p = S.db.photos[id];
    if (!p || p.del) continue;
    files.push(p.orig, p.thumb, p.prev);
    S.db.photos[id] = { id, m: stamp(p), del: 1 };
    dropUrl(id);
    idbDel('thumbs', id).catch(() => {});
    idbDel('previews', id).catch(() => {});
  }
  touched();
  try {
    await S.backend.trash(files.filter(Boolean));
  } catch (e) {
    toast('记录已删除，但有文件没能移到回收站：' + e.message, 'error');
  }
}

export function saveLocation(loc) {
  const id = loc.id || 'loc' + uid();
  const cur = S.db.locations[id] || {};
  const next = { ...cur, ...loc, id, m: stamp(cur) };
  delete next.del;
  if (next.lat == null || next.lng == null || isNaN(next.lat) || isNaN(next.lng)) { delete next.lat; delete next.lng; }
  S.db.locations[id] = next;
  touched();
  return id;
}

export function deleteLocation(id) {
  if ((index().byLoc.get(id) || []).length) return false;
  S.db.locations[id] = { id, m: stamp(S.db.locations[id]), del: 1 };
  touched();
  return true;
}

export function getRecord(key) {
  const r = S.db.records[key];
  return r && !r.del ? r : {};
}

export function setRecord(key, fields) {
  const cur = getRecord(key);
  const next = { ...cur, ...fields, m: stamp(S.db.records[key]) };
  if (next.count == null || next.count === '' || isNaN(next.count)) delete next.count;
  if (!next.note) delete next.note;
  delete next.del;
  S.db.records[key] = next;
  touched();
}

// ---------- 本地快照：每次修改都先存在浏览器里，关掉页面也不会丢 ----------

const snapKey = () => 'snap:' + (S.backend ? S.backend.kind : 'none');

export async function persist() {
  if (!S.backend || S.backend.kind !== 'drive') return; // 本地试用模式的数据本来就直接存在本地
  await idbSet('kv', snapKey(), { email: S.user ? S.user.email : '', db: S.db, rev: S.rev, dirty: S.dirty });
}

// ---------- 同步 ----------

let syncing = false;
let again = false;

function setSync(state, error = '') {
  S.sync = { state, error, at: state === 'idle' ? Date.now() : S.sync.at };
  notify();
}

export async function sync() {
  if (!S.backend || S.phase !== 'ready') return;
  if (syncing) { again = true; return; }
  clearTimeout(syncTimer);
  syncing = true;
  setSync('syncing');
  let saving = false;
  try {
    const remoteRev = await S.backend.dbRev();
    if (remoteRev !== S.rev) {
      // 另一台设备改过：取下来合并
      const remote = await S.backend.loadDb();
      if (remote.data) {
        const { db, localNewer } = mergeDb(S.db, normalizeDb(remote.data));
        S.db = db;
        S.dbv++;
        if (localNewer) S.dirty = true;
      } else {
        S.dirty = true;
      }
      S.rev = remote.rev;
    } else if (remoteRev === null) {
      S.dirty = true; // 存储端还没有记录文件，建一个
    }
    if (S.dirty) {
      S.dirty = false;
      saving = true;
      S.rev = await S.backend.saveDb(serializeDb(S.db));
      saving = false;
    }
    await persist().catch(() => {});
    setSync('idle');
  } catch (e) {
    if (saving) S.dirty = true;
    setSync(e.network || !navigator.onLine ? 'offline' : 'error', e.message || String(e));
  } finally {
    syncing = false;
    if (again || (S.dirty && S.sync.state === 'idle')) {
      again = false;
      clearTimeout(syncTimer);
      syncTimer = setTimeout(() => sync(), 800);
    }
  }
}

/** 页面重新回到前台时，隔一阵检查一次另一台设备有没有改动 */
export function syncIfStale(ms = 60000) {
  if (S.phase === 'ready' && !syncing && Date.now() - (S.sync.at || 0) > ms) sync();
}

// ---------- 启动与切换存储 ----------

const KIND_KEY = 'birdlog.backend';

export function savedKind() {
  try { return localStorage.getItem(KIND_KEY) || ''; } catch { return ''; }
}

export async function startBackend(backend) {
  S.backend = backend;
  S.db = emptyDb();
  S.rev = null;
  S.dirty = false;
  S.needAuth = false;
  S.dbv++;

  if (backend.kind === 'drive') {
    // 先用这台设备上次存下的快照把界面显示出来，再去 Drive 取最新的
    const snap = await idbGet('kv', snapKey()).catch(() => null);
    const hasSnap = !!(snap && snap.db);
    if (hasSnap) {
      S.db = normalizeDb(snap.db);
      S.rev = snap.rev || null;
      S.dirty = !!snap.dirty;
      S.user = { name: snap.email || 'Google Drive', email: snap.email || '' };
      S.dbv++;
    }
    let online = false;
    if (backend.hasToken()) {
      try {
        const user = await backend.connect();
        if (hasSnap && snap.email && user.email && snap.email !== user.email) {
          // 换了 Google 账号：不能把上一个账号的本地数据混进来
          S.db = emptyDb();
          S.rev = null;
          S.dirty = false;
          S.dbv++;
          await clearCaches();
        }
        S.user = user;
        online = true;
      } catch (e) {
        if (!hasSnap) { S.backend = null; throw e; }
        S.sync = { state: e.network ? 'offline' : 'error', error: e.message || String(e), at: 0 };
      }
    } else {
      S.needAuth = true;
    }
    try { localStorage.setItem(KIND_KEY, backend.kind); } catch { /* 忽略 */ }
    S.phase = 'ready';
    notify();
    if (online) sync();
    return;
  }

  try { localStorage.setItem(KIND_KEY, backend.kind); } catch { /* 忽略 */ }
  S.user = await backend.connect();
  const remote = await backend.loadDb();
  if (remote.data) S.db = normalizeDb(remote.data);
  S.rev = remote.rev;
  S.dbv++;
  S.phase = 'ready';
  S.sync = { state: 'idle', error: '', at: Date.now() };
  notify();
}

/** 授权过期后重新连接（必须由用户点击触发） */
export async function reconnect() {
  const be = S.backend;
  if (!be || be.kind !== 'drive') return;
  await be.authorize();
  S.needAuth = false;
  const user = await be.connect();
  if (S.user && S.user.email && user.email && S.user.email !== user.email) {
    S.db = emptyDb();
    S.rev = null;
    S.dirty = false;
    S.dbv++;
    await clearCaches();
  }
  S.user = user;
  notify();
  await sync();
}

export async function clearCaches() {
  for (const u of urls.values()) URL.revokeObjectURL(u);
  urls.clear();
  await Promise.all([idbClear('thumbs'), idbClear('previews')]).catch(() => {});
}

/** 退出当前存储，回到欢迎页（存储端的数据不受影响） */
export async function leaveBackend() {
  const be = S.backend;
  if (be && be.kind === 'drive') {
    be.signOut();
    await idbDel('kv', snapKey()).catch(() => {});
    await clearCaches();
  }
  try { localStorage.removeItem(KIND_KEY); } catch { /* 忽略 */ }
  S.backend = null;
  S.user = null;
  S.db = emptyDb();
  S.rev = null;
  S.dirty = false;
  S.needAuth = false;
  S.viewer = null;
  S.dbv++;
  S.phase = 'welcome';
  notify();
}

// ---------- 缩略图 / 预览图 / 原图 ----------

const urls = new Map();       // key → objectURL，最近用过的排后面
const inflight = new Map();
const MAX_URLS = 1200;
const netLimit = limiter(6);

function dropUrl(id) {
  for (const k of ['t:' + id, 'p:' + id]) {
    const u = urls.get(k);
    if (u) { URL.revokeObjectURL(u); urls.delete(k); }
  }
}

function remember(key, url) {
  urls.set(key, url);
  if (urls.size > MAX_URLS) {
    const first = urls.keys().next().value;
    URL.revokeObjectURL(urls.get(first));
    urls.delete(first);
  }
}

function blobUrl(key, store, id, fileId) {
  const have = urls.get(key);
  if (have) { urls.delete(key); urls.set(key, have); return Promise.resolve(have); }
  if (inflight.has(key)) return inflight.get(key);
  const be = S.backend;
  const job = (async () => {
    let blob = be.cacheable ? await idbGet(store, id).catch(() => null) : null;
    if (!blob) {
      if (!fileId) return null;
      blob = await netLimit(() => be.getBlob(fileId));
      if (be.cacheable) idbSet(store, id, blob).catch(() => {});
    }
    if (S.backend !== be) return null;
    const url = URL.createObjectURL(blob);
    remember(key, url);
    return url;
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

export const thumbUrl = (p) => blobUrl('t:' + p.id, 'thumbs', p.id, p.thumb);
export const previewUrl = (p) => blobUrl('p:' + p.id, 'previews', p.id, p.prev || p.thumb);
export const cachedThumbUrl = (p) => urls.get('t:' + p.id) || null;

/** 刚导入的照片，缩略图和预览图手头就有，直接放进缓存，不用再从存储端取 */
export function primeImages(id, thumbBlob, previewBlob) {
  if (!S.backend || !S.backend.cacheable) return;
  if (thumbBlob) idbSet('thumbs', id, thumbBlob).catch(() => {});
  if (previewBlob) idbSet('previews', id, previewBlob).catch(() => {});
}

export const originalBlob = (p) => S.backend.getBlob(p.orig);

// ---------- 提示、对话框、看图器 ----------

export function toast(text, kind = 'info') {
  const t = { id: uid(), text, kind };
  S.toasts = [...S.toasts, t];
  notify();
  setTimeout(() => { S.toasts = S.toasts.filter((x) => x !== t); notify(); }, kind === 'error' ? 7000 : 3200);
}

/** 打开一个对话框，返回的 Promise 在对话框关闭时得到结果（取消时是 undefined） */
export function openDialog(component, props = {}) {
  return new Promise((resolve) => {
    const d = { id: uid(), component, props };
    d.close = (result) => {
      S.dialogs = S.dialogs.filter((x) => x !== d);
      notify();
      resolve(result);
    };
    S.dialogs = [...S.dialogs, d];
    notify();
  });
}

export function openViewer(ids, i) {
  S.viewer = { ids, i };
  try { history.pushState({ birdlogViewer: true }, ''); } catch { /* 忽略 */ }
  notify();
}

export function closeViewer(fromPop = false) {
  if (!S.viewer) return;
  S.viewer = null;
  notify();
  if (!fromPop) {
    try { if (history.state && history.state.birdlogViewer) history.back(); } catch { /* 忽略 */ }
  }
}

// ---------- 最近用过的鸟种 ----------

const RECENT_KEY = 'birdlog.recentSpecies';

export function recentSpecies() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}

export function noteSpeciesUsed(code) {
  if (!code) return;
  const list = [code, ...recentSpecies().filter((c) => c !== code)].slice(0, 16);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* 忽略 */ }
}
