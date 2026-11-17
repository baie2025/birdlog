// Google Drive 存储。
// 权限只申请 drive.file：应用只能看到它自己创建的文件，看不到你 Drive 里的其他东西。
// Drive 里的结构：
//   BirdLog/birdlog.json                         所有记录（日期、地点、鸟种、备注…）
//   BirdLog/Photos/2026/2026-11-14 地点名/…      原图，文件原样保存
//   BirdLog/_app/thumbs、BirdLog/_app/previews   缩略图和预览图

import { uid, sleep } from './util.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const ROOT_NAME = 'BirdLog';
const DB_NAME = 'birdlog.json';
const TOKEN_KEY = 'birdlog.gtoken';
const EMAIL_KEY = 'birdlog.gemail';
const RESUMABLE_OVER = 4 * 1024 * 1024;

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

let gisPromise = null;
function loadGis() {
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { gisPromise = null; reject(new Error('无法加载 Google 登录组件，请检查网络')); };
      document.head.appendChild(s);
    });
  }
  return gisPromise;
}

/** 提前把 Google 登录组件加载好，这样点「连接」时授权窗口能立刻弹出来，不会被浏览器拦截 */
export const preloadGoogle = loadGis;

export class DriveBackend {
  kind = 'drive';
  cacheable = true;

  /** onAuthNeeded(true/false)：授权失效 / 恢复时通知界面 */
  constructor(clientId, { onAuthNeeded } = {}) {
    this.clientId = clientId;
    this.onAuthNeeded = onAuthNeeded || (() => {});
    this.token = null;
    this.exp = 0;
    this.waiters = [];
    this.rootId = null;
    this.rootPromise = null;
    this.dbId = null;
    this.located = false;
    this.folderPromises = new Map();
    this.email = '';
    try {
      this.email = localStorage.getItem(EMAIL_KEY) || '';
      const saved = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
      if (saved && saved.exp > Date.now() + 60000) { this.token = saved.token; this.exp = saved.exp; }
    } catch { /* 忽略 */ }
  }

  hasToken() {
    return !!this.token && Date.now() < this.exp - 60000;
  }

