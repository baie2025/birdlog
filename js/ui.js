// 公共界面部件：图标、缩略图、照片格子、对话框、鸟种和地点选择器。

import { html, render, useState, useEffect, useRef, useMemo, useCallback } from '../vendor/htm-preact.js';
import {
  S, subscribe, index, thumbUrl, cachedThumbUrl, openDialog, toast, patchPhotos, deletePhotos,
  saveLocation, recentSpecies, noteSpeciesUsed, locName,
} from './store.js';
import { searchTaxa, taxon, taxonomyReady, CAT_LABEL } from './taxonomy.js';
import { haversineKm, fmtCoord, mapsLink, dateOf } from './util.js';

export { html, render, useState, useEffect, useRef, useMemo, useCallback };

/** 订阅数据中心。给了 pick 函数时，只有它的返回值变了才重画，避免无关的刷新。 */
export function useStore(pick) {
  const [, force] = useState(0);
  const last = useRef();
  if (pick) last.current = pick();
  useEffect(() => {
    const check = () => {
      if (!pick) { force((x) => x + 1); return; }
      const v = pick();
      if (v !== last.current) { last.current = v; force((x) => x + 1); }
    };
    const stop = subscribe(check);
    check(); // 画完到开始订阅之间数据可能已经变了，补查一次
    return stop;
  }, []);
  return S;
}

const ICONS = {
  calendar: 'M7 3v3M17 3v3M4 9.5h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
  pin: 'M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  bird: 'M22 8.5l-3.2-1.2a3.6 3.6 0 0 0-6.9 1.9C9 10 6.500 12.500 5 15.500L2.500 18.500 7 18c2 2 5.500 2.500 8 1 2.500-1.500 3.800-4.500 3.700-8.200L22 8.500zM16 8.300h.010M11 20.200v2.300M14 19.600v2.900',
  plus: 'M12 5v14M5 12h14',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  left: 'M15 5l-7 7 7 7',
  right: 'M9 5l7 7-7 7',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L3.500 9.700l5.900-.900L12 3.500z',
  download: 'M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.500h14',
  upload: 'M12 16V5M7.5 9.5L12 5l4.5 4.5M5 19.500h14',
  trash: 'M4 7h16M9 7V4.500h6V7M6.500 7l.800 12.500h9.400L17.500 7M10 11v5M14 11v5',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM13.500 6.500l4 4',
  cloud: 'M7 18a4.500 4.500 0 0 1-.600-8.960A6 6 0 0 1 18 10.500a3.750 3.750 0 0 1 0 7.500H7z',
  refresh: 'M20 11a8 8 0 0 0-14.500-4.500L4 8M4 4v4h4M4 13a8 8 0 0 0 14.500 4.500L20 16M20 20v-4h-4',
  external: 'M14 5h5v5M19 5l-8 8M11 6H6a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-5',
  image: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM3 16l5-5 4 4 3-3 6 6M15.500 9.500h.010',
  select: 'M9 11.500l2.500 2.500L16 9.500M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z',
  sort: 'M7 5v14M3.500 15.500L7 19l3.500-3.500M17 19V5M13.500 8.500L17 5l3.500 3.500',
  stack: 'M4 8l8-4 8 4-8 4-8-4zM4 12l8 4 8-4M4 16l8 4 8-4',
  warn: 'M12 4l9 15.500H3L12 4zM12 10v4.500M12 17h.01',
};

export function Icon({ name, size = 20, fill = false }) {
  return html`<svg class="icon" width=${size} height=${size} viewBox="0 0 24 24" fill=${fill ? 'currentColor' : 'none'}
    stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${ICONS[name] || ''} /></svg>`;
}

// 所有缩略图共用一个「进入视野才加载」的观察器
const thumbWatchers = new WeakMap();
let thumbObserver = null;
function watchThumb(el, fn) {
  if (!('IntersectionObserver' in window)) { fn(); return () => {}; }
  if (!thumbObserver) {
    thumbObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const f = thumbWatchers.get(e.target);
        thumbObserver.unobserve(e.target);
        thumbWatchers.delete(e.target);
        if (f) f();
      }
    }, { rootMargin: '500px 0px' });
  }
  thumbWatchers.set(el, fn);
  thumbObserver.observe(el);
  return () => { thumbWatchers.delete(el); thumbObserver.unobserve(el); };
}

