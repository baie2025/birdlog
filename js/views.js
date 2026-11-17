// 三个主要视图：时间线（按日期）、鸟种、地点，以及「更多」页。

import {
  html, useState, useEffect, useMemo, useStore, Icon, Tile, Thumb, Empty, useSelection, BatchBar, confirm,
  LocationEditDialog,
} from './ui.js';
import {
  S, index, openViewer, locName, recKey, sync, leaveBackend, openDialog, toast, deleteLocation, notify,
} from './store.js';
import { taxon, family, spLabel, groupCode, taxonomyInfo, CAT_LABEL } from './taxonomy.js';
import { dateOf, fmtDate, fmtTime, push, fmtBytes, mapsLink, fmtCoord } from './util.js';
import { exportCsv, exportJson } from './export.js';

// ---------- 共用 ----------

export function Page({ title, sub, back, tools, children }) {
  return html`<div class="page">
    <header class="page-h">
      <div class="page-title">
        ${back ? html`<a class="iconbtn back" href=${back} aria-label="返回"><${Icon} name="left" /></a>` : null}
        <div class="page-title-text">
          <h1>${title}</h1>
          ${sub ? html`<div class="page-sub">${sub}</div>` : null}
        </div>
      </div>
      ${tools ? html`<div class="tools">${tools}</div>` : null}
    </header>
    ${children}
  </div>`;
}

const isCountable = (code) => { const t = taxon(code); return !!t && t.cat === 'species'; };

/** 一组照片里有多少个鸟种（按 eBird 生涯清单的算法：亚种归到鸟种，杂交和未定到种不计） */
export function countSpecies(photos) {
  const set = new Set();
  for (const p of photos) {
    const g = groupCode(p.sp);
    if (g && isCountable(g)) set.add(g);
  }
  return set.size;
}

function placesText(photos) {
  const names = [];
  for (const p of photos) {
    const n = locName(p.loc);
    if (n && !names.includes(n)) names.push(n);
  }
  if (!names.length) return '';
  return names.length > 2 ? `${names[0]}、${names[1]} 等 ${names.length} 处` : names.join('、');
}

function matchPhoto(p, words) {
  if (!words.length) return true;
  const t = taxon(p.sp);
  const rec = S.db.records[recKey(p)];
  const hay = [
    t ? t.zh : '', t ? t.en : '', t ? t.sci : '', t ? t.codes.join(' ') : '',
    locName(p.loc), p.name || '', p.t ? p.t.slice(0, 10) : '', rec && !rec.del ? rec.note || '' : '', p.cam || '', p.lens || '',
  ].join('\n').toLowerCase();
  return words.every((w) => hay.includes(w));
}

/**
 * 分好组的照片格子。groups: [{ key, title, sub, href, photos }]
 * mode 为 'records' 时，同一条记录的照片叠成一格。
 */
