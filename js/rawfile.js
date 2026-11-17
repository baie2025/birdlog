// 相机 RAW 文件的处理。浏览器不认识 RAW，所以这里做两件事：
// 1. 从 RAW 里找出相机自己嵌进去的 JPEG 预览图（几乎所有 RAW 都带），用它来显示；
// 2. 读出拍摄时间、相机参数、GPS。
// 不依赖具体品牌：预览图靠扫描 JPEG 标记来找，参数按 TIFF 结构读（CR2/NEF/ARW/DNG/ORF/RW2/PEF 等），
// 佳能 CR3 另外按它的盒子结构处理。RAW 文件本身原样上传，不做任何修改。

import { parseMetaDate } from './util.js';

const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

/** 从 start 处的 JPEG 开头走到结尾，返回范围和尺寸；不是合法 JPEG 就返回 null */
function walkJpeg(u8, start) {
  const n = u8.length;
  let p = start + 2;
  let width = 0, height = 0, sof = -1;
  while (p + 4 <= n) {
    if (u8[p] !== 0xff) return null;
    while (u8[p + 1] === 0xff && p + 2 < n) p++;
    const m = u8[p + 1];
    const known = (m >= 0xc0 && m <= 0xcf) || (m >= 0xdb && m <= 0xdd) || (m >= 0xe0 && m <= 0xef) || m === 0xfe || m === 0xda;
    if (!known) return null;
    const len = (u8[p + 2] << 8) | u8[p + 3];
    if (len < 2) return null;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (p + 9 > n) return null;
      sof = m;
      height = (u8[p + 5] << 8) | u8[p + 6];
      width = (u8[p + 7] << 8) | u8[p + 8];
    }
    p += 2 + len;
    if (m !== 0xda) continue;
    if (sof < 0) return null;
    // 压缩数据区：一直找到结束标记 FFD9
    for (;;) {
      const i = u8.indexOf(0xff, p);
      if (i < 0 || i + 1 >= n) return null;
      const b = u8[i + 1];
      if (b === 0x00 || (b >= 0xd0 && b <= 0xd7)) { p = i + 2; continue; }
      if (b === 0xff) { p = i + 1; continue; }
      if (b === 0xd9) return { start, end: i + 2, width, height, sof };
      if (i + 4 > n) return null;
      const l2 = (u8[i + 2] << 8) | u8[i + 3];
      if (l2 < 2) return null;
      p = i + 2 + l2;
    }
  }
  return null;
}

/** 找出文件里所有内嵌的 JPEG 图，按面积从大到小排 */
export function findEmbeddedJpegs(u8, max = 6) {
  const out = [];
  const n = u8.length;
  let i = 0;
  while (i < n - 4) {
    i = u8.indexOf(0xff, i);
    if (i < 0 || i > n - 4) break;
    if (u8[i + 1] === 0xd8 && u8[i + 2] === 0xff) {
      const r = walkJpeg(u8, i);
      if (r) {
        // C3 是无损 JPEG，那是 RAW 的传感器数据而不是预览图
        if (r.sof !== 0xc3 && r.width >= 160 && r.height >= 120) out.push(r);
        i = r.end;
        continue;
      }
    }
    i++;
  }
  out.sort((a, b) => b.width * b.height - a.width * a.height);
  return out.slice(0, max);
}