/** 一张缩略图。给 photo（资料库里的照片）或 src（现成的图片地址）。 */
export function Thumb({ photo, src }) {
  const ref = useRef(null);
  const pid = photo ? photo.id : '';
  const tid = photo ? photo.thumb : '';
  const [state, setState] = useState(() => ({ url: src || (photo ? cachedThumbUrl(photo) : null), failed: false }));
  useEffect(() => {
    if (src) { setState({ url: src, failed: false }); return undefined; }
    if (!photo) { setState({ url: null, failed: true }); return undefined; }
    const have = cachedThumbUrl(photo);
    if (have) { setState({ url: have, failed: false }); return undefined; }
    if (!photo.thumb) { setState({ url: null, failed: true }); return undefined; }
    setState({ url: null, failed: false });
    let live = true;
    const stop = watchThumb(ref.current, () => {
      thumbUrl(photo).then(
        (u) => { if (live) setState({ url: u, failed: !u }); },
        () => { if (live) setState({ url: null, failed: true }); },
      );
    });
    return () => { live = false; stop(); };
  }, [pid, tid, src]);
  return html`<div class="thumb" ref=${ref}>
    ${state.url
      ? html`<img src=${state.url} alt="" draggable=${false} />`
      : html`<div class=${'thumb-ph' + (state.failed ? ' failed' : '')}>${state.failed ? html`<${Icon} name="image" size=${24} />` : null}</div>`}
  </div>`;
}

/** 照片格子里的一格 */
export function Tile({ photo, src, label, muted, badge, corner, selected, selecting, onClick, busy, title }) {
  return html`<button type="button" class=${'tile' + (selected ? ' sel' : '') + (selecting ? ' selecting' : '') + (busy ? ' busy' : '')}
      onClick=${onClick} title=${title || label || ''}>
    <${Thumb} photo=${photo} src=${src} />
    ${corner ? html`<span class="tile-corner">${corner}</span>` : null}
    ${badge ? html`<span class="tile-badge">${badge}</span>` : null}
    ${selecting ? html`<span class="tile-check">${selected ? html`<${Icon} name="check" size=${16} />` : null}</span>` : null}
    ${busy ? html`<span class="tile-spin"><span class="spinner"></span></span>` : null}
    ${label ? html`<span class=${'tile-cap' + (muted ? ' muted' : '')}>${label}</span>` : null}
  </button>`;
}

export function Empty({ icon = 'bird', title, children }) {
  return html`<div class="empty">
    <div class="empty-icon"><${Icon} name=${icon} size=${34} /></div>
    <div class="empty-title">${title}</div>
    ${children ? html`<div class="empty-body">${children}</div>` : null}
  </div>`;
}

// ---------- 对话框 ----------

export function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return html`<div class="overlay" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class=${'modal' + (wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label=${title}>
      <header class="modal-h">
        <h2>${title}</h2>
        <button type="button" class="iconbtn" onClick=${onClose} aria-label="关闭"><${Icon} name="close" /></button>
      </header>
      <div class="modal-b">${children}</div>
      ${footer ? html`<footer class="modal-f">${footer}</footer>` : null}
    </div>
  </div>`;
}

export function DialogHost() {
  useStore(() => S.dialogs);
  return S.dialogs.map((d) => html`<${d.component} key=${d.id} ...${d.props} close=${d.close} />`);
}

export function Toasts() {
  useStore(() => S.toasts);
  return html`<div class="toasts" aria-live="polite">
    ${S.toasts.map((t) => html`<div key=${t.id} class=${'toast ' + t.kind}>${t.text}</div>`)}
  </div>`;
}

export function ConfirmDialog({ title, message, okLabel = '确定', danger, close }) {
  return html`<${Modal} title=${title} onClose=${() => close(false)}
    footer=${html`
      <button type="button" class="btn" onClick=${() => close(false)}>取消</button>
      <button type="button" class=${'btn ' + (danger ? 'danger' : 'primary')} onClick=${() => close(true)}>${okLabel}</button>`}>
    <p class="dialog-text">${message}</p>
  <//>`;
}

export const confirm = (props) => openDialog(ConfirmDialog, props);

