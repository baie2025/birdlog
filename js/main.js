// 入口：启动、页面切换、整体框架。

import { html, render, useState, useEffect, useStore, Icon, DialogHost, Toasts } from './ui.js';
import { S, notify, startBackend, savedKind, sync, syncIfStale, reconnect, closeViewer, toast, index, persist } from './store.js';
import { loadTaxonomy } from './taxonomy.js';
import { DriveBackend, preloadGoogle } from './backend-drive.js';
import { LocalBackend } from './backend-local.js';
import { TimelineView, SpeciesView, SpeciesDetailView, PlacesView, PlaceDetailView, MoreView, countSpecies } from './views.js';
import { ImportView } from './import-view.js';
import { Viewer } from './viewer.js';
import { I, addFiles, queueStats, uploadBusy } from './importer.js';

const CONFIG = window.BIRDLOG_CONFIG || {};
const CLIENT_ID = (CONFIG.googleClientId || '').trim();

function makeDrive() {
  return new DriveBackend(CLIENT_ID, {
    onAuthNeeded: (need) => { if (S.needAuth !== need) { S.needAuth = need; notify(); } },
  });
}

// ---------- 页面切换（地址栏 # 后面的部分） ----------

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = h.split('?');
  const [name = '', id = ''] = path.split('/');
  let decoded = id;
  try { decoded = decodeURIComponent(id); } catch { /* 原样使用 */ }
  return { name: name || 'timeline', id: decoded, params: new URLSearchParams(query), hash: location.hash || '#/' };
}

// 返回上一页时回到原来的滚动位置；点链接去新页面时回到顶部
const scrollPos = new Map();
let currentHash = location.hash || '#/';
let linkNav = false;
try { history.scrollRestoration = 'manual'; } catch { /* 忽略 */ }
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href^="#"]');
  if (a) linkNav = true;
}, true);
window.addEventListener('scroll', () => { scrollPos.set(currentHash, window.scrollY); }, { passive: true });

