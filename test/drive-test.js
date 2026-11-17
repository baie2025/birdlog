// Drive 存储和同步逻辑的自测，跑在模拟的 Drive 上（见 drive-mock.js）。
import { installDriveMock } from './drive-mock.js';
import { makeFixtures } from './fixtures.js';

const out = document.getElementById('out');
const lines = [];
let failed = 0;
const show = () => { out.innerHTML = lines.join('<br>') + `<p id="summary" class="${failed ? 'fail' : 'ok'}">${failed ? `有 ${failed} 项失败` : `全部通过：${lines.length} 项`}</p>`; };
const assert = (cond, msg) => { if (!cond) throw new Error(msg || '断言失败'); };
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg || ''} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
async function test(name, fn) {
  try { await fn(); lines.push(`<span class="ok">✓ ${name}</span>`); }
  catch (e) { failed++; lines.push(`<span class="fail">✗ ${name}：${e.message}</span>`); console.error(name, e); }
  show();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bytes = async (blob) => new Uint8Array(await blob.arrayBuffer());
const sameBytes = async (a, b) => { const x = await bytes(a), y = await bytes(b); return x.length === y.length && x.every((v, i) => v === y[i]); };

if (location.port === '5173') {
  out.textContent = '请不要在 5173 端口运行这个测试（会和正式数据共用浏览器存储）。请用 5174 端口打开。';
  throw new Error('wrong port');
}

// 每次都从干净的浏览器存储开始，上一轮测试留下的快照不能带进来
localStorage.clear();
await new Promise((resolve) => {
  const rq = indexedDB.deleteDatabase('birdlog');
  rq.onsuccess = rq.onerror = rq.onblocked = () => resolve();
});

const mock = installDriveMock();
const { DriveBackend } = await import('../js/backend-drive.js');
const store = await import('../js/store.js');
const importer = await import('../js/importer.js');
const { loadTaxonomy } = await import('../js/taxonomy.js');
await loadTaxonomy();
const { S } = store;

let authNeeded = 0;
function makeBackend() {
  const be = new DriveBackend('test-client-id', { onAuthNeeded: (need) => { if (need) authNeeded++; S.needAuth = need; } });
  // 真的授权要弹 Google 的窗口，测试里直接换成「拿到新令牌」
  be.authorize = async () => {
    be.token = mock.state.token;
    be.exp = Date.now() + 3600e3;
    be.onAuthNeeded(false);
    const w = be.waiters; be.waiters = []; w.forEach((f) => f(be.token));
  };
  return be;
}
const be = makeBackend();
await be.authorize();

await test('连接并读到账号信息', async () => {
  const u = await be.connect();
  eq(u, { name: '测试用户', email: 'tester@example.com' });
  const q = await be.quota();
  assert(q.total === 400 * 2 ** 30 && q.used === 150 * 2 ** 30, '配额不对');
});

await test('第一次保存：建 BirdLog 文件夹和记录文件', async () => {
  eq(await be.dbRev(), null);
  const rev1 = await be.saveDb({ v: 1, photos: { a: { id: 'a', m: 1 } }, locations: {}, records: {} });
  assert(rev1, '没有拿到版本号');
  eq(mock.paths(), ['BirdLog', 'BirdLog/birdlog.json']);
  const loaded = await be.loadDb();
  eq(loaded.data.photos.a, { id: 'a', m: 1 });
  eq(loaded.rev, rev1);
  const rev2 = await be.saveDb({ v: 1, photos: {}, locations: {}, records: {} });
  assert(rev2 && rev2 !== rev1, '再次保存后版本号应该变化');
  eq(await be.dbRev(), rev2);
  eq(mock.paths().filter((p) => p.endsWith('birdlog.json')).length, 1, '记录文件应该只有一个');
});

await test('小文件上传到按日期和地点命名的文件夹', async () => {
  const blob = new Blob([new Uint8Array([1, 2, 3, 250, 251, 13, 10, 45, 45])], { type: 'image/jpeg' });
  const id = await be.putFile({ blob, name: "it's a test.jpg", path: ['Photos', '2026', "2026-11-14 Bob's Marsh"], mime: 'image/jpeg' });
  const f = mock.files.get(id);
  eq(mock.pathOf(f), "BirdLog/Photos/2026/2026-11-14 Bob's Marsh/it's a test.jpg");
  assert(await sameBytes(f.content, blob), '内容不一致');
  assert(await sameBytes(await be.getBlob(id), blob), '取回的内容不一致');
});

await test('同时上传到同一个新文件夹，文件夹只建一个', async () => {
  const mk = (n) => be.putFile({ blob: new Blob(['x' + n], { type: 'text/plain' }), name: `f${n}.txt`, path: ['Photos', '2025', '2025-05-12 Central Park'] });
  await Promise.all([mk(1), mk(2), mk(3)]);
  const folders = [...mock.files.values()].filter((f) => f.name === '2025-05-12 Central Park');
  eq(folders.length, 1);
  eq(mock.paths().filter((p) => p.startsWith('BirdLog/Photos/2025/2025-05-12 Central Park/')).length, 3);
});

const big = new Blob([crypto.getRandomValues(new Uint8Array(65536)), new Uint8Array(6 * 1024 * 1024).fill(7), crypto.getRandomValues(new Uint8Array(1000))], { type: 'image/x-canon-cr3' });

await test('大文件走可续传上传，进度到 100%', async () => {
  const seen = [];
  const id = await be.putFile({ blob: big, name: 'IMG_0001.CR3', path: ['Photos', '2026', '2026-11-14'], mime: 'image/x-canon-cr3', onProgress: (p) => seen.push(p) });
  assert(await sameBytes(mock.files.get(id).content, big), '内容不一致');
  assert(seen.length >= 2 && seen[seen.length - 1] === 1, '进度没有到 1：' + seen.join(','));
  assert(mock.log.some((l) => l.includes('uploadType=resumable')), '没有用可续传上传');
});

await test('上传中途断网后从断点续传', async () => {
  mock.state.interruptAfter = 1234567;
  const before = mock.log.length;
  const id = await be.putFile({ blob: big, name: 'IMG_0002.CR3', path: ['Photos', '2026', '2026-11-14'], mime: 'image/x-canon-cr3' });
  assert(await sameBytes(mock.files.get(id).content, big), '续传后内容不一致');
  const puts = mock.log.slice(before).filter((l) => l.startsWith('PUT session'));
  assert(puts.some((l) => l.includes('bytes */')), '没有查询断点');
  assert(puts.some((l) => l.includes('bytes 1234567-')), '没有从断点继续：' + puts.join(' | '));
});

await test('授权过期：通知界面，重新连接后请求自动继续', async () => {
  const n0 = authNeeded;
  mock.state.token = 'T2';              // 服务器端旧令牌失效
  const pending = be.getBlob(mock.byPath('BirdLog/birdlog.json').id).then((b) => b.text());
  await sleep(50);
  assert(authNeeded === n0 + 1 && S.needAuth === true, '应该提示需要重新连接');
  await be.authorize();                 // 用户点了「重新连接」
  const text = await pending;
  assert(text.includes('"photos"'), '重新连接后没有拿到内容');
  eq(S.needAuth, false);
});

await test('删除是移到回收站', async () => {
  const id = await be.putFile({ blob: new Blob(['bye']), name: 'bye.txt', path: ['_app', 'thumbs'] });
  await be.trash([id, 'no-such-file']);
  assert(mock.files.get(id).trashed === true, '文件应该被标记为已移到回收站');
});

await test('另一台设备：找到同一个记录文件，不会再建一套文件夹', async () => {
  const other = makeBackend();
  await other.authorize();
  const loaded = await other.loadDb();
  assert(loaded.data && loaded.rev, '另一台设备没有读到记录');
  await other.putFile({ blob: new Blob(['o']), name: 'o.txt', path: ['Photos', '2026', '2026-11-14'] });
  eq([...mock.files.values()].filter((f) => f.name === 'BirdLog').length, 1);
  eq([...mock.files.values()].filter((f) => f.name === '2026-11-14' && !f.trashed).length, 1);
  eq(other.folderLink(), be.folderLink());
});

// ---------- 数据中心和同步 ----------

const settled = async () => { for (let i = 0; i < 200; i++) { if (S.sync.state === 'idle' && !S.dirty) return; await sleep(50); if (S.sync.state !== 'syncing') await store.sync(); } throw new Error('同步没有完成：' + JSON.stringify(S.sync)); };
const remoteDb = async () => JSON.parse(await mock.byPath('BirdLog/birdlog.json').content.text());
const remoteWrite = (db) => {
  const f = mock.byPath('BirdLog/birdlog.json');
  f.content = new Blob([JSON.stringify(db)], { type: 'application/json' });
  f.rev = 'R' + (++mock.state.seq);
};
const photo = (id, extra = {}) => ({ id, name: id + '.jpg', t: '2026-11-14T08:00:00', sp: '', loc: '', added: 1, ...extra });

await test('启动：从 Drive 读到已有记录', async () => {
  remoteWrite({ v: 1, photos: { r1: { ...photo('r1', { sp: 'norcar' }), m: 100 } }, locations: {}, records: {} });
  await store.startBackend(be);
  await settled();
  eq(S.phase, 'ready');
  eq(S.user.email, 'tester@example.com');
  eq(store.index().photos.map((p) => p.id), ['r1']);
});

await test('本地新增 → 自动保存到 Drive', async () => {
  store.addPhoto(photo('local1', { sp: 'blujay' }));
  await settled();
  const r = await remoteDb();
  assert(r.photos.local1 && r.photos.r1, 'Drive 上的记录应该两张都有');
  eq(r.app, 'BirdLog');
});

await test('另一台设备新增和修改 → 这边同步后看得到', async () => {
  const r = await remoteDb();
  r.photos.other1 = { ...photo('other1', { sp: 'rethaw' }), m: Date.now() + 1000 };
  r.photos.r1 = { ...r.photos.r1, sp: 'snoegr', m: Date.now() + 1000 };
  r.locations.locX = { id: 'locX', name: 'Other Place', m: Date.now() };
  remoteWrite(r);
  await store.sync();
  await settled();
  eq(store.index().photos.map((p) => p.id).sort(), ['local1', 'other1', 'r1']);
  eq(S.db.photos.r1.sp, 'snoegr');
  eq(store.locName('locX'), 'Other Place');
});

await test('两边同时改：各自的修改都保留，同一张照片取较新的', async () => {
  const r = await remoteDb();
  r.photos.other2 = { ...photo('other2'), m: Date.now() };
  r.photos.local1 = { ...r.photos.local1, sp: 'mallar3', m: Date.now() - 60000 };  // 对方改得早
  remoteWrite(r);
  store.patchPhotos(['local1'], { sp: 'norcar' });                                   // 这边改得晚
  store.patchPhotos(['other1'], { loc: 'locX' });
  await settled();
  eq(S.db.photos.local1.sp, 'norcar', '较新的本地修改应该保留');
  assert(S.db.photos.other2, '对方新增的应该合并进来');
  const after = await remoteDb();
  eq(after.photos.local1.sp, 'norcar', 'Drive 上也应该是较新的');
  eq(after.photos.other1.loc, 'locX');
  assert(after.photos.other2, 'Drive 上应该保留对方新增的');
});

await test('另一台设备删除 → 这边也消失', async () => {
  const r = await remoteDb();
  r.photos.other2 = { id: 'other2', m: Date.now() + 5000, del: 1 };
  remoteWrite(r);
  await store.sync();
  await settled();
  assert(!store.index().photos.some((p) => p.id === 'other2'), '被删除的照片不应该再出现');
});

await test('记录的数量和备注跟着照片走', async () => {
  const loc = store.saveLocation({ name: 'Bolsa Chica' });
  store.patchPhotos(['r1'], { loc });
  const k1 = store.recKey(S.db.photos.r1);
  store.setRecord(k1, { count: 2, note: '在浅水区' });
  store.patchPhotos(['r1'], { sp: 'greegr' });   // 改了鸟种，记录键变了
  const k2 = store.recKey(S.db.photos.r1);
  assert(k1 !== k2, '记录键应该变化');
  eq(store.getRecord(k2).note, '在浅水区');
  eq(store.getRecord(k2).count, 2);
  eq(store.getRecord(k1), {});
  await settled();
});

await test('完整导入流程：分析 → 上传原图、缩略图、预览图 → 写入记录', async () => {
  const all = await makeFixtures();
  const pick = all.filter((f) => ['IMG_1001.JPG', 'DSC09001.ARW', 'IMG_0042.CR3', 'IMG_1001 (copy).JPG'].includes(f.name));
  importer.addFiles(pick);
  for (let i = 0; i < 200 && importer.I.staged.some((s) => s.status === 'processing'); i++) await sleep(50);
  eq(importer.I.staged.filter((s) => s.dup).length, 1, '应该识别出 1 张重复');
  importer.patchStaged(importer.I.staged.map((s) => s.id), { loc: Object.values(S.db.locations).find((l) => l.name === 'Bolsa Chica').id });
  eq(importer.startUpload(), 3);
  for (let i = 0; i < 400 && importer.uploadBusy(); i++) await sleep(50);
  eq(importer.I.queue.map((q) => q.status), ['done', 'done', 'done']);
  await settled();
  const p = store.index().photos.find((x) => x.name === 'IMG_1001.JPG');
  assert(p && p.orig && p.thumb && p.prev, '照片记录不完整');
  eq(mock.pathOf(mock.files.get(p.orig)), 'BirdLog/Photos/2026/2026-11-14 Bolsa Chica/IMG_1001.JPG');
  eq(mock.pathOf(mock.files.get(p.thumb)), `BirdLog/_app/thumbs/${p.id}_t.jpg`);
  eq(mock.pathOf(mock.files.get(p.prev)), `BirdLog/_app/previews/${p.id}_p.jpg`);
  assert(await sameBytes(mock.files.get(p.orig).content, pick.find((f) => f.name === 'IMG_1001.JPG')), '原图应该和选中的文件完全一样');
  const raw = store.index().photos.find((x) => x.name === 'DSC09001.ARW');
  eq([raw.kind, raw.w, raw.h, raw.cam], ['raw', 2000, 3000, 'SONY ILCE-1']);
  const url = await store.thumbUrl(p);
  assert(url && url.startsWith('blob:'), '缩略图取不到');
  const r = await remoteDb();
  assert(r.photos[p.id] && r.photos[raw.id], 'Drive 上的记录里应该有新导入的照片');
});

await test('重新打开应用：先显示本地快照，再和 Drive 核对', async () => {
  const count = store.index().photos.length;
  await store.persist();
  const be2 = makeBackend();
  await be2.authorize();
  await store.startBackend(be2);
  eq(store.index().photos.length, count, '快照里的照片数应该和之前一样');
  await settled();
  eq(store.index().photos.length, count);
});

await test('删除照片：记录打删除标记，三个文件都进回收站', async () => {
  const p = store.index().photos.find((x) => x.name === 'IMG_0042.CR3');
  await store.deletePhotos([p.id]);
  await settled();
  for (const id of [p.orig, p.thumb, p.prev]) assert(mock.files.get(id).trashed, '文件应该在回收站');
  const r = await remoteDb();
  eq(r.photos[p.id].del, 1);
});

console.log('DRIVE LOG', mock.log.length, 'requests');
show();