/** 鸟种名的标准显示：中文名 + 英文名 */
export function SpeciesName({ code, sci = false }) {
  const t = taxon(code);
  if (!code) return html`<span class="spname unknown">未识别</span>`;
  if (!t) return html`<span class="spname">${code}</span>`;
  return html`<span class="spname">
    <span class="zh">${t.zh || t.en}</span>
    ${t.zh ? html`<span class="en">${t.en}</span>` : null}
    ${sci ? html`<span class="sci">${t.sci}</span>` : null}
  </span>`;
}

export function SpeciesPicker({ current, count, close }) {
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const mine = useMemo(() => new Set(index().byGroup.keys()), []);
  const boost = useMemo(() => new Set([...recentSpecies(), ...mine]), []);
  const results = useMemo(() => {
    if (q.trim()) return searchTaxa(q, { limit: 60, boost });
    return recentSpecies().map(taxon).filter(Boolean);
  }, [q]);
  useEffect(() => { setHi(0); }, [q]);
  useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);
  useEffect(() => {
    const el = listRef.current && listRef.current.querySelector('.hi');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [hi]);
  const pick = (t) => { noteSpeciesUsed(t.code); close(t.code); };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(results.length - 1, h + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
    else if (e.key === 'Enter' && results[hi]) { e.preventDefault(); pick(results[hi]); }
  };
  const title = count > 1 ? `标注鸟种（${count} 张）` : '标注鸟种';
  return html`<${Modal} title=${title} onClose=${() => close(undefined)}
    footer=${html`<button type="button" class="btn" onClick=${() => close('')}>设为未识别</button>`}>
    <div class="searchbox">
      <${Icon} name="search" size=${18} />
      <input ref=${inputRef} type="text" value=${q} onInput=${(e) => setQ(e.target.value)} onKeyDown=${onKey}
        placeholder="中文名、英文名、学名或四字母代码" autocomplete="off" autocapitalize="off" spellcheck=${false} />
    </div>
    ${!taxonomyReady() ? html`<p class="hint">鸟种名录还没加载好，请稍等或检查网络。</p>` : null}
    ${!q.trim() && results.length ? html`<div class="picklist-h">最近用过</div>` : null}
    ${!q.trim() && !results.length && taxonomyReady()
      ? html`<p class="hint">输入名字开始搜索。英文名可以只打每个词的开头，比如 “red tai haw”；也可以用四字母代码，比如 “NOCA”。</p>` : null}
    ${q.trim() && !results.length && taxonomyReady() ? html`<p class="hint">没有找到匹配的鸟种。</p>` : null}
    <ul class="picklist" ref=${listRef}>
      ${results.map((t, i) => html`<li key=${t.code}>
        <button type="button" class=${'pickrow' + (i === hi ? ' hi' : '') + (t.code === current ? ' current' : '')}
            onClick=${() => pick(t)} onMouseMove=${() => { if (hi !== i) setHi(i); }}>
          <span class="pickrow-main">
            <span class="zh">${t.zh || t.en}</span>
            ${t.zh ? html`<span class="en">${t.en}</span>` : null}
          </span>
          <span class="pickrow-sub">
            <span class="sci">${t.sci}</span>
            ${CAT_LABEL[t.cat] ? html`<span class="tag">${CAT_LABEL[t.cat]}</span>` : null}
            ${mine.has(t.code) ? html`<span class="tag ok">已拍</span>` : null}
          </span>
        </button>
      </li>`)}
    </ul>
  <//>`;
}