function Sections({ groups, sel, caption, mode = 'photos' }) {
  const flat = useMemo(() => {
    const ids = [];
    const at = new Map();
    for (const g of groups) for (const p of g.photos) { at.set(p.id, ids.length); ids.push(p.id); }
    return { ids, at };
  }, [groups]);
  return useMemo(() => groups.map((g) => {
    const gids = g.photos.map((p) => p.id);
    const allSel = sel.active && gids.every((id) => sel.ids.has(id));
    let tiles;
    if (mode === 'records') {
      const recs = new Map();
      for (const p of g.photos) push(recs, p.sp || '', p); // 同一天里同一种鸟并成一个合集
      tiles = [...recs.entries()].map(([key, ps]) => {
        const face = ps.find((p) => p.cover) || ps[0];
        const ids = ps.map((p) => p.id);
        const all = sel.active && ids.every((id) => sel.ids.has(id));
        return html`<${Tile} key=${key} photo=${face} label=${caption(face)} muted=${!face.sp}
          badge=${ps.length > 1 ? html`<${Icon} name="stack" size=${12} /> ${ps.length} 张` : null}
          selecting=${sel.active} selected=${all}
          onClick=${() => (sel.active ? sel.setMany(ids, !all) : openViewer(ids, 0))} />`;
      });
    } else {
      tiles = g.photos.map((p) => html`<${Tile} key=${p.id} photo=${p} label=${caption(p)} muted=${!p.sp}
        corner=${p.cover ? html`<${Icon} name="star" size=${13} fill=${true} />` : null}
        selecting=${sel.active} selected=${sel.ids.has(p.id)}
        onClick=${() => (sel.active ? sel.toggle(p.id) : openViewer(flat.ids, flat.at.get(p.id)))} />`);
    }
    return html`<section class="sec" key=${g.key}>
      <header class="sec-h">
        <h2 class="sec-title">${g.href ? html`<a href=${g.href}>${g.title}</a>` : g.title}</h2>
        ${g.sub ? html`<span class="sec-sub">${g.sub}</span>` : null}
        ${sel.active ? html`<button type="button" class="linkbtn" onClick=${() => sel.setMany(gids, !allSel)}>${allSel ? '取消全选' : '全选'}</button>` : null}
      </header>
      <div class="grid">${tiles}</div>
    </section>`;
  }), [groups, flat, sel.active, sel.ids, mode, caption]);
}

const capSpecies = (p) => spLabel(p.sp);
const capPlaceTime = (p) => [fmtTime(p.t), locName(p.loc)].filter(Boolean).join(' · ') || ' ';
const capDate = (p) => (p.t ? p.t.slice(0, 10) : '未知日期');

function groupByDate(photos, { asc = false, sub } = {}) {
  const m = new Map();
  for (const p of photos) push(m, dateOf(p.t), p);
  const keys = [...m.keys()].sort();
  if (!asc) keys.reverse();
  return keys.map((d) => {
    const ps = asc ? [...m.get(d)].reverse() : m.get(d);
    return { key: d || 'none', title: fmtDate(d), sub: sub ? sub(ps) : '', photos: ps };
  });
}

const dateSub = (ps) => {
  const n = countSpecies(ps);
  return [placesText(ps), n ? `${n} 种` : '', `${ps.length} 张`].filter(Boolean).join(' · ');
};

function SelectButton({ sel }) {
  return html`<button type="button" class=${'btn' + (sel.active ? ' on' : '')} onClick=${sel.active ? sel.stop : sel.start}>
    <${Icon} name="select" size=${17} />${sel.active ? '退出选择' : '选择'}
  </button>`;
}

function SearchInput({ value, onInput, placeholder }) {
  return html`<label class="searchbox compact">
    <${Icon} name="search" size=${17} />
    <input type="search" value=${value} onInput=${(e) => onInput(e.target.value)} placeholder=${placeholder} autocomplete="off" />
  </label>`;
}

function usePref(key, initial) {
  const [v, setV] = useState(() => {
    try { return localStorage.getItem('birdlog.' + key) || initial; } catch { return initial; }
  });
  return [v, (x) => { setV(x); try { localStorage.setItem('birdlog.' + key, x); } catch { /* 忽略 */ } }];
}

// ---------- 时间线 ----------