  /** 弹出 Google 授权窗口。必须在用户点击按钮时调用，否则浏览器会拦掉弹窗。 */
  async authorize() {
    await loadGis();
    await new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: this.clientId,
        scope: SCOPE,
        callback: (r) => {
          if (r.error) { reject(new Error(r.error_description || r.error)); return; }
          if (!google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE)) {
            reject(new Error('没有勾选 Google Drive 的访问权限，请重新连接并勾选'));
            return;
          }
          this.token = r.access_token;
          this.exp = Date.now() + (Number(r.expires_in) || 3600) * 1000;
          try { localStorage.setItem(TOKEN_KEY, JSON.stringify({ token: this.token, exp: this.exp })); } catch { /* 忽略 */ }
          resolve();
        },
        error_callback: (e) => {
          const type = e && e.type;
          reject(new Error(type === 'popup_closed' ? '授权窗口被关闭了' : type === 'popup_failed_to_open' ? '浏览器拦截了授权弹窗，请允许弹窗后再试' : (e && e.message) || '授权失败'));
        },
      });
      client.requestAccessToken({ prompt: '', login_hint: this.email || undefined });
    });
    this.onAuthNeeded(false);
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f(this.token));
  }

  /** 取访问令牌；失效时通知界面并一直等到用户重新连接 */
  tok() {
    if (this.hasToken()) return Promise.resolve(this.token);
    this.onAuthNeeded(true);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  dropToken() {
    this.token = null;
    this.exp = 0;
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* 忽略 */ }
  }

  signOut() {
    const t = this.token;
    this.dropToken();
    try { localStorage.removeItem(EMAIL_KEY); } catch { /* 忽略 */ }
    try { if (t && window.google) google.accounts.oauth2.revoke(t, () => {}); } catch { /* 忽略 */ }
  }

  async req(url, opts = {}, attempt = 0) {
    const t = await this.tok();
    let r;
    try {
      r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + t } });
    } catch {
      const err = new Error('网络连接失败');
      err.network = true;
      throw err;
    }
    if (r.status === 401) {
      if (this.token === t) this.dropToken();
      return this.req(url, opts, attempt);
    }
    if (r.ok) return r;
    let reason = '', message = '';
    try {
      const j = await r.json();
      message = (j.error && j.error.message) || '';
      reason = (j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason) || '';
    } catch { /* 忽略 */ }
    const rateLimited = r.status === 429 || (r.status === 403 && /ratelimit/i.test(reason));
    if ((rateLimited || r.status >= 500) && attempt < 4) {
      await sleep(800 * 2 ** attempt + Math.random() * 400);
      return this.req(url, opts, attempt + 1);
    }
    const err = new Error(
      reason === 'storageQuotaExceeded' ? 'Google Drive 空间已满'
        : r.status === 404 ? 'Drive 上找不到这个文件（可能已被删除）'
          : `Drive 请求失败（${r.status}）${message ? '：' + message : ''}`);
    err.status = r.status;
    err.reason = reason;
    throw err;
  }

  async json(url, opts) {
    return (await this.req(url, opts)).json();
  }

  async about() {
    return this.json(`${API}/about?fields=${encodeURIComponent('user(displayName,emailAddress),storageQuota(limit,usage)')}`);
  }

  async connect() {
    const a = await this.about();
    this.email = a.user.emailAddress || '';
    try { localStorage.setItem(EMAIL_KEY, this.email); } catch { /* 忽略 */ }
    return { name: a.user.displayName || this.email, email: this.email };
  }

  async quota() {
    const q = (await this.about()).storageQuota || {};
    return { used: Number(q.usage) || 0, total: q.limit ? Number(q.limit) : null };
  }

  async list(q, fields = 'files(id,name)') {
    const url = `${API}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(fields)}&pageSize=100&spaces=drive`;
    return (await this.json(url)).files || [];
  }

  async createFolder(name, parent) {
    const body = { name, mimeType: FOLDER_MIME };
    if (parent) body.parents = [parent];
    const r = await this.json(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(body),
    });
    return r.id;
  }

  /** 找到记录文件；它所在的文件夹就是 BirdLog 根文件夹（即使你在 Drive 里把文件夹挪了位置也能找到） */
  async locate() {
    if (this.located) return;
    const files = await this.list(`name = '${DB_NAME}' and trashed = false`, 'files(id,name,parents,modifiedTime)');
    if (files.length) {
      files.sort((a, b) => String(b.modifiedTime).localeCompare(String(a.modifiedTime)));
      this.dbId = files[0].id;
      if (files[0].parents && files[0].parents[0]) this.rootId = files[0].parents[0];
    }
    this.located = true;
  }

  async root() {
    if (this.rootId) return this.rootId;
    if (!this.rootPromise) {
      this.rootPromise = (async () => {
        await this.locate();
        if (this.rootId) return this.rootId;
        const found = await this.list(`name = '${ROOT_NAME}' and mimeType = '${FOLDER_MIME}' and trashed = false`);
        this.rootId = found.length ? found[0].id : await this.createFolder(ROOT_NAME);
        return this.rootId;
      })().catch((e) => { this.rootPromise = null; throw e; });
    }
    return this.rootPromise;
  }

  /** 确保一串子文件夹存在（如 ['Photos','2026','2026-11-14 某地']），返回最里层的文件夹 ID */
  async ensureFolder(parts) {
    let parent = await this.root();
    let key = '';
    for (const name of parts) {
      key += '/' + name;
      if (!this.folderPromises.has(key)) {
        const par = parent;
        const p = (async () => {
          const found = await this.list(`name = '${esc(name)}' and mimeType = '${FOLDER_MIME}' and '${par}' in parents and trashed = false`);
          return found.length ? found[0].id : this.createFolder(name, par);
        })();
        p.catch(() => this.folderPromises.delete(key));
        this.folderPromises.set(key, p);
      }
      parent = await this.folderPromises.get(key);
    }
    return parent;
  }

  async dbRev() {
    await this.locate();
    if (!this.dbId) return null;
    return (await this.json(`${API}/files/${this.dbId}?fields=headRevisionId`)).headRevisionId || null;
  }

  async loadDb() {
    await this.locate();
    if (!this.dbId) return { data: null, rev: null };
    const rev = (await this.json(`${API}/files/${this.dbId}?fields=headRevisionId`)).headRevisionId || null;
    const data = await this.json(`${API}/files/${this.dbId}?alt=media`);
    return { data, rev };
  }

  async saveDb(data) {
    const body = JSON.stringify(data);
    await this.locate();
    if (!this.dbId) {
      const parent = await this.root();
      const r = await this.multipart({ name: DB_NAME, parents: [parent], mimeType: 'application/json' },
        new Blob([body], { type: 'application/json' }), 'id,headRevisionId');
      this.dbId = r.id;
      return r.headRevisionId || null;
    }
    const r = await this.json(`${UPLOAD}/files/${this.dbId}?uploadType=media&fields=id,headRevisionId`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body,
    });
    return r.headRevisionId || null;
  }

  /** 小文件：一次请求传完 */
  async multipart(meta, blob, fields = 'id') {
    const boundary = 'birdlog' + uid();
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
      `--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`,
      blob,
      `\r\n--${boundary}--`,
    ]);
    return this.json(`${UPLOAD}/files?uploadType=multipart&fields=${encodeURIComponent(fields)}`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
  }

  /** 大文件：可续传上传，断网后从断点接着传 */
  async resumable(meta, blob, mime, onProgress) {
    const r = await this.req(`${UPLOAD}/files?uploadType=resumable&fields=id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mime,
        'X-Upload-Content-Length': String(blob.size),
      },
      body: JSON.stringify(meta),
    });
    const session = r.headers.get('Location');
    if (!session) throw new Error('Drive 没有返回上传地址');
    let offset = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.sendFrom(session, blob, offset, mime, onProgress);
      } catch (e) {
        if (!e.retryable || attempt >= 6) throw e;
        await sleep(Math.min(30000, 1500 * 2 ** attempt));
        const st = await this.uploadStatus(session, blob.size).catch(() => null);
        if (st && st.done) return st.result;
        offset = st ? st.offset : 0;
      }
    }
  }

  sendFrom(session, blob, offset, mime, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('PUT', session);
      x.setRequestHeader('Content-Type', mime);
      if (offset > 0) x.setRequestHeader('Content-Range', `bytes ${offset}-${blob.size - 1}/${blob.size}`);
      x.upload.onprogress = (e) => { if (onProgress) onProgress(Math.min(1, (offset + e.loaded) / blob.size)); };
      x.onload = () => {
        if (x.status === 200 || x.status === 201) {
          try { resolve(JSON.parse(x.responseText)); } catch (e) { reject(e); }
          return;
        }
        const err = new Error(`上传失败（${x.status}）`);
        err.status = x.status;
        err.retryable = x.status >= 500 || x.status === 429 || x.status === 408 || x.status === 308;
        reject(err);
      };
      x.onerror = () => {
        const err = new Error('上传时网络中断');
        err.retryable = true;
        err.network = true;
        reject(err);
      };
      x.send(offset > 0 ? blob.slice(offset) : blob);
    });
  }

  /** 问 Drive 这次上传已经收到多少字节 */
  uploadStatus(session, size) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('PUT', session);
      x.setRequestHeader('Content-Range', `bytes */${size}`);
      x.onload = () => {
        if (x.status === 200 || x.status === 201) {
          try { resolve({ done: true, result: JSON.parse(x.responseText) }); } catch (e) { reject(e); }
        } else if (x.status === 308) {
          const m = /bytes=0-(\d+)/.exec(x.getResponseHeader('Range') || '');
          resolve({ done: false, offset: m ? Number(m[1]) + 1 : 0 });
        } else {
          reject(new Error('上传会话已失效'));
        }
      };
      x.onerror = () => reject(new Error('网络连接失败'));
      x.send();
    });
  }

  async putFile({ blob, name, path, mime, onProgress }) {
    const parent = await this.ensureFolder(path || []);
    const meta = { name, parents: [parent] };
    const type = mime || blob.type || 'application/octet-stream';
    if (blob.size > RESUMABLE_OVER) return (await this.resumable(meta, blob, type, onProgress)).id;
    const typed = blob.type === type ? blob : new Blob([blob], { type });
    const r = await this.multipart(meta, typed);
    if (onProgress) onProgress(1);
    return r.id;
  }

  async getBlob(id) {
    return (await this.req(`${API}/files/${id}?alt=media`)).blob();
  }

  /** 删除 = 移到 Drive 回收站（30 天内可以在 Drive 里恢复） */
  async trash(ids) {
    for (const id of ids) {
      if (!id) continue;
      try {
        await this.req(`${API}/files/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trashed: true }),
        });
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
  }

  fileLink(id) {
    return id ? `https://drive.google.com/file/d/${id}/view` : null;
  }

  folderLink() {
    return this.rootId ? `https://drive.google.com/drive/folders/${this.rootId}` : null;
  }
}