function parseCoord(text) {
  const m = String(text || '').trim().match(/^(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/**
 * 在地图数据里搜地名（公园、保护区、城镇…）。用的是 Photon，一个基于 OpenStreetMap 的免费地名搜索服务，
 * 不需要账号。只会把输入的文字（以及照片自带的位置，用来把附近的结果排前面）发给它。
 */
async function searchPlaces(q, gps, signal) {
  let url = 'https://photon.komoot.io/api/?limit=8&lang=en&q=' + encodeURIComponent(q);
  if (gps) url += `&lat=${gps.lat.toFixed(3)}&lon=${gps.lng.toFixed(3)}`;
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error('地名搜索失败');
  const seen = new Set();
  const out = [];
  for (const f of (await r.json()).features || []) {
    const p = f.properties || {};
    const c = f.geometry && f.geometry.coordinates;
    if (!p.name || !c) continue;
    const where = [p.city || p.county, p.state, p.country].filter((x) => x && x !== p.name).join(', ');
    const key = p.name + '|' + where;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: p.name, where, lat: c[1], lng: c[0] });
  }
  return out;
}

/** 选地点。gps 是所选照片自带的位置（有的话），用来按距离排序和给新地点填坐标。 */
export function LocationPicker({ current, gps, count, close }) {
  const [q, setQ] = useState('');
  const inputRef = useRef(null);
  const ix = index();
  useEffect(() => { if (inputRef.current && !('ontouchstart' in window)) inputRef.current.focus(); }, []);
  const rows = useMemo(() => {
    const list = ix.locs.map((l) => {
      const ps = ix.byLoc.get(l.id) || [];
      return {
        l,
        n: ps.length,
        last: ps.length ? dateOf(ps[0].t) : '',
        dist: gps && l.lat != null ? haversineKm(gps.lat, gps.lng, l.lat, l.lng) : null,
      };
    });
    const needle = q.trim().toLowerCase();
    const shown = needle ? list.filter((r) => r.l.name.toLowerCase().includes(needle)) : list;
    shown.sort((a, b) => {
      if (a.dist != null || b.dist != null) return (a.dist ?? 1e9) - (b.dist ?? 1e9);
      return b.last.localeCompare(a.last) || a.l.name.localeCompare(b.l.name, 'zh');
    });
    return shown;
  }, [q, ix]);
  // 输入停顿一下之后，再去地图数据里搜
  const [found, setFound] = useState({ q: '', list: [], state: 'idle' });
  useEffect(() => {
    const text = q.trim();
    if (text.length < 3) { setFound({ q: '', list: [], state: 'idle' }); return undefined; }
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      setFound((f) => ({ ...f, state: 'loading' }));
      searchPlaces(text, gps, ctl.signal).then(
        (list) => setFound({ q: text, list, state: 'done' }),
        (e) => { if (e.name !== 'AbortError') setFound({ q: text, list: [], state: 'error' }); },
      );
    }, 450);
    return () => { clearTimeout(timer); ctl.abort(); };
  }, [q]);
  const pickFound = (r) => {
    const same = ix.locs.find((l) => l.name.toLowerCase() === r.name.toLowerCase());
    close(same ? same.id : saveLocation({ name: r.name, lat: r.lat, lng: r.lng }));
  };
  const name = q.trim();
  const exact = name && ix.locs.some((l) => l.name.toLowerCase() === name.toLowerCase());
  const create = () => {
    const id = saveLocation({ name, lat: gps ? gps.lat : undefined, lng: gps ? gps.lng : undefined });
    close(id);
  };
  const title = count > 1 ? `设置地点（${count} 张）` : '设置地点';
  return html`<${Modal} title=${title} onClose=${() => close(undefined)}
    footer=${html`<button type="button" class="btn" onClick=${() => close('')}>不设地点</button>`}>
    <div class="searchbox">
      <${Icon} name="pin" size=${18} />
      <input ref=${inputRef} type="text" value=${q} onInput=${(e) => setQ(e.target.value)}
        onKeyDown=${(e) => { if (e.key === 'Enter' && name) { e.preventDefault(); if (!exact) create(); else close(ix.locs.find((l) => l.name.toLowerCase() === name.toLowerCase()).id); } }}
        placeholder="搜索地点，或输入新地点的名字" autocomplete="off" />
    </div>
    ${gps ? html`<p class="hint">照片自带位置 ${fmtCoord(gps.lat, gps.lng)}，已按距离排序。</p>` : null}
    <ul class="picklist">
      ${name && !exact ? html`<li><button type="button" class="pickrow create" onClick=${create}>
        <span class="pickrow-main"><${Icon} name="plus" size=${16} /> 新建地点「${name}」</span>
        ${gps ? html`<span class="pickrow-sub">会记下照片自带的位置</span>` : null}
      </button></li>` : null}
      ${rows.map((r) => html`<li key=${r.l.id}>
        <button type="button" class=${'pickrow' + (r.l.id === current ? ' current' : '')} onClick=${() => close(r.l.id)}>
          <span class="pickrow-main"><span class="zh">${r.l.name}</span></span>
          <span class="pickrow-sub">
            ${r.n ? `${r.n} 张` : '还没有照片'}${r.last ? ` · 最近 ${r.last}` : ''}${r.dist != null ? ` · 距离 ${r.dist < 1 ? Math.round(r.dist * 1000) + ' 米' : r.dist.toFixed(1) + ' 公里'}` : ''}
          </span>
        </button>
      </li>`)}
    </ul>
    ${!rows.length && !name ? html`<p class="hint">还没有地点。输入名字就能新建，也可以从地图搜索结果里选，比如公园或保护区的名字。</p>` : null}
    ${name.length >= 3 ? html`
      <div class="picklist-h">地图上的地点${found.state === 'loading' ? '（正在搜索…）' : ''}</div>
      ${found.state === 'error' ? html`<p class="hint">地名搜索暂时连不上，可以直接用上面的「新建地点」。</p>` : null}
      ${found.state === 'done' && !found.list.length ? html`<p class="hint">地图里没有找到「${found.q}」。</p>` : null}
      <ul class="picklist">
        ${found.list.map((r) => html`<li key=${r.name + r.lat}>
          <button type="button" class="pickrow" onClick=${() => pickFound(r)}>
            <span class="pickrow-main"><span class="zh">${r.name}</span></span>
            <span class="pickrow-sub">${r.where}${gps ? ` · 距离照片位置 ${haversineKm(gps.lat, gps.lng, r.lat, r.lng).toFixed(1)} 公里` : ''}</span>
          </button>
        </li>`)}
      </ul>
      <p class="hint">地名来自 OpenStreetMap（通过 Photon 搜索）。选中后会连同坐标一起存成你的地点。</p>` : null}
  <//>`;
}