export function TimelineView({ route }) {
  useStore(() => S.dbv + '|' + S.sync.state);
  const ix = index();
  const [q, setQ] = useState('');
  const [year, setYear] = useState('');
  const [unk, setUnk] = useState(route.params.get('unk') === '1');
  const [asc, setAsc] = useState(false);
  const [mode, setMode] = usePref('timelineGroup', 'records');
  const sel = useSelection();
  const unkCount = (ix.byGroup.get('') || []).length;

  const photos = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return ix.photos.filter((p) => (!year || (p.t || '').startsWith(year)) && (!unk || !p.sp) && matchPhoto(p, words));
  }, [ix, q, year, unk]);
  const groups = useMemo(() => groupByDate(photos, { asc, sub: dateSub }), [photos, asc]);

  if (!ix.photos.length) {
    const loading = S.sync.state === 'syncing' && S.backend && S.backend.kind === 'drive';
    return html`<${Page} title="时间线">
      <${Empty} title=${loading ? '正在从 Google Drive 读取记录…' : '还没有照片'}>
        ${loading ? null : html`
          <p>把观鸟照片导入进来，应用会自动读出拍摄日期，按日期、地点、鸟种整理好。</p>
          <a class="btn primary" href="#/import"><${Icon} name="plus" size=${18} />导入照片</a>`}
      <//>
    <//>`;
  }

  const filtered = q.trim() || year || unk;
  const sub = filtered
    ? `筛选出 ${photos.length} 张 · ${countSpecies(photos)} 种`
    : `${ix.photos.length} 张照片 · ${countSpecies(ix.photos)} 种 · ${ix.locs.length} 个地点`;
  return html`<${Page} title="时间线" sub=${sub} tools=${html`
      <${SearchInput} value=${q} onInput=${setQ} placeholder="搜鸟种、地点、备注…" />
      <select class="select" value=${year} onChange=${(e) => setYear(e.target.value)} aria-label="年份">
        <option value="">全部年份</option>
        ${ix.years.map((y) => html`<option value=${y}>${y} 年</option>`)}
      </select>
      ${unkCount || unk ? html`<button type="button" class=${'btn' + (unk ? ' on' : '')} onClick=${() => setUnk(!unk)}>未识别 ${unkCount}</button>` : null}
      <div class="seg" role="group" aria-label="显示方式">
        <button type="button" class=${mode === 'records' ? 'on' : ''} onClick=${() => setMode('records')} title="同一天里同一种鸟的照片并成一个合集，点开看全部">按鸟种合并</button>
        <button type="button" class=${mode === 'photos' ? 'on' : ''} onClick=${() => setMode('photos')}>全部照片</button>
      </div>
      <button type="button" class="btn" onClick=${() => setAsc(!asc)}><${Icon} name="sort" size=${17} />${asc ? '从旧到新' : '从新到旧'}</button>
      <${SelectButton} sel=${sel} />`}>
    ${photos.length
      ? html`<${Sections} groups=${groups} sel=${sel} caption=${capSpecies} mode=${mode} />`
      : html`<${Empty} icon="search" title="没有符合条件的照片" />`}
    <${BatchBar} sel=${sel} />
  <//>`;
}

// ---------- 鸟种 ----------

const SP_SORTS = [
  ['taxon', '分类顺序'],
  ['first', '最新拍到的鸟种在前'],
  ['recent', '最近拍过的在前'],
  ['count', '照片最多的在前'],
  ['name', '按名称'],
];

function speciesStats(ix, year) {
  const list = [];
  for (const [code, all] of ix.byGroup) {
    if (!code) continue;
    const ps = year ? all.filter((p) => (p.t || '').startsWith(year)) : all;
    if (!ps.length) continue;
    // 照片是从新到旧排的
    const firstEver = dateOf(all[all.length - 1].t);
    list.push({
      code,
      t: taxon(code),
      photos: ps,
      count: ps.length,
      first: dateOf(ps[ps.length - 1].t),
      last: dateOf(ps[0].t),
      firstEver,
      isNew: !!year && firstEver.startsWith(year),
      cover: all.find((p) => p.cover) || ps[0],
    });
  }
  return list;
}

function SpeciesCard({ s, showNew, showFamily }) {
  const t = s.t;
  const fam = showFamily ? family(t) : null;
  return html`<a class="card spcard" href=${'#/sp/' + encodeURIComponent(s.code)}>
    <div class="card-img"><${Thumb} photo=${s.cover} /></div>
    <div class="card-body">
      ${fam ? html`<div class="card-over">${fam.en}</div>` : null}
      <div class="card-title">${t ? t.zh || t.en : s.code}${showNew && s.isNew ? html`<span class="tag new">新</span>` : null}</div>
      ${t && t.zh ? html`<div class="card-en">${t.en}</div>` : null}
      <div class="card-meta">${s.count} 张 · 首次 ${s.first || '未知'}</div>
    </div>
  </a>`;
}

