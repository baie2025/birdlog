// 看图器：全屏看一张照片，左右切换，旁边是这张照片的信息和操作。

import { html, useState, useEffect, useRef, useStore, Icon, SpeciesName, editSpecies, editLocation, editDate, removePhotos } from './ui.js';
import {
  S, notify, closeViewer, previewUrl, cachedThumbUrl, originalBlob, setCover, getRecord, setRecord, recKey,
  locName, toast,
} from './store.js';
import { taxon, family, CAT_LABEL } from './taxonomy.js';
import { fmtDate, fmtTime, fmtBytes, fmtExposure, dateOf, downloadBlob, mapsLink, fmtCoord } from './util.js';

/** 记录的数量和备注（同一天、同一地点、同一种鸟的照片共用） */
function RecordFields({ k }) {
  const rec = getRecord(k);
  const [count, setCount] = useState(rec.count != null ? String(rec.count) : '');
  const [note, setNote] = useState(rec.note || '');
  useEffect(() => {
    setCount(rec.count != null ? String(rec.count) : '');
    setNote(rec.note || '');
  }, [k, rec.m]);
  const commit = () => {
    const c = count.trim() === '' ? null : Math.max(0, parseInt(count, 10));
    const cur = getRecord(k);
    const sameCount = (c == null || isNaN(c) ? null : c) === (cur.count != null ? cur.count : null);
    if (sameCount && note.trim() === (cur.note || '')) return;
    setRecord(k, { count: c == null || isNaN(c) ? null : c, note: note.trim() });
  };
  return html`<div class="recfields">
    <label class="field inline"><span>数量</span>
      <input type="number" min="0" inputmode="numeric" value=${count} onInput=${(e) => setCount(e.target.value)} onBlur=${commit} placeholder="只" />
    </label>
    <label class="field"><span>备注</span>
      <textarea rows="3" value=${note} onInput=${(e) => setNote(e.target.value)} onBlur=${commit} placeholder="行为、羽色、天气……"></textarea>
    </label>
  </div>`;
}

const canShowOriginal = (p) => p.kind === 'image' || (!p.kind && /^image\/(jpeg|png|webp|gif|avif)$/.test(p.mime || ''));