/** 读一段 TIFF 结构，返回 { ifd0, exif, gps } 三张「标签号 → 值」的表 */
export function readTiff(u8, base = 0) {
  const n = u8.length;
  if (base < 0 || base + 8 > n) return null;
  let le;
  if (u8[base] === 0x49 && u8[base + 1] === 0x49) le = true;
  else if (u8[base] === 0x4d && u8[base + 1] === 0x4d) le = false;
  else return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const magic = dv.getUint16(base + 2, le);
  // 42 是标准 TIFF；奥林巴斯 ORF 用 0x4F52/0x5352，松下 RW2 用 0x55
  if (magic !== 42 && magic !== 0x4f52 && magic !== 0x5352 && magic !== 0x55) return null;

  const value = (type, count, vp) => {
    const one = (k) => {
      const q = vp + k * TYPE_SIZE[type];
      switch (type) {
        case 1: case 7: return u8[q];
        case 6: return dv.getInt8(q);
        case 3: return dv.getUint16(q, le);
        case 8: return dv.getInt16(q, le);
        case 4: return dv.getUint32(q, le);
        case 9: return dv.getInt32(q, le);
        case 5: { const d = dv.getUint32(q + 4, le); return d ? dv.getUint32(q, le) / d : 0; }
        case 10: { const d = dv.getInt32(q + 4, le); return d ? dv.getInt32(q, le) / d : 0; }
        case 11: return dv.getFloat32(q, le);
        case 12: return dv.getFloat64(q, le);
        default: return 0;
      }
    };
    if (type === 2) {
      let s = '';
      for (let k = 0; k < count; k++) {
        const c = u8[vp + k];
        if (!c) break;
        s += String.fromCharCode(c);
      }
      return s.trim();
    }
    if (count === 1) return one(0);
    const arr = [];
    for (let k = 0; k < count; k++) arr.push(one(k));
    return arr;
  };

  const readIfd = (off) => {
    const tags = new Map();
    const pos = base + off;
    if (!off || pos + 2 > n) return tags;
    const cnt = dv.getUint16(pos, le);
    if (cnt > 2000) return tags;
    for (let k = 0; k < cnt; k++) {
      const e = pos + 2 + k * 12;
      if (e + 12 > n) break;
      const tag = dv.getUint16(e, le);
      const type = dv.getUint16(e + 2, le);
      const count = dv.getUint32(e + 4, le);
      const size = (TYPE_SIZE[type] || 0) * count;
      if (!size || size > 1024) continue; // 只关心小字段，大块数据跳过
      const vp = size <= 4 ? e + 8 : base + dv.getUint32(e + 8, le);
      if (vp < 0 || vp + size > n) continue;
      tags.set(tag, value(type, count, vp));
    }
    return tags;
  };

  const ifd0 = readIfd(dv.getUint32(base + 4, le));
  const ptr = (t) => { const v = ifd0.get(t); return typeof v === 'number' ? v : 0; };
  return { ifd0, exif: readIfd(ptr(0x8769)), gps: readIfd(ptr(0x8825)) };
}

const isBmff = (u8) => u8.length > 12 && u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70; // 'ftyp'

/** 在文件开头找佳能 CR3 的某个盒子（如 CMT1），返回内容起始位置 */
function findBox(u8, name) {
  const a = name.charCodeAt(0), b = name.charCodeAt(1), c = name.charCodeAt(2), d = name.charCodeAt(3);
  const lim = Math.min(u8.length - 12, 4 * 1024 * 1024);
  let i = 8;
  while (i < lim) {
    i = u8.indexOf(a, i);
    if (i < 0 || i >= lim) return -1;
    if (u8[i + 1] === b && u8[i + 2] === c && u8[i + 3] === d) {
      const s = i + 4;
      if ((u8[s] === 0x49 && u8[s + 1] === 0x49) || (u8[s] === 0x4d && u8[s + 1] === 0x4d)) return s;
    }
    i++;
  }
  return -1;
}

const num = (v) => {
  const x = Array.isArray(v) ? v[0] : v;
  return typeof x === 'number' && isFinite(x) && x > 0 ? x : undefined;
};
const str = (v) => (typeof v === 'string' && v ? v : undefined);

function dms(v, ref) {
  if (!Array.isArray(v) || v.length < 3) return undefined;
  const deg = v[0] + v[1] / 60 + v[2] / 3600;
  if (!isFinite(deg)) return undefined;
  return ref === 'S' || ref === 'W' ? -deg : deg;
}

/** 读 RAW 的拍摄信息，读不到的字段就是 undefined */
export function readRawMeta(u8) {
  let ifd0 = null, exif = null, gps = null;
  const t = readTiff(u8, 0);
  if (t) {
    ({ ifd0, exif, gps } = t);
  } else if (isBmff(u8)) {
    const sub = (name) => {
      const at = findBox(u8, name);
      const r = at >= 0 ? readTiff(u8, at) : null;
      return r ? r.ifd0 : null;
    };
    ifd0 = sub('CMT1');
    exif = sub('CMT2');
    gps = sub('CMT4');
  }
  if (!ifd0 && !exif) return {};
  const g = (m, k) => (m ? m.get(k) : undefined);
  const meta = {
    make: str(g(ifd0, 0x010f)),
    model: str(g(ifd0, 0x0110)),
    orientation: num(g(ifd0, 0x0112)),
    t: parseMetaDate(g(exif, 0x9003)) || parseMetaDate(g(exif, 0x9004)) || parseMetaDate(g(ifd0, 0x0132)) || undefined,
    ex: num(g(exif, 0x829a)),
    fn: num(g(exif, 0x829d)),
    iso: num(g(exif, 0x8827)),
    fl: num(g(exif, 0x920a)),
    lens: str(g(exif, 0xa434)),
  };
  const lat = dms(g(gps, 2), g(gps, 1));
  const lng = dms(g(gps, 4), g(gps, 3));
  if (lat != null && lng != null && (lat !== 0 || lng !== 0) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    meta.lat = lat;
    meta.lng = lng;
  }
  return meta;
}