export function SpeciesView() {
  useStore(() => S.dbv);
  const ix = index();
  const [q, setQ] = useState('');
  const [year, setYear] = useState('');
  const [sort, setSort] = usePref('speciesSort', 'taxon');

  const all = useMemo(() => speciesStats(ix, year), [ix, year]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle
      ? all.filter((s) => (s.t ? [s.t.zh, s.t.en, s.t.sci, s.t.codes.join(' ')].join('\n').toLowerCase() : s.code).includes(needle))
      : [...all];
    const order = (s) => (s.t ? s.t.i : 1e9);
    const cmp = {
      taxon: (a, b) => order(a) - order(b),
      first: (a, b) => b.firstEver.localeCompare(a.firstEver) || order(a) - order(b),
      recent: (a, b) => b.last.localeCompare(a.last) || order(a) - order(b),
      count: (a, b) => b.count - a.count || order(a) - order(b),
      name: (a, b) => spLabel(a.code).localeCompare(spLabel(b.code), 'zh'),
    }[sort] || ((a, b) => order(a) - order(b));
    return list.sort(cmp);
  }, [all, q, sort]);

  const counted = shown.filter((s) => isCountable(s.code));
  const others = shown.filter((s) => !isCountable(s.code));
  const total = all.filter((s) => isCountable(s.code));
  const unkCount = (ix.byGroup.get('') || []).length;

  let body;
  if (!ix.photos.length) {
    body = html`<${Empty} title="还没有鸟种">
      <p>导入照片并标上鸟种后，这里会列出你拍到过的所有鸟种。</p>
      <a class="btn primary" href="#/import"><${Icon} name="plus" size=${18} />导入照片</a>
    <//>`;
  } else if (!shown.length) {
    body = html`<${Empty} icon="search" title=${all.length ? '没有符合条件的鸟种' : '还没有标注过鸟种'}>
      ${all.length ? null : html`<p>在时间线里点开照片，就可以给它标上鸟种。</p>`}
    <//>`;
  } else {
    // 按分类顺序排时，卡片上带出所属的科，方便对照图鉴
    body = html`<div class="cards">${counted.map((s) => html`<${SpeciesCard} key=${s.code} s=${s} showNew=${!!year} showFamily=${sort === 'taxon'} />`)}</div>`;
  }

  const newCount = year ? total.filter((s) => s.isNew).length : 0;
  const sub = year
    ? `${year} 年拍到 ${total.length} 种${newCount ? `，其中 ${newCount} 种是第一次拍到` : ''}`
    : `已拍到 ${total.length} 种`;

  return html`<${Page} title="鸟种" sub=${sub} tools=${html`
      <${SearchInput} value=${q} onInput=${setQ} placeholder="搜鸟种…" />
      <select class="select" value=${year} onChange=${(e) => setYear(e.target.value)} aria-label="年份">
        <option value="">全部年份</option>
        ${ix.years.map((y) => html`<option value=${y}>${y} 年</option>`)}
      </select>
      <select class="select" value=${sort} onChange=${(e) => setSort(e.target.value)} aria-label="排序">
        ${SP_SORTS.map(([v, label]) => html`<option value=${v}>${label}</option>`)}
      </select>`}>
    ${unkCount ? html`<a class="notice" href="#/timeline?unk=1">
      <${Icon} name="info" size=${18} />还有 ${unkCount} 张照片没有标鸟种，点这里去看
    </a>` : null}
    ${body}
    ${others.length ? html`<section class="sec">
      <header class="sec-h">
        <h2 class="sec-title">杂交、未定到种等</h2>
        <span class="sec-sub">不计入鸟种数</span>
      </header>
      <div class="cards">${others.map((s) => html`<${SpeciesCard} key=${s.code} s=${s} />`)}</div>
    </section>` : null}
  <//>`;
}

