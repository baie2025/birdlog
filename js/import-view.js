// 导入页：选文件 → 在「待导入」区设地点、标鸟种 → 开始上传。

import { html, useState, useRef, useMemo, useStore, Icon, Tile, askSpecies, askLocation, openDateDialog } from './ui.js';
import { S, locName, toast } from './store.js';
import { I, addFiles, removeStaged, patchStaged, uploadable, startUpload, retryFailed, clearFinished, queueStats } from './importer.js';
import { ACCEPT } from './imaging.js';
import { Page } from './views.js';
import { spLabel } from './taxonomy.js';
import { dateOf, fmtDate, fmtBytes, push } from './util.js';

function groupStaged(list) {
  const m = new Map();
  for (const s of list) push(m, s.status === 'processing' ? '~' : dateOf(s.t), s);
  return [...m.keys()].sort().reverse().map((d) => ({ date: d, items: m.get(d).slice().sort((a, b) => (a.t || '').localeCompare(b.t || '') || a.name.localeCompare(b.name)) }));
}

function groupPlace(items) {
  const set = new Set(items.map((s) => s.loc || ''));
  if (set.size > 1) return { text: '多个地点', mixed: true };
  const id = [...set][0];
  return { text: id ? locName(id) : '未设地点', id, none: !id };
}

