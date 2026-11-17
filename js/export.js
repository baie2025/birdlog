// 导出：记录表格（CSV，Excel 可以直接打开）和完整数据备份（JSON）。

import { S, index, getRecord, locName } from './store.js';
import { taxon, taxonomyInfo } from './taxonomy.js';
import { csvCell, downloadBlob, localIso } from './util.js';

const stamp = () => localIso(new Date()).slice(0, 10);

/** 一行一条记录（同一天、同一地点、同一种鸟） */
export function exportCsv() {
  const ix = index();
  const head = ['日期', '地点', '纬度', '经度', '中文名', '英文名', '学名', 'eBird 代码', '数量', '备注', '照片数', '照片文件名'];
  const rows = [];
  for (const [key, photos] of ix.byRec) {
    const p = photos[0];
    const t = taxon(p.sp);
    const loc = p.loc ? S.db.locations[p.loc] : null;
    const rec = getRecord(key);
    rows.push([
      p.t ? p.t.slice(0, 10) : '',
      locName(p.loc),
      loc && loc.lat != null ? loc.lat : '',
      loc && loc.lng != null ? loc.lng : '',
      t ? t.zh : '',
      t ? t.en : (p.sp || ''),
      t ? t.sci : '',
      p.sp || '',
      rec.count != null ? rec.count : '',
      rec.note || '',
      photos.length,
      photos.map((x) => x.name).join('; '),
    ]);
  }
  rows.sort((a, b) => String(b[0]).localeCompare(String(a[0])) || String(a[1]).localeCompare(String(b[1])) || String(a[5]).localeCompare(String(b[5])));
  const text = [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  // 开头加 BOM，Excel 才能正确认出中文
  downloadBlob(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }), `BirdLog 记录 ${stamp()}.csv`);
  return rows.length;
}

/** 全部记录的备份（不含照片文件本身） */
export function exportJson() {
  const data = {
    app: 'BirdLog',
    exportedAt: new Date().toISOString(),
    taxonomy: taxonomyInfo(),
    photos: Object.values(S.db.photos).filter((p) => !p.del),
    locations: Object.values(S.db.locations).filter((l) => !l.del),
    records: Object.fromEntries(Object.entries(S.db.records).filter(([, r]) => !r.del)),
  };
  downloadBlob(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), `BirdLog 备份 ${stamp()}.json`);
  return data.photos.length;
}