function useRoute() {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const onChange = () => {
      const r = parseHash();
      const back = !linkNav;
      linkNav = false;
      currentHash = r.hash;
      setRoute(r);
      const y = back ? scrollPos.get(r.hash) || 0 : 0;
      // 等新页面画出来之后再滚动（不用 requestAnimationFrame，页面在后台时它不会触发）
      const apply = () => { if (currentHash === r.hash) window.scrollTo(0, y); };
      setTimeout(apply, 0);
      setTimeout(apply, 80);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

// ---------- 框架 ----------

const NAV = [
  ['timeline', '#/', '时间线', 'calendar'],
  ['species', '#/species', '鸟种', 'bird'],
  ['places', '#/places', '地点', 'pin'],
  ['more', '#/more', '更多', 'more'],
];
const sectionOf = (name) => ({ sp: 'species', place: 'places' }[name] || name);

function Summary() {
  useStore(() => S.dbv);
  const ix = index();
  return html`<div class="side-summary">
    <div><b>${countSpecies(ix.photos)}</b><span>种</span></div>
    <div><b>${ix.photos.length}</b><span>张</span></div>
    <div><b>${ix.locs.length}</b><span>地点</span></div>
  </div>`;
}

function SyncLine() {
  useStore(() => [S.sync.state, S.needAuth, S.dirty, S.user && S.user.email].join('|'));
  const isDrive = S.backend && S.backend.kind === 'drive';
  let text = '已同步', cls = 'ok';
  if (!isDrive) { text = '本地试用'; cls = 'local'; }
  else if (S.needAuth) { text = '需要重新连接'; cls = 'warn'; }
  else if (S.sync.state === 'syncing') { text = '正在同步…'; cls = 'busy'; }
  else if (S.sync.state === 'offline') { text = '离线'; cls = 'warn'; }
  else if (S.sync.state === 'error') { text = '同步出错'; cls = 'warn'; }
  else if (S.dirty) { text = '有修改待上传'; cls = 'busy'; }
  return html`<a class=${'syncline ' + cls} href="#/more" title=${S.user && S.user.email ? S.user.email : ''}>
    <span class="dot"></span><span>${text}</span>
  </a>`;
}

function Sidebar({ route }) {
  const cur = sectionOf(route.name);
  return html`<aside class="side">
    <a class="brand" href="#/">
      <img src="./icons/icon.svg" alt="" width="34" height="34" />
      <span><b>BirdLog</b><small>观鸟记录</small></span>
    </a>
    <a class=${'btn primary side-import' + (cur === 'import' ? ' on' : '')} href="#/import"><${Icon} name="plus" size=${18} />导入照片</a>
    <nav class="side-nav">
      ${NAV.map(([name, href, label, icon]) => html`<a key=${name} class=${cur === name ? 'on' : ''} href=${href}>
        <${Icon} name=${icon} />${label}
      </a>`)}
    </nav>
    <div class="side-foot">
      <${Summary} />
      <${SyncLine} />
    </div>
  </aside>`;
}

function TabBar({ route }) {
  const cur = sectionOf(route.name);
  const item = ([name, href, label, icon]) => html`<a key=${name} class=${cur === name ? 'on' : ''} href=${href}>
    <${Icon} name=${icon} size=${22} /><span>${label}</span>
  </a>`;
  return html`<nav class="tabbar" aria-label="主导航">
    ${NAV.slice(0, 2).map(item)}
    <a class=${'tab-import' + (cur === 'import' ? ' on' : '')} href="#/import" aria-label="导入照片"><${Icon} name="plus" size=${26} /></a>
    ${NAV.slice(2).map(item)}
  </nav>`;
}

function Banner() {
  useStore(() => [S.needAuth, S.sync.state, S.sync.error].join('|'));
  const [busy, setBusy] = useState(false);
  if (!S.backend || S.backend.kind !== 'drive') return null;
  const connect = async () => {
    setBusy(true);
    try { await reconnect(); toast('已重新连接 Google Drive'); }
    catch (e) { toast(e.message || '连接失败', 'error'); }
    finally { setBusy(false); }
  };
  if (S.needAuth) {
    return html`<div class="banner warn">
      <${Icon} name="cloud" size=${18} />
      <span>需要连接 Google Drive 才能同步和显示照片。Google 的授权大约一小时过期一次，过期后点一下就行。</span>
      <button type="button" class="btn sm primary" disabled=${busy} onClick=${connect}>${busy ? '正在连接…' : '连接 Google Drive'}</button>
    </div>`;
  }
  if (S.sync.state === 'error') {
    return html`<div class="banner warn">
      <${Icon} name="warn" size=${18} />
      <span>同步出错：${S.sync.error}</span>
      <button type="button" class="btn sm" onClick=${() => sync()}>重试</button>
    </div>`;
  }
  if (S.sync.state === 'offline') {
    return html`<div class="banner">
      <${Icon} name="cloud" size=${18} />
      <span>现在连不上网络。修改会先存在这台设备上，联网后自动同步。</span>
      <button type="button" class="btn sm" onClick=${() => sync()}>重试</button>
    </div>`;
  }
  return null;
}

/** 不在导入页时，角落里显示上传进度 */
function UploadDock({ route }) {
  useStore(() => I.v);
  if (route.name === 'import' || !I.queue.length) return null;
  const st = queueStats();
  if (!st.pending && !st.failed) return null;
  return html`<a class=${'dock' + (st.failed && !st.pending ? ' warn' : '')} href="#/import">
    <${Icon} name="upload" size=${18} />
    <span>${st.pending ? `正在上传，还有 ${st.pending} 张` : `${st.failed} 张上传失败`}</span>
    ${st.pending ? html`<span class="meter"><span style=${`width:${(st.ratio * 100).toFixed(1)}%`}></span></span>` : null}
  </a>`;
}

function Welcome() {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { if (CLIENT_ID) preloadGoogle().catch(() => {}); }, []);
  const useDrive = async () => {
    setError('');
    setBusy('drive');
    try {
      const be = makeDrive();
      await be.authorize();
      await startBackend(be);
    } catch (e) {
      setError(e.message || String(e));
      setBusy('');
    }
  };
  const useLocal = async () => {
    setError('');
    setBusy('local');
    try { await startBackend(new LocalBackend()); }
    catch (e) { setError(e.message || String(e)); setBusy(''); }
  };
  return html`<div class="welcome">
    <div class="welcome-card">
      <img src="./icons/icon.svg" alt="" width="72" height="72" />
      <h1>BirdLog</h1>
      <p class="welcome-lead">自己的观鸟照片记录。原图存在你自己的 Google Drive 里，按日期、地点、鸟种浏览。</p>
      <div class="welcome-actions">
        <button type="button" class="btn primary big" disabled=${!CLIENT_ID || !!busy} onClick=${useDrive}>
          <${Icon} name="cloud" size=${20} />${busy === 'drive' ? '正在连接…' : '连接 Google Drive'}
        </button>
        ${CLIENT_ID
          ? html`<p class="hint">会弹出 Google 的授权窗口。应用只能访问它自己创建的文件，看不到你 Drive 里的其他内容。</p>`
          : html`<p class="hint warn">还没有填写 Google 凭证，所以这个按钮暂时不能用。按 README.md 里的步骤创建凭证，把它填进 config.js 就可以了。</p>`}
        <button type="button" class="btn big" disabled=${!!busy} onClick=${useLocal}>${busy === 'local' ? '正在打开…' : '先在本地试用'}</button>
        <p class="hint">本地试用时照片只存在这个浏览器里，用来先看看界面合不合用。</p>
      </div>
      ${error ? html`<p class="hint error" role="alert">${error}</p>` : null}
    </div>
  </div>`;
}

function App() {
  useStore(() => S.phase);
  const route = useRoute();
  const [dragging, setDragging] = useState(false);

  // 在任何页面把文件拖进窗口，都直接进导入页
  useEffect(() => {
    const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
    const over = (e) => { if (hasFiles(e) && S.phase === 'ready') { e.preventDefault(); setDragging(true); } };
    const leave = (e) => { if (!e.relatedTarget) setDragging(false); };
    const drop = (e) => {
      setDragging(false);
      if (!hasFiles(e) || S.phase !== 'ready') return;
      e.preventDefault();
      if (e.target.closest && e.target.closest('.dropzone')) return; // 导入页自己的拖放区会处理
      addFiles(e.dataTransfer.files);
      if (parseHash().name !== 'import') location.hash = '#/import';
    };
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);

  if (S.phase === 'boot') return html`<div class="boot">正在打开…</div>`;
  if (S.phase === 'welcome') return html`<${Welcome} /><${Toasts} />`;

  let view;
  switch (route.name) {
    case 'species': view = html`<${SpeciesView} />`; break;
    case 'sp': view = html`<${SpeciesDetailView} key=${route.id} route=${route} />`; break;
    case 'places': view = html`<${PlacesView} />`; break;
    case 'place': view = html`<${PlaceDetailView} key=${route.id} route=${route} />`; break;
    case 'import': view = html`<${ImportView} />`; break;
    case 'more': view = html`<${MoreView} />`; break;
    default: view = html`<${TimelineView} key=${route.params.get('unk') || ''} route=${route} />`;
  }
  return html`<div class="shell">
    <${Sidebar} route=${route} />
    <main class="main">
      <${Banner} />
      ${view}
    </main>
    <${TabBar} route=${route} />
    <${UploadDock} route=${route} />
    <${Viewer} />
    <${DialogHost} />
    <${Toasts} />
    ${dragging ? html`<div class="dragveil"><${Icon} name="upload" size=${40} /><div>松开鼠标，导入这些照片</div></div>` : null}
  </div>`;
}

// ---------- 启动 ----------

async function boot() {
  render(html`<${App} />`, document.getElementById('app'));

  loadTaxonomy()
    .then(() => { S.taxonomy = true; S.dbv++; notify(); })
    .catch((e) => toast((e.message || '鸟种名录加载失败') + '，鸟种搜索暂时不能用', 'error'));

  const kind = savedKind();
  try {
    if (kind === 'drive' && CLIENT_ID) {
      preloadGoogle().catch(() => {});
      await startBackend(makeDrive());
    } else if (kind === 'local') {
      await startBackend(new LocalBackend());
    } else {
      S.phase = 'welcome';
    }
  } catch (e) {
    if (S.backend && S.phase !== 'ready') S.phase = 'ready';
    if (!S.backend) S.phase = 'welcome';
    toast('启动时出了问题：' + (e.message || e), 'error');
  }
  notify();
}

// 手机键盘弹出时可见区域会变小、还可能被系统往上推。把可见区域的位置和高度记成样式变量，
// 对话框据此只占键盘上方的部分，输入框就不会被顶出屏幕。
if (window.visualViewport) {
  const vv = window.visualViewport;
  const track = () => {
    const st = document.documentElement.style;
    st.setProperty('--vvt', vv.offsetTop + 'px');
    st.setProperty('--vvh', vv.height + 'px');
  };
  vv.addEventListener('resize', track);
  vv.addEventListener('scroll', track);
  track();
}

window.addEventListener('popstate',() => { if (S.viewer) closeViewer(true); });
window.addEventListener('online', () => sync());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncIfStale();
  else persist().catch(() => {});
});

// 离线也能打开应用（本机预览时不启用，免得改了代码看不到效果）
if ('serviceWorker' in navigator && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

// 调试和自测用
window.__birdlog = { S, I, addFiles, sync, index, uploadBusy };

boot();