export function ImportView() {
  useStore(() => I.v + '|' + S.dbv);
  const [picked, setPicked] = useState(() => new Set());
  const [drag, setDrag] = useState(false);
  const fileRef = useRef(null);

  const staged = I.staged;
  const groups = useMemo(() => groupStaged(staged), [I.v]);
  const ready = uploadable();
  const dups = staged.filter((s) => s.dup);
  const errors = staged.filter((s) => s.status === 'error');
  const processing = staged.filter((s) => s.status === 'processing').length;
  const sel = [...picked].filter((id) => staged.some((s) => s.id === id && s.status === 'ready'));
  const stats = queueStats();

  const toggle = (id) => setPicked((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const setMany = (ids, on) => setPicked((prev) => { const n = new Set(prev); for (const id of ids) { if (on) n.add(id); else n.delete(id); } return n; });

  const pickFiles = (e) => {
    if (e.target.files && e.target.files.length) addFiles(e.target.files);
    e.target.value = '';
  };
  const onDrop = (e) => {
    e.preventDefault();
    setDrag(false);
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  };

  const setSpecies = async (ids) => {
    const code = await askSpecies('', ids.length);
    if (code === undefined) return;
    patchStaged(ids, { sp: code });
    setPicked(new Set());
  };
  const setPlace = async (ids, current) => {
    const items = staged.filter((s) => ids.includes(s.id)).map((s) => s.meta || {});
    const loc = await askLocation(current || '', items, ids.length);
    if (loc === undefined) return;
    patchStaged(ids, { loc });
  };
  const setDate = async (ids) => {
    const first = staged.find((s) => s.id === ids[0]);
    const r = await openDateDialog({ value: first ? first.t : '', single: ids.length === 1, count: ids.length });
    if (!r) return;
    patchStaged(ids, r.t ? { t: r.t, tSrc: 'manual' } : { dateOnly: r.dateOnly });
  };
  const begin = () => {
    const n = startUpload();
    setPicked(new Set());
    if (n) toast(`开始上传 ${n} 张照片，可以先去别的页面，上传会在后台继续`);
  };

  const readyIds = ready.map((s) => s.id);
  const unlabeled = ready.filter((s) => !s.sp).length;
  const unplaced = ready.filter((s) => !s.loc).length;

  return html`<${Page} title="导入照片" sub="原图原样保存，另外生成缩略图和预览图用来浏览">
    <div class=${'dropzone' + (drag ? ' over' : '')}
        onDragOver=${(e) => { e.preventDefault(); setDrag(true); }} onDragLeave=${() => setDrag(false)} onDrop=${onDrop}>
      <${Icon} name="upload" size=${30} />
      <div class="dropzone-title">把照片拖到这里，或者</div>
      <button type="button" class="btn primary" onClick=${() => fileRef.current.click()}><${Icon} name="plus" size=${18} />选择照片</button>
      <input ref=${fileRef} type="file" multiple accept=${ACCEPT} onChange=${pickFiles} hidden />
      <div class="dropzone-hint">支持 JPEG、PNG、HEIC 和相机 RAW。可以一次选很多张。</div>
    </div>

    ${staged.length ? html`<section class="stage">
      <header class="stage-h">
        <div>
          <h2>待导入 ${staged.length} 张</h2>
          <div class="page-sub">
            ${processing ? `正在读取 ${processing} 张… ` : ''}
            ${ready.length ? `${ready.length} 张可以上传` : ''}${unlabeled ? `，其中 ${unlabeled} 张还没标鸟种` : ''}${unplaced ? `${unlabeled ? '、' : '，其中 '}${unplaced} 张还没设地点` : ''}
            ${ready.length && (unlabeled || unplaced) ? '（也可以上传后再标）' : ''}
          </div>
          ${ready.length ? html`<div class="page-sub">点照片可以选中，多选之后一起标鸟种；点日期旁边的地点标签，可以给当天的照片设地点。</div>` : null}
        </div>
        <div class="tools">
          ${ready.length > 1 ? html`<button type="button" class="btn" onClick=${() => setPlace(readyIds)}><${Icon} name="pin" size=${16} />全部设为同一地点</button>` : null}
          <button type="button" class="btn danger-ghost" onClick=${() => { removeStaged(staged.map((s) => s.id)); setPicked(new Set()); }}>全部移除</button>
          <button type="button" class="btn primary" disabled=${!ready.length} onClick=${begin}><${Icon} name="upload" size=${17} />开始上传${ready.length ? `（${ready.length} 张）` : ''}</button>
        </div>
      </header>

      ${dups.length ? html`<div class="notice warn">
        <${Icon} name="warn" size=${18} />
        <span>${dups.length} 张和已有的照片完全相同，不会重复上传。</span>
        <button type="button" class="linkbtn" onClick=${() => removeStaged(dups.map((s) => s.id))}>移除重复的</button>
      </div>` : null}
      ${errors.length ? html`<div class="notice warn">
        <${Icon} name="warn" size=${18} />
        <span>${errors.length} 个文件读取失败（${errors[0].error}）。</span>
        <button type="button" class="linkbtn" onClick=${() => removeStaged(errors.map((s) => s.id))}>移除</button>
      </div>` : null}

      ${groups.map((g) => {
        const okIds = g.items.filter((s) => s.status === 'ready').map((s) => s.id);
        const allSel = okIds.length > 0 && okIds.every((id) => picked.has(id));
        const place = groupPlace(g.items.filter((s) => s.status === 'ready'));
        return html`<section class="sec" key=${g.date}>
          <header class="sec-h">
            <h2 class="sec-title">${g.date === '~' ? '正在读取…' : fmtDate(g.date)}</h2>
            <span class="sec-sub">${g.items.length} 张</span>
            ${g.date !== '~' && okIds.length ? html`
              <button type="button" class=${'chip' + (place.none ? ' unset' : '')} onClick=${() => setPlace(okIds, place.id)}>
                <${Icon} name="pin" size=${14} />${place.text}
              </button>
              <button type="button" class="linkbtn" onClick=${() => setMany(okIds, !allSel)}>${allSel ? '取消全选' : '全选'}</button>` : null}
          </header>
          <div class="grid">
            ${g.items.map((s) => html`<${Tile} key=${s.id} src=${s.thumbUrl || undefined} photo=${null}
              label=${s.status === 'ready' ? spLabel(s.sp) : s.status === 'error' ? '读取失败' : s.name}
              muted=${s.status !== 'ready' || !s.sp}
              badge=${s.dup ? '重复' : s.kind === 'raw' ? 'RAW' : null}
              busy=${s.status === 'processing'}
              selecting=${s.status === 'ready'} selected=${picked.has(s.id)}
              title=${`${s.name} · ${fmtBytes(s.size)}${s.tSrc === 'file' ? ' · 照片里没有拍摄时间，用的是文件时间' : ''}`}
              onClick=${() => { if (s.status === 'ready') toggle(s.id); }} />`)}
          </div>
        </section>`;
      })}

      ${sel.length ? html`<div class="batchbar" role="toolbar" aria-label="对选中的照片">
        <span class="batch-n">已选 ${sel.length} 张</span>
        <button type="button" class="btn sm primary" onClick=${() => setSpecies(sel)}><${Icon} name="bird" size=${16} />标鸟种</button>
        <button type="button" class="btn sm" onClick=${() => setPlace(sel)}><${Icon} name="pin" size=${16} />设地点</button>
        <button type="button" class="btn sm" onClick=${() => setDate(sel)}><${Icon} name="calendar" size=${16} />改日期</button>
        <button type="button" class="btn sm danger-ghost" onClick=${() => { removeStaged(sel); setPicked(new Set()); }}><${Icon} name="trash" size=${16} />移除</button>
        <button type="button" class="btn sm" onClick=${() => setPicked(new Set())}>取消选择</button>
      </div>` : null}
    </section>` : null}

    ${I.queue.length ? html`<section class="queue">
      <header class="stage-h">
        <div>
          <h2>上传队列</h2>
          <div class="page-sub">
            已完成 ${stats.done} 张${stats.pending ? `，还有 ${stats.pending} 张` : ''}${stats.failed ? `，失败 ${stats.failed} 张` : ''}
          </div>
        </div>
        <div class="tools">
          ${stats.failed ? html`<button type="button" class="btn" onClick=${retryFailed}><${Icon} name="refresh" size=${16} />重试失败的</button>` : null}
          ${stats.done || stats.failed ? html`<button type="button" class="btn" onClick=${clearFinished}>清除已结束的</button>` : null}
        </div>
      </header>
      ${stats.pending ? html`<div class="meter big"><span style=${`width:${(stats.ratio * 100).toFixed(1)}%`}></span></div>` : null}
      <ul class="qlist">
        ${I.queue.slice(-200).map((q) => html`<li key=${q.id} class=${'qrow ' + q.status}>
          <span class="qname">${q.s.name}</span>
          <span class="qsize">${fmtBytes(q.s.size)}</span>
          <span class="qstate">
            ${q.status === 'done' ? html`<${Icon} name="check" size=${16} /> 已上传`
              : q.status === 'error' ? html`<${Icon} name="warn" size=${16} /> ${q.error}`
                : q.status === 'uploading' ? `${Math.round((q.progress || 0) * 100)}%`
                  : '排队中'}
          </span>
        </li>`)}
      </ul>
    </section>` : null}
  <//>`;
}
