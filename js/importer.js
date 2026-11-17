// 导入流程：
//   1. 选中的文件先进「待导入」区，逐个分析（读拍摄时间、算指纹查重、生成缩略图和预览图）；
//   2. 你在待导入区给它们设地点、标鸟种；
//   3. 点「开始上传」后进入上传队列，传完一张，资料库里就多一张。

import { analyze, fileKind, mimeOf, cameraName } from './imaging.js';
import { S, notify, index, addPhoto, primeImages, toast, locName } from './store.js';
import { uid, dateOf, safeName, haversineKm, limiter } from './util.js';

export const I = {
  staged: [],   // 待导入
  queue: [],    // 上传队列
  v: 0,         // 每次变化加一，界面据此刷新
};

function changed() {
  I.v++;
  notify();
}

let lastProgress = 0;
function progressChanged() {
  const now = Date.now();
  if (now - lastProgress < 200) return;
  lastProgress = now;
  changed();
}

const analyzeLimit = limiter(2);

export function nearestLocation(lat, lng, maxKm = 1.5) {
  let best = null, bestD = maxKm;
  for (const l of index().locs) {
    if (l.lat == null || l.lng == null) continue;
    const d = haversineKm(lat, lng, l.lat, l.lng);
    if (d <= bestD) { best = l; bestD = d; }
  }
  return best;
}

export function addFiles(fileList) {
  let skipped = 0;
  for (const file of [...fileList]) {
    if (fileKind(file) === 'other') { skipped++; continue; }
    const s = {
      id: 'p' + uid(), file, name: file.name, size: file.size,
      status: 'processing', error: '', dup: '',
      sp: '', loc: '', t: '', tSrc: '', meta: {}, thumbUrl: '',
    };
    I.staged.push(s);
    analyzeLimit(() => process(s));
  }
  if (skipped) toast(`有 ${skipped} 个文件不是图片，已忽略`);
  changed();
}

async function process(s) {
  if (!I.staged.includes(s)) return; // 分析之前就被移除了
  try {
    const a = await analyze(s.file);
    Object.assign(s, { kind: a.kind, hash: a.hash, meta: a.meta, t: a.t, tSrc: a.tSrc, w: a.w, h: a.h, thumbBlob: a.thumbBlob, previewBlob: a.previewBlob });
    s.thumbUrl = a.thumbBlob ? URL.createObjectURL(a.thumbBlob) : '';
    if (index().byHash.has(a.hash)) s.dup = 'library';
    else if (I.staged.some((o) => o !== s && o.hash === a.hash) || I.queue.some((q) => q.s.hash === a.hash)) s.dup = 'batch';
    if (a.meta.lat != null) {
      const near = nearestLocation(a.meta.lat, a.meta.lng);
      if (near) s.loc = near.id;
    }
    s.status = 'ready';
  } catch (e) {
    s.status = 'error';
    s.error = e.message || String(e);
  }
  changed();
}

function release(s) {
  if (s.thumbUrl) URL.revokeObjectURL(s.thumbUrl);
  s.thumbUrl = '';
  s.file = null;
  s.thumbBlob = null;
  s.previewBlob = null;
}

export function removeStaged(ids) {
  const set = new Set(ids);
  for (const s of I.staged) if (set.has(s.id)) release(s);
  I.staged = I.staged.filter((s) => !set.has(s.id));
  changed();
}

export function patchStaged(ids, patch) {
  const set = new Set(ids);
  for (const s of I.staged) {
    if (!set.has(s.id)) continue;
    if (typeof patch.dateOnly === 'string') {
      s.t = patch.dateOnly + (s.t && s.t.length > 10 ? s.t.slice(10) : 'T12:00:00');
      s.tSrc = 'manual';
    } else {
      Object.assign(s, patch);
    }
  }
  changed();
}

/** 可以上传的：分析完成、且不是重复的 */
export const uploadable = () => I.staged.filter((s) => s.status === 'ready' && !s.dup);

export function startUpload() {
  const list = uploadable();
  if (!list.length) return 0;
  const set = new Set(list);
  I.staged = I.staged.filter((s) => !set.has(s));
  for (const s of list) I.queue.push({ id: s.id, s, status: 'queued', progress: 0, error: '' });
  changed();
  pump();
  return list.length;
}

let active = 0;
const MAX_ACTIVE = 2;

function pump() {
  while (active < MAX_ACTIVE) {
    const it = I.queue.find((q) => q.status === 'queued');
    if (!it) break;
    run(it);
  }
}

async function run(it) {
  active++;
  it.status = 'uploading';
  it.error = '';
  changed();
  const s = it.s;
  const be = S.backend;
  try {
    const date = dateOf(s.t);
    const place = locName(s.loc);
    const path = date
      ? ['Photos', date.slice(0, 4), safeName(place ? `${date} ${place}` : date)]
      : ['Photos', '未知日期'];
    // 已经传完的部分记在 it 上，重试时不会重复上传
    if (!it.orig) {
      it.orig = await be.putFile({ blob: s.file, name: s.name, path, mime: mimeOf(s.file), onProgress: (p) => { it.progress = p * 0.94; progressChanged(); } });
    }
    it.progress = 0.94;
    if (s.thumbBlob && !it.thumb) it.thumb = await be.putFile({ blob: s.thumbBlob, name: s.id + '_t.jpg', path: ['_app', 'thumbs'], mime: 'image/jpeg' });
    it.progress = 0.97;
    if (s.previewBlob && !it.prev) it.prev = await be.putFile({ blob: s.previewBlob, name: s.id + '_p.jpg', path: ['_app', 'previews'], mime: 'image/jpeg' });
    if (S.backend !== be) throw new Error('存储已切换，上传取消');
    const m = s.meta || {};
    primeImages(s.id, s.thumbBlob, s.previewBlob);
    addPhoto({
      id: s.id, name: s.name, size: s.size, mime: mimeOf(s.file), kind: s.kind, hash: s.hash,
      orig: it.orig, thumb: it.thumb || '', prev: it.prev || '',
      t: s.t, tSrc: s.tSrc, w: s.w, h: s.h,
      lat: m.lat, lng: m.lng,
      cam: cameraName(m.make, m.model) || undefined, lens: m.lens, fl: m.fl, fn: m.fn, ex: m.ex, iso: m.iso,
      sp: s.sp || '', loc: s.loc || '', added: Date.now(),
    });
    it.status = 'done';
    it.progress = 1;
    it.name = s.name;
    release(s);
  } catch (e) {
    it.status = 'error';
    it.error = e.message || String(e);
  } finally {
    active--;
    changed();
    pump();
  }
}

export function retryFailed() {
  for (const q of I.queue) if (q.status === 'error') { q.status = 'queued'; q.error = ''; }
  changed();
  pump();
}

export function clearFinished() {
  for (const q of I.queue) if (q.status === 'error') release(q.s);
  I.queue = I.queue.filter((q) => q.status === 'queued' || q.status === 'uploading');
  changed();
}

export function queueStats() {
  let done = 0, failed = 0, pending = 0, progress = 0;
  for (const q of I.queue) {
    if (q.status === 'done') { done++; progress += 1; }
    else if (q.status === 'error') failed++;
    else { pending++; progress += q.progress || 0; }
  }
  const total = done + pending;
  return { done, failed, pending, total: I.queue.length, ratio: total ? progress / total : 0 };
}

export const uploadBusy = () => I.queue.some((q) => q.status === 'queued' || q.status === 'uploading');

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (uploadBusy()) { e.preventDefault(); e.returnValue = ''; }
  });
}