export function Viewer() {
  useStore(() => (S.viewer ? `${S.viewer.i}/${S.viewer.ids.length}|${S.dbv}|${S.dialogs.length}` : ''));
  const v = S.viewer;
  const [img, setImg] = useState({ id: '', url: null, sharp: false });
  const [orig, setOrig] = useState({ id: '', url: null, loading: false });
  const [zoom, setZoom] = useState(false);
  const [info, setInfo] = useState(() => (typeof matchMedia === 'function' ? matchMedia('(min-width: 900px)').matches : true));
  const touch = useRef(null);

  // 看图过程中照片被删掉时，跳过它们
  const alive = v ? v.ids.filter((id) => S.db.photos[id] && !S.db.photos[id].del) : [];
  let i = 0;
  if (v) {
    const curId = v.ids[v.i];
    i = alive.indexOf(curId);
    if (i < 0) i = Math.min(v.i, alive.length - 1);
  }
  const p = v && alive.length ? S.db.photos[alive[i]] : null;
  const pid = p ? p.id : '';

  useEffect(() => {
    if (v && !alive.length) closeViewer();
  }, [v, alive.length]);

  useEffect(() => {
    if (!p) return undefined;
    let live = true;
    setZoom(false);
    setImg({ id: p.id, url: cachedThumbUrl(p), sharp: false });
    previewUrl(p).then((u) => { if (live && u) setImg({ id: p.id, url: u, sharp: true }); }).catch(() => {});
    // 顺手把前后两张取好，翻页时不用等
    for (const d of [1, -1]) {
      const q = S.db.photos[alive[i + d]];
      if (q) previewUrl(q).catch(() => {});
    }
    return () => { live = false; };
  }, [pid]);

  useEffect(() => () => { if (orig.url) URL.revokeObjectURL(orig.url); }, [orig.url]);
  useEffect(() => { setOrig({ id: '', url: null, loading: false }); }, [pid]);

  const go = (d) => {
    if (!v) return;
    const n = i + d;
    if (n < 0 || n >= alive.length) return;
    S.viewer = { ids: alive, i: n };
    notify();
  };

  useEffect(() => {
    if (!v) return undefined;
    const onKey = (e) => {
      if (S.dialogs.length) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') closeViewer();
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'i' || e.key === 'I') setInfo((x) => !x);
    };
    window.addEventListener('keydown', onKey);
    document.documentElement.classList.add('noscroll');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.documentElement.classList.remove('noscroll');
    };
  });

  if (!v || !p) return null;

  const t = taxon(p.sp);
  const fam = family(t);
  const key = recKey(p);
  const be = S.backend;
  const driveLink = be.fileLink(p.orig);
  const shownUrl = orig.id === p.id && orig.url ? orig.url : (img.id === p.id ? img.url : null);

  const loadOriginal = async (download) => {
    if (orig.loading) return;
    setOrig({ id: p.id, url: null, loading: true });
    try {
      const blob = await originalBlob(p);
      if (download || !canShowOriginal(p)) {
        downloadBlob(blob, p.name || 'photo');
        setOrig({ id: '', url: null, loading: false });
      } else {
        setOrig({ id: p.id, url: URL.createObjectURL(blob), loading: false });
        setZoom(true);
      }
    } catch (e) {
      setOrig({ id: '', url: null, loading: false });
      toast('取原图失败：' + (e.message || e), 'error');
    }
  };

  const onTouchStart = (e) => {
    if (e.touches.length !== 1) { touch.current = null; return; }
    touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };
  const onTouchEnd = (e) => {
    const s = touch.current;
    touch.current = null;
    if (!s || zoom) return;
    if (window.visualViewport && window.visualViewport.scale > 1.05) return; // 放大着的时候是在拖动画面
    const dx = e.changedTouches[0].clientX - s.x;
    const dy = e.changedTouches[0].clientY - s.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
  };

  const camera = [p.cam, p.lens].filter(Boolean).join(' · ');
  const exposure = [p.fl ? Math.round(p.fl) + 'mm' : '', p.fn ? 'f/' + (Math.round(p.fn * 10) / 10) : '', fmtExposure(p.ex), p.iso ? 'ISO ' + p.iso : ''].filter(Boolean).join(' · ');

  return html`<div class=${'viewer' + (info ? ' with-info' : '')} role="dialog" aria-modal="true" aria-label="查看照片">
    <div class="v-main">
      <div class="v-top">
        <button type="button" class="iconbtn light" onClick=${() => closeViewer()} aria-label="关闭"><${Icon} name="close" /></button>
        <div class="v-title">
          <div class="v-title-main">${t ? t.zh || t.en : (p.sp || '未识别')}</div>
          <div class="v-title-sub">${[fmtDate(dateOf(p.t)), fmtTime(p.t), locName(p.loc)].filter(Boolean).join(' · ')}</div>
        </div>
        <span class="v-count">${i + 1} / ${alive.length}</span>
        ${p.sp ? html`<button type="button" class=${'iconbtn light' + (p.cover ? ' active' : '')} onClick=${() => { setCover(p.id); toast(p.cover ? '已取消封面' : '已设为这个鸟种的封面'); }}
          title=${p.cover ? '取消封面' : '设为这个鸟种的封面'} aria-label="设为封面"><${Icon} name="star" fill=${!!p.cover} /></button>` : null}
        <button type="button" class=${'iconbtn light' + (info ? ' active' : '')} onClick=${() => setInfo(!info)} title="照片信息" aria-label="照片信息"><${Icon} name="info" /></button>
      </div>
      <div class=${'v-stage' + (zoom ? ' zoomed' : '')} onTouchStart=${onTouchStart} onTouchEnd=${onTouchEnd}
          onClick=${(e) => { if (e.target.tagName === 'IMG') setZoom(!zoom); }}>
        ${shownUrl
          ? html`<img key=${p.id + (orig.url ? 'o' : '')} src=${shownUrl} alt=${t ? t.en : ''} class=${img.sharp || orig.url ? '' : 'blurry'} draggable=${false} />`
          : html`<div class="v-noimg">
              <${Icon} name="image" size=${40} />
              <div>${p.prev || p.thumb ? '正在载入…' : '这个文件没有可显示的预览图，可以下载原图查看'}</div>
            </div>`}
        ${orig.loading ? html`<div class="v-loading"><span class="spinner"></span>正在取原图（${fmtBytes(p.size)}）…</div>` : null}
      </div>
      ${i > 0 ? html`<button type="button" class="v-nav prev" onClick=${() => go(-1)} aria-label="上一张"><${Icon} name="left" size=${26} /></button>` : null}
      ${i < alive.length - 1 ? html`<button type="button" class="v-nav next" onClick=${() => go(1)} aria-label="下一张"><${Icon} name="right" size=${26} /></button>` : null}
    </div>

    ${info ? html`<aside class="v-info">
      <button type="button" class="iconbtn v-info-close" onClick=${() => setInfo(false)} aria-label="收起信息"><${Icon} name="close" /></button>
      <section class="v-block">
        <div class="v-label">鸟种</div>
        <button type="button" class="v-edit" onClick=${() => editSpecies([p.id])}>
          <span class="v-edit-main"><${SpeciesName} code=${p.sp} sci=${true} /></span>
          <${Icon} name="edit" size=${16} />
        </button>
        ${t ? html`<div class="v-small">${fam ? fam.en : ''}${CAT_LABEL[t.cat] ? ` · ${CAT_LABEL[t.cat]}` : ''}
          ${p.sp ? html` · <a href=${'#/sp/' + encodeURIComponent(p.sp)} onClick=${() => closeViewer()}>看这个鸟种的全部照片</a>` : null}</div>` : null}
      </section>
      <section class="v-block">
        <div class="v-label">拍摄时间</div>
        <button type="button" class="v-edit" onClick=${() => editDate([p.id])}>
          <span class="v-edit-main">${fmtDate(dateOf(p.t))} ${p.t ? p.t.slice(11, 19) : ''}</span>
          <${Icon} name="edit" size=${16} />
        </button>
        ${p.tSrc === 'file' ? html`<div class="v-small warn">照片里没有拍摄时间，这里用的是文件的修改时间，可能不准。</div>` : null}
      </section>
      <section class="v-block">
        <div class="v-label">地点</div>
        <button type="button" class="v-edit" onClick=${() => editLocation([p.id])}>
          <span class=${'v-edit-main' + (locName(p.loc) ? '' : ' unknown')}>${locName(p.loc) || '未设地点'}</span>
          <${Icon} name="edit" size=${16} />
        </button>
        ${p.lat != null ? html`<div class="v-small">照片自带位置：<a href=${mapsLink(p.lat, p.lng)} target="_blank" rel="noopener">${fmtCoord(p.lat, p.lng)}</a></div>` : null}
      </section>
      <section class="v-block">
        <div class="v-label">这条记录 <span class="v-label-note">同一天、同一地点、同一种鸟共用</span></div>
        <${RecordFields} k=${key} />
      </section>
      <section class="v-block">
        <div class="v-label">照片</div>
        ${camera ? html`<div class="v-line">${camera}</div>` : null}
        ${exposure ? html`<div class="v-line">${exposure}</div>` : null}
        <div class="v-line v-file">${p.name} · ${fmtBytes(p.size)}${p.w ? ` · ${p.w}×${p.h}` : ''}${p.kind === 'raw' ? ' · RAW' : ''}</div>
        ${p.kind === 'raw' ? html`<div class="v-small">显示的是 RAW 文件里内嵌的预览图。</div>` : null}
      </section>
      <section class="v-actions">
        ${canShowOriginal(p) ? html`<button type="button" class="btn" disabled=${orig.loading || (orig.id === p.id && !!orig.url)} onClick=${() => loadOriginal(false)}>
          <${Icon} name="image" size=${16} />${orig.id === p.id && orig.url ? '正在显示原图' : '查看原图'}</button>` : null}
        <button type="button" class="btn" disabled=${orig.loading} onClick=${() => loadOriginal(true)}><${Icon} name="download" size=${16} />下载原图</button>
        ${driveLink ? html`<a class="btn" href=${driveLink} target="_blank" rel="noopener"><${Icon} name="external" size=${16} />在 Drive 里打开</a>` : null}
        <button type="button" class="btn danger-ghost" onClick=${() => removePhotos([p.id])}><${Icon} name="trash" size=${16} />删除</button>
      </section>
    </aside>` : null}
  </div>`;
}