/** 新建或修改一个地点的名字和坐标 */
export function LocationEditDialog({ loc, close }) {
  const [name, setName] = useState(loc ? loc.name : '');
  const [coord, setCoord] = useState(loc && loc.lat != null ? `${loc.lat}, ${loc.lng}` : '');
  const parsed = coord.trim() ? parseCoord(coord) : null;
  const bad = coord.trim() && !parsed;
  const save = () => {
    if (!name.trim() || bad) return;
    const id = saveLocation({ id: loc ? loc.id : undefined, name: name.trim(), lat: parsed ? parsed.lat : null, lng: parsed ? parsed.lng : null });
    close(id);
  };
  return html`<${Modal} title=${loc ? '修改地点' : '新建地点'} onClose=${() => close(undefined)}
    footer=${html`
      <button type="button" class="btn" onClick=${() => close(undefined)}>取消</button>
      <button type="button" class="btn primary" disabled=${!name.trim() || bad} onClick=${save}>保存</button>`}>
    <label class="field"><span>名称</span>
      <input type="text" value=${name} onInput=${(e) => setName(e.target.value)} placeholder="比如 Bolsa Chica Ecological Reserve" />
    </label>
    <label class="field"><span>坐标（可不填）</span>
      <input type="text" value=${coord} onInput=${(e) => setCoord(e.target.value)} placeholder="纬度, 经度，比如 33.6961, -118.0464" inputmode="text" />
    </label>
    ${bad ? html`<p class="hint error">坐标格式不对。请写成「纬度, 经度」，可以直接从 Google 地图里复制。</p>` : null}
    ${parsed ? html`<p class="hint"><a href=${mapsLink(parsed.lat, parsed.lng)} target="_blank" rel="noopener">在 Google 地图里查看这个位置</a></p>` : null}
  <//>`;
}

/** 改拍摄时间。一张照片时可以改到秒；多张时只改日期，各自的时刻保留。 */
export function DateDialog({ value, single, count, close }) {
  const [date, setDate] = useState(value ? value.slice(0, 10) : '');
  const [time, setTime] = useState(value && value.length >= 16 ? value.slice(11, 19) : '12:00:00');
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const save = () => {
    if (!ok) return;
    if (single) close({ t: `${date}T${time.length === 5 ? time + ':00' : time}` });
    else close({ dateOnly: date });
  };
  return html`<${Modal} title=${single ? '修改拍摄时间' : `修改拍摄日期（${count} 张）`} onClose=${() => close(undefined)}
    footer=${html`
      <button type="button" class="btn" onClick=${() => close(undefined)}>取消</button>
      <button type="button" class="btn primary" disabled=${!ok} onClick=${save}>保存</button>`}>
    <label class="field"><span>日期</span>
      <input type="date" value=${date} onInput=${(e) => setDate(e.target.value)} />
    </label>
    ${single ? html`<label class="field"><span>时间</span>
      <input type="time" step="1" value=${time} onInput=${(e) => setTime(e.target.value)} />
    </label>` : html`<p class="hint">只改日期，每张照片原来的时刻保持不变。</p>`}
  <//>`;
}