export function SpeciesDetailView({ route }) {
  useStore(() => S.dbv);
  const ix = index();
  const code = route.id;
  const sel = useSelection();
  const photos = ix.byGroup.get(code) || [];
  const t = taxon(code);
  const fam = family(t);
  const groups = useMemo(() => groupByDate(photos, { sub: (ps) => [placesText(ps), `${ps.length} 张`].filter(Boolean).join(' · ') }), [photos]);
  // 组里可能混有亚种，格子上标出具体是哪个
  const caption = useMemo(() => (p) => (p.sp && p.sp !== code ? spLabel(p.sp) : capPlaceTime(p)), [code]);

  if (!photos.length) {
    return html`<${Page} title=${t ? t.zh || t.en : code || '鸟种'} back="#/species">
      <${Empty} title="这个鸟种下还没有照片" />
    <//>`;
  }
  const first = photos[photos.length - 1];
  const last = photos[0];
  const places = new Set(photos.map((p) => p.loc).filter(Boolean)).size;
  const days = new Set(photos.map((p) => dateOf(p.t))).size;
  return html`<${Page} title=${t ? t.zh || t.en : code} back="#/species"
      sub=${t ? html`${t.zh ? t.en + ' · ' : ''}<i>${t.sci}</i>${fam ? ` · ${fam.en}` : ''}${CAT_LABEL[t.cat] ? ` · ${CAT_LABEL[t.cat]}` : ''}` : null}
      tools=${html`
        ${t && t.cat === 'species' ? html`<a class="btn" href=${'https://ebird.org/species/' + encodeURIComponent(code)} target="_blank" rel="noopener">
          <${Icon} name="external" size=${16} />eBird</a>` : null}
        <${SelectButton} sel=${sel} />`}>
    <div class="stats">
      <div class="stat"><b>${photos.length}</b><span>张照片</span></div>
      <div class="stat"><b>${days}</b><span>天拍到</span></div>
      <div class="stat"><b>${places}</b><span>个地点</span></div>
      <div class="stat wide"><b>${dateOf(first.t) || '未知'}</b><span>首次拍到${locName(first.loc) ? ' · ' + locName(first.loc) : ''}</span></div>
      <div class="stat wide"><b>${dateOf(last.t) || '未知'}</b><span>最近拍到${locName(last.loc) ? ' · ' + locName(last.loc) : ''}</span></div>
    </div>
    <${Sections} groups=${groups} sel=${sel} caption=${caption} />
    <${BatchBar} sel=${sel} />
  <//>`;
}

// ---------- 地点 ----------

const LOC_SORTS = [
  ['recent', '最近去过的在前'],
  ['species', '鸟种最多的在前'],
  ['count', '照片最多的在前'],
  ['name', '按名称'],
];

