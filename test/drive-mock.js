// 测试用：在浏览器里假扮 Google Drive 的接口（只在内存里），用来检查 Drive 存储和同步的逻辑。
// 它只模拟 BirdLog 用到的那几个接口，不能代替对真实 Drive 的测试。

export function installDriveMock() {
  const files = new Map();     // id → { id, name, mimeType, parents, trashed, content(Blob), rev, modifiedTime }
  const sessions = new Map();  // 上传会话
  const log = [];
  const state = {
    token: 'T1',
    seq: 0,
    interruptAfter: 0,   // >0 时，下一次分块上传收到这么多字节后模拟断网
    user: { displayName: '测试用户', emailAddress: 'tester@example.com' },
  };
  const newId = () => 'F' + (++state.seq);
  const now = () => new Date(Date.now() + state.seq).toISOString();
  const json = (obj, status = 200, headers = {}) =>
    new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const err = (status, message, reason = '') => json({ error: { code: status, message, errors: [{ reason }] } }, status);

  function create(meta, content) {
    const f = {
      id: newId(), name: meta.name, mimeType: meta.mimeType || (content && content.type) || 'application/octet-stream',
      parents: meta.parents && meta.parents.length ? meta.parents : ['ROOT'], trashed: false,
      content: content || null, rev: 'R' + (++state.seq), modifiedTime: now(),
    };
    files.set(f.id, f);
    return f;
  }

  function query(q) {
    const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q);
    const mime = /mimeType = '([^']*)'/.exec(q);
    const parent = /'([^']+)' in parents/.exec(q);
    const wantName = name ? name[1].replace(/\\(.)/g, '$1') : null;
    return [...files.values()].filter((f) =>
      (!wantName || f.name === wantName)
      && (!mime || f.mimeType === mime[1])
      && (!parent || f.parents.includes(parent[1] === 'root' ? 'ROOT' : parent[1]))
      && (!/trashed = false/.test(q) || !f.trashed));
  }

  async function parseMultipart(body, contentType) {
    const boundary = /boundary=(.+)$/.exec(contentType)[1];
    const buf = new Uint8Array(await new Response(body).arrayBuffer());
    const enc = new TextEncoder();
    const find = (needle, from) => {
      const n = enc.encode(needle);
      outer: for (let i = from; i <= buf.length - n.length; i++) {
        for (let k = 0; k < n.length; k++) if (buf[i + k] !== n[k]) continue outer;
        return i;
      }
      return -1;
    };
    const h1 = find('\r\n\r\n', 0) + 4;
    const e1 = find('\r\n--' + boundary, h1);
    const meta = JSON.parse(new TextDecoder().decode(buf.subarray(h1, e1)));
    const head2 = new TextDecoder().decode(buf.subarray(e1, find('\r\n\r\n', e1 + 2)));
    const type = (/Content-Type: (.+)/.exec(head2) || [])[1] || 'application/octet-stream';
    const h2 = find('\r\n\r\n', e1 + 2) + 4;
    const e2 = buf.length - enc.encode('\r\n--' + boundary + '--').length;
    return { meta, content: new Blob([buf.slice(h2, e2)], { type: type.trim() }) };
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opts = {}) => {
    const u = new URL(String(url), location.href);
    if (!u.hostname.endsWith('googleapis.com')) return realFetch(url, opts);
    const method = (opts.method || 'GET').toUpperCase();
    const headers = opts.headers || {};
    log.push(`${method} ${u.pathname}${u.search}`);
    if (headers.Authorization !== 'Bearer ' + state.token) return err(401, 'Invalid Credentials', 'authError');
    const p = u.pathname;
    const qs = u.searchParams;

    if (p === '/drive/v3/about') return json({ user: state.user, storageQuota: { limit: String(400 * 2 ** 30), usage: String(150 * 2 ** 30) } });

    if (p === '/drive/v3/files' && method === 'GET') {
      return json({ files: query(qs.get('q') || '').map((f) => ({ id: f.id, name: f.name, parents: f.parents, modifiedTime: f.modifiedTime })) });
    }
    if (p === '/drive/v3/files' && method === 'POST') {
      return json({ id: create(JSON.parse(opts.body)).id });
    }
    const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(p);
    if (m) {
      const f = files.get(m[1]);
      if (!f) return err(404, 'File not found', 'notFound');
      if (method === 'PATCH') { Object.assign(f, JSON.parse(opts.body)); return json({ id: f.id }); }
      if (qs.get('alt') === 'media') return new Response(f.content, { status: 200, headers: { 'Content-Type': f.mimeType } });
      return json({ id: f.id, headRevisionId: f.rev, modifiedTime: f.modifiedTime });
    }
    if (p === '/upload/drive/v3/files' && method === 'POST' && qs.get('uploadType') === 'multipart') {
      const { meta, content } = await parseMultipart(opts.body, headers['Content-Type']);
      const f = create(meta, content);
      return json({ id: f.id, headRevisionId: f.rev });
    }
    if (p === '/upload/drive/v3/files' && method === 'POST' && qs.get('uploadType') === 'resumable') {
      const sid = 'S' + (++state.seq);
      sessions.set(sid, { meta: JSON.parse(opts.body), size: Number(headers['X-Upload-Content-Length']), mime: headers['X-Upload-Content-Type'], parts: [], got: 0, file: null });
      return json({}, 200, { Location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${sid}` });
    }
    const up = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(p);
    if (up && method === 'PATCH') {
      const f = files.get(up[1]);
      if (!f) return err(404, 'File not found', 'notFound');
      f.content = new Blob([opts.body], { type: headers['Content-Type'] || f.mimeType });
      f.rev = 'R' + (++state.seq);
      f.modifiedTime = now();
      return json({ id: f.id, headRevisionId: f.rev });
    }
    return err(400, 'mock: unsupported ' + method + ' ' + p);
  };

  class FakeXHR {
    constructor() { this.upload = {}; this.headers = {}; this.status = 0; this.responseText = ''; this.resHeaders = {}; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    getResponseHeader(k) { return this.resHeaders[k] || null; }
    send(body) {
      const sid = new URL(this.url).searchParams.get('upload_id');
      const s = sessions.get(sid);
      log.push(`PUT session ${sid} ${this.headers['Content-Range'] || '(whole)'}`);
      const finish = (status, text, hdr = {}) => setTimeout(() => {
        this.status = status; this.responseText = text; this.resHeaders = hdr;
        if (this.onload) this.onload();
      }, 5);
      if (!s) { finish(404, ''); return; }
      const range = this.headers['Content-Range'] || '';
      if (/^bytes \*\//.test(range)) {
        if (s.file) finish(200, JSON.stringify({ id: s.file.id }));
        else finish(308, '', s.got ? { Range: `bytes=0-${s.got - 1}` } : {});
        return;
      }
      const offset = range ? Number(/bytes (\d+)-/.exec(range)[1]) : 0;
      if (offset !== s.got) { finish(400, ''); return; }
      let blob = body;
      if (state.interruptAfter > 0 && blob.size > state.interruptAfter) {
        const keep = state.interruptAfter;
        state.interruptAfter = 0;
        s.parts.push(blob.slice(0, keep));
        s.got += keep;
        setTimeout(() => { if (this.onerror) this.onerror(); }, 5);
        return;
      }
      s.parts.push(blob);
      s.got += blob.size;
      if (this.upload.onprogress) {
        this.upload.onprogress({ loaded: Math.floor(blob.size / 2), total: blob.size });
        this.upload.onprogress({ loaded: blob.size, total: blob.size });
      }
      if (s.got === s.size) {
        s.file = create(s.meta, new Blob(s.parts, { type: s.mime }));
        finish(200, JSON.stringify({ id: s.file.id }));
      } else {
        finish(308, '', { Range: `bytes=0-${s.got - 1}` });
      }
    }
  }
  window.XMLHttpRequest = FakeXHR;

  /** 路径（如 'BirdLog/Photos/2026'）→ 文件 */
  const pathOf = (f) => {
    const parts = [f.name];
    let cur = f;
    while (cur.parents[0] !== 'ROOT') { cur = files.get(cur.parents[0]); if (!cur) break; parts.unshift(cur.name); }
    return parts.join('/');
  };
  return {
    files, log, state, pathOf,
    byPath: (path) => [...files.values()].find((f) => !f.trashed && pathOf(f) === path),
    paths: () => [...files.values()].filter((f) => !f.trashed).map(pathOf).sort(),
  };
}