// ---------- 对照片的操作（看图器和多选栏共用） ----------

function averageGps(items) {
  const withGps = items.filter((p) => p && p.lat != null && p.lng != null);
  if (!withGps.length) return null;
  return {
    lat: withGps.reduce((s, p) => s + p.lat, 0) / withGps.length,
    lng: withGps.reduce((s, p) => s + p.lng, 0) / withGps.length,
  };
}

export const openDateDialog = (props) => openDialog(DateDialog, props);

export async function askSpecies(current, count = 1) {
  return openDialog(SpeciesPicker, { current, count });
}

export async function askLocation(current, items, count = 1) {
  return openDialog(LocationPicker, { current, gps: averageGps(items), count });
}

export async function editSpecies(ids) {
  const first = S.db.photos[ids[0]];
  const code = await askSpecies(ids.length === 1 && first ? first.sp : '', ids.length);
  if (code === undefined) return false;
  patchPhotos(ids, { sp: code });
  return true;
}

export async function editLocation(ids) {
  const items = ids.map((id) => S.db.photos[id]).filter(Boolean);
  const loc = await askLocation(ids.length === 1 && items[0] ? items[0].loc : '', items, ids.length);
  if (loc === undefined) return false;
  patchPhotos(ids, { loc });
  return true;
}

export async function editDate(ids) {
  const first = S.db.photos[ids[0]];
  const r = await openDialog(DateDialog, { value: first ? first.t : '', single: ids.length === 1, count: ids.length });
  if (!r) return false;
  patchPhotos(ids, r.t ? { t: r.t, tSrc: 'manual' } : { dateOnly: r.dateOnly });
  return true;
}

export async function removePhotos(ids) {
  const isDrive = S.backend && S.backend.kind === 'drive';
  const ok = await confirm({
    title: ids.length > 1 ? `删除 ${ids.length} 张照片？` : '删除这张照片？',
    message: isDrive
      ? '原图会移到 Google Drive 的回收站，30 天内可以在 Drive 里恢复；这里的记录会一起删除。'
      : '本地试用模式下删除后无法恢复。',
    okLabel: '删除',
    danger: true,
  });
  if (!ok) return false;
  await deletePhotos(ids);
  toast(ids.length > 1 ? `已删除 ${ids.length} 张照片` : '已删除');
  return true;
}

// ---------- 多选 ----------

export function useSelection() {
  const [active, setActive] = useState(false);
  const [ids, setIds] = useState(() => new Set());
  return {
    active,
    ids,
    start: () => setActive(true),
    stop: () => { setActive(false); setIds(new Set()); },
    toggle: (id) => setIds((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; }),
    setMany: (list, on) => setIds((prev) => { const n = new Set(prev); for (const id of list) { if (on) n.add(id); else n.delete(id); } return n; }),
    clear: () => setIds(new Set()),
  };
}

/** 多选时底部的操作栏 */
export function BatchBar({ sel }) {
  if (!sel.active) return null;
  const ids = [...sel.ids].filter((id) => S.db.photos[id] && !S.db.photos[id].del);
  const n = ids.length;
  const run = (fn, clear) => async () => {
    if (!n) return;
    const done = await fn(ids);
    if (done && clear) sel.stop();
  };
  return html`<div class="batchbar" role="toolbar" aria-label="批量操作">
    <span class="batch-n">${n ? `已选 ${n} 张` : '点照片来选择'}</span>
    <button type="button" class="btn sm" disabled=${!n} onClick=${run(editSpecies)}><${Icon} name="bird" size=${16} />标鸟种</button>
    <button type="button" class="btn sm" disabled=${!n} onClick=${run(editLocation)}><${Icon} name="pin" size=${16} />设地点</button>
    <button type="button" class="btn sm" disabled=${!n} onClick=${run(editDate)}><${Icon} name="calendar" size=${16} />改日期</button>
    <button type="button" class="btn sm danger-ghost" disabled=${!n} onClick=${run(removePhotos, true)}><${Icon} name="trash" size=${16} />删除</button>
    <button type="button" class="btn sm primary" onClick=${sel.stop}>完成</button>
  </div>`;
}

export { locName };