export function PlacesView() {
  useStore(() => S.dbv);
  const ix = index();
  const [sort, setSort] = usePref('placeSort', 'recent');
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const list = ix.locs.map((l) => {
      const ps = ix.byLoc.get(l.id) || [];
      return {
        l, ps,
        count: ps.length,
        species: countSpecies(ps),
        days: new Set(ps.map((p) => dateOf(p.t))).size,
        last: ps.length ? dateOf(ps[0].t) : '',
      };
    });
    const needle = q.trim().toLowerCase();
    const shown = needle ? list.filter((r) => r.l.name.toLowerCase().includes(needle)) : list;
    const cmp = {
      recent: (a, b) => b.last.localeCompare(a.last) || a.l.name.localeCompare(b.l.name, 'zh'),
      species: (a, b) => b.species - a.species || b.count - a.count,
      count: (a, b) => b.count - a.count,
      name: (a, b) => a.l.name.localeCompare(b.l.name, 'zh'),
    }[sort];
    return shown.sort(cmp);
  }, [ix, sort, q]);
  const noLoc = ix.byLoc.get('') || [];
  const create = async () => {
    const id = await openDialog(LocationEditDialog, {});
    if (id) location.hash = '#/place/' + id;
  };
  return html`<${Page} title="地点" sub=${`${ix.locs.length} 个地点`} tools=${html`
      <${SearchInput} value=${q} onInput=${setQ} placeholder="搜地点…" />
      <select class="select" value=${sort} onChange=${(e) => setSort(e.target.value)} aria-label="排序">
        ${LOC_SORTS.map(([v, label]) => html`<option value=${v}>${label}</option>`)}
      </select>
      <button type="button" class="btn" onClick=${create}><${Icon} name="plus" size=${17} />新建地点</button>`}>
    ${!rows.length && !noLoc.length ? html`<${Empty} icon="pin" title=${q.trim() ? '没有符合条件的地点' : '还没有地点'}>
      ${q.trim() ? null : html`<p>导入照片时给它们设一个地点，这里就会按地点整理好。</p>`}
    <//>` : null}
    <div class="cards places">
      ${rows.map((r) => html`<a class="card placecard" key=${r.l.id} href=${'#/place/' + r.l.id}>
        <div class="card-img">${r.ps.length ? html`<${Thumb} photo=${r.ps[0]} />` : html`<div class="card-noimg"><${Icon} name="pin" size=${26} /></div>`}</div>
        <div class="card-body">
          <div class="card-title">${r.l.name}</div>
          <div class="card-meta">${r.count ? `${r.species} 种 · ${r.count} 张 · 去过 ${r.days} 天` : '还没有照片'}</div>
          ${r.last ? html`<div class="card-meta">最近 ${r.last}</div>` : null}
        </div>
      </a>`)}
      ${noLoc.length && !q.trim() ? html`<a class="card placecard" href="#/place/none">
        <div class="card-img"><${Thumb} photo=${noLoc[0]} /></div>
        <div class="card-body">
          <div class="card-title muted">未设地点</div>
          <div class="card-meta">${noLoc.length} 张照片</div>
        </div>
      </a>` : null}
    </div>
  <//>`;
}

export function PlaceDetailView({ route }) {
  useStore(() => S.dbv);
  const ix = index();
  const id = route.id === 'none' ? '' : route.id;
  const loc = id ? S.db.locations[id] : null;
  const photos = ix.byLoc.get(id) || [];
  const [by, setBy] = usePref('placeGroup', 'date');
  const sel = useSelection();
  const groups = useMemo(() => {
    if (by === 'date') return groupByDate(photos, { sub: (ps) => { const n = countSpecies(ps); return [n ? `${n} 种` : '', `${ps.length} 张`].filter(Boolean).join(' · '); } });
    const m = new Map();
    for (const p of photos) push(m, groupCode(p.sp), p);
    const order = (c) => { const t = taxon(c); return c ? (t ? t.i : 1e9 - 1) : 1e9; };
    return [...m.entries()].sort((a, b) => order(a[0]) - order(b[0])).map(([code, ps]) => {
      const t = taxon(code);
      return {
        key: code || 'none',
        title: code ? (t ? t.zh || t.en : code) : '未识别',
        href: code ? '#/sp/' + encodeURIComponent(code) : '',
        sub: [t && t.zh ? t.en : '', `${ps.length} 张`].filter(Boolean).join(' · '),
        photos: ps,
      };
    });
  }, [photos, by]);

  if (id && (!loc || loc.del)) {
    return html`<${Page} title="地点" back="#/places"><${Empty} icon="pin" title="找不到这个地点" /><//>`;
  }
  const edit = () => openDialog(LocationEditDialog, { loc });
  const remove = async () => {
    const ok = await confirm({ title: `删除地点「${loc.name}」？`, message: '这个地点下没有照片，删除后不影响任何记录。', okLabel: '删除', danger: true });
    if (ok && deleteLocation(id)) { toast('地点已删除'); location.hash = '#/places'; }
  };
  const species = countSpecies(photos);
  const days = new Set(photos.map((p) => dateOf(p.t))).size;
  const sub = loc
    ? html`${species} 种 · ${photos.length} 张 · 去过 ${days} 天${loc.lat != null ? html` · <a href=${mapsLink(loc.lat, loc.lng)} target="_blank" rel="noopener">${fmtCoord(loc.lat, loc.lng)}</a>` : ''}`
    : `${photos.length} 张照片还没有设地点`;
  return html`<${Page} title=${loc ? loc.name : '未设地点'} back="#/places" sub=${sub} tools=${html`
      <div class="seg" role="group" aria-label="分组方式">
        <button type="button" class=${by === 'date' ? 'on' : ''} onClick=${() => setBy('date')}>按日期</button>
        <button type="button" class=${by === 'species' ? 'on' : ''} onClick=${() => setBy('species')}>按鸟种</button>
      </div>
      ${loc ? html`<button type="button" class="btn" onClick=${edit}><${Icon} name="edit" size=${16} />修改</button>` : null}
      ${loc && !photos.length ? html`<button type="button" class="btn danger-ghost" onClick=${remove}><${Icon} name="trash" size=${16} />删除</button>` : null}
      ${photos.length ? html`<${SelectButton} sel=${sel} />` : null}`}>
    ${photos.length
      ? html`<${Sections} groups=${groups} sel=${sel} caption=${by === 'date' ? capSpecies : capDate} />`
      : html`<${Empty} icon="pin" title="这个地点下还没有照片" />`}
    <${BatchBar} sel=${sel} />
  <//>`;
}

