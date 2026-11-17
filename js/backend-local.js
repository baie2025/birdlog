// 「本地试用」存储：照片和记录都只放在这个浏览器里（IndexedDB），不联网。
// 用来在接好 Google Drive 之前先试用界面；清除浏览器数据会一起清掉。

import { idbGet, idbSet, idbDel, idbKeys, idbClear } from './cache.js';
import { uid } from './util.js';

export class LocalBackend {
  kind = 'local';
  cacheable = false; // 文件本来就在本地，不需要再缓存一份

  async connect() {
    return { name: '本地试用', email: '' };
  }

  async dbRev() {
    const v = await idbGet('kv', 'local-db');
    return v ? v.rev : null;
  }

  async loadDb() {
    const v = await idbGet('kv', 'local-db');
    return v ? { data: v.data, rev: v.rev } : { data: null, rev: null };
  }

  async saveDb(data) {
    const rev = uid();
    await idbSet('kv', 'local-db', { data, rev });
    return rev;
  }

  async putFile({ blob, name, path, onProgress }) {
    const id = 'L' + uid();
    await idbSet('localfiles', id, { blob, name, path: (path || []).join('/') });
    if (onProgress) onProgress(1);
    return id;
  }

  async getBlob(id) {
    const v = await idbGet('localfiles', id);
    if (!v) throw new Error('本地文件不存在');
    return v.blob;
  }

  async trash(ids) {
    for (const id of ids) await idbDel('localfiles', id);
  }

  async quota() {
    try {
      const e = await navigator.storage.estimate();
      return { used: e.usage || 0, total: e.quota || null };
    } catch {
      return null;
    }
  }

  fileLink() { return null; }
  folderLink() { return null; }

  async fileCount() {
    return (await idbKeys('localfiles')).length;
  }

  /** 清空本地试用的全部照片和记录 */
  async wipe() {
    await idbClear('localfiles');
    await idbDel('kv', 'local-db');
  }
}