// ---------- 更多 ----------

const SYNC_TEXT = { idle: '已同步', syncing: '正在同步…', offline: '离线，联网后会自动同步', error: '同步出错' };

export function applyTheme(theme) {
  try { localStorage.setItem('birdlog.theme', theme); } catch { /* 忽略 */ }
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

export function MoreView() {
  useStore(() => [S.dbv, S.sync.state, S.sync.at, S.dirty, S.user && S.user.email, S.needAuth].join('|'));
  const ix = index();
  const be = S.backend;
  const isDrive = be && be.kind === 'drive';
  const [quota, setQuota] = useState(null);
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('birdlog.theme') || 'auto'; } catch { return 'auto'; } });
  useEffect(() => {
    let live = true;
    if (be && !(isDrive && !be.hasToken())) be.quota().then((v) => { if (live) setQuota(v); }).catch(() => {});
    return () => { live = false; };
  }, [be, S.needAuth]);
  const origBytes = ix.photos.reduce((s, p) => s + (p.size || 0), 0);
  const tax = taxonomyInfo();
  const leave = async () => {
    const ok = await confirm(isDrive
      ? { title: '退出 Google 账号？', message: 'Drive 里的照片和记录都不受影响，下次连接同一个账号就能接着用。这台设备上的缓存会被清掉。', okLabel: '退出' }
      : { title: '退出本地试用？', message: '试用数据仍留在这个浏览器里，下次选「本地试用」还能看到。', okLabel: '退出' });
    if (ok) { await leaveBackend(); location.hash = '#/'; }
  };
  const wipe = async () => {
    const ok = await confirm({
      title: '清空试用数据？',
      message: '本地试用里的照片和记录会全部删除，无法恢复。Google Drive 里的内容不受影响。',
      okLabel: '清空',
      danger: true,
    });
    if (!ok) return;
    await be.wipe();
    await leaveBackend();
    location.hash = '#/';
    toast('试用数据已清空');
  };
  const pct = quota && quota.total ? Math.min(100, (quota.used / quota.total) * 100) : 0;
  return html`<${Page} title="更多">
    <div class="panels">
      <section class="panel">
        <h2><${Icon} name="cloud" size=${18} />存储</h2>
        <p class="panel-main">${isDrive ? 'Google Drive' : '本地试用'}${S.user && S.user.email ? ` · ${S.user.email}` : ''}</p>
        ${isDrive ? null : html`<p class="hint">本地试用模式下，照片和记录只存在这个浏览器里，换设备看不到，清除浏览器数据会一起丢失。正式使用请连接 Google Drive。</p>`}
        ${quota && quota.total ? html`
          <div class="meter" role="img" aria-label=${`已用 ${fmtBytes(quota.used)}，共 ${fmtBytes(quota.total)}`}><span style=${`width:${pct}%`}></span></div>
          <p class="hint">${isDrive ? 'Drive' : '浏览器存储'}已用 ${fmtBytes(quota.used)}，共 ${fmtBytes(quota.total)}。BirdLog 的原图约占 ${fmtBytes(origBytes)}。</p>`
        : html`<p class="hint">BirdLog 的原图约占 ${fmtBytes(origBytes)}。</p>`}
        <div class="panel-actions">
          ${isDrive && be.folderLink() ? html`<a class="btn" href=${be.folderLink()} target="_blank" rel="noopener"><${Icon} name="external" size=${16} />打开 Drive 里的 BirdLog 文件夹</a>` : null}
          <button type="button" class="btn" onClick=${leave}>${isDrive ? '退出 Google 账号' : '退出本地试用'}</button>
          ${isDrive ? null : html`<button type="button" class="btn danger-ghost" onClick=${wipe}>清空试用数据</button>`}
        </div>
      </section>

      <section class="panel">
        <h2><${Icon} name="refresh" size=${18} />同步</h2>
        <p class="panel-main">${S.needAuth ? '需要重新连接 Google Drive' : SYNC_TEXT[S.sync.state]}${S.dirty && S.sync.state === 'idle' ? '（有修改等待上传）' : ''}</p>
        ${S.sync.state === 'error' ? html`<p class="hint error">${S.sync.error}</p>` : null}
        ${S.sync.at ? html`<p class="hint">上次同步：${new Date(S.sync.at).toLocaleString('zh-CN')}</p>` : null}
        <p class="hint">修改会自动保存。在另一台设备上改过之后，这里回到前台时会自动取回最新内容。</p>
        <div class="panel-actions">
          <button type="button" class="btn" disabled=${S.sync.state === 'syncing' || S.needAuth} onClick=${() => sync()}>立即同步</button>
        </div>
      </section>

      <section class="panel">
        <h2><${Icon} name="download" size=${18} />导出</h2>
        <p class="hint">记录表格每行是一条记录（同一天、同一地点、同一种鸟），Excel 可以直接打开。数据备份包含全部记录，不含照片文件。</p>
        <div class="panel-actions">
          <button type="button" class="btn" disabled=${!ix.photos.length} onClick=${() => toast(`已导出 ${exportCsv()} 条记录`)}>导出记录表格（CSV）</button>
          <button type="button" class="btn" disabled=${!ix.photos.length} onClick=${() => toast(`已导出 ${exportJson()} 张照片的记录`)}>导出数据备份（JSON）</button>
        </div>
      </section>

      <section class="panel">
        <h2><${Icon} name="image" size=${18} />外观</h2>
        <div class="seg" role="group" aria-label="主题">
          ${[['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([v, label]) => html`
            <button type="button" class=${theme === v ? 'on' : ''} onClick=${() => { setTheme(v); applyTheme(v); }}>${label}</button>`)}
        </div>
      </section>

      <section class="panel">
        <h2><${Icon} name="info" size=${18} />关于</h2>
        <p class="hint">BirdLog 0.1 · ${ix.photos.length} 张照片 · ${countSpecies(ix.photos)} 种 · ${ix.locs.length} 个地点</p>
        <p class="hint">${tax ? `鸟种名录：eBird/Clements ${tax.version} 版，共 ${tax.count} 条（${tax.fetched} 下载）。名录来自 Cornell Lab of Ornithology 的 eBird。` : '鸟种名录还没有加载。'}</p>
      </section>
    </div>
  <//>`;
}
