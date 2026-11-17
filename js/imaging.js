// 照片处理：识别文件类型、读拍摄信息、算指纹（查重用）、生成缩略图和预览图。
// 原图文件本身从不修改，缩略图和预览图是另外生成的两张小图。

import * as exifr from '../vendor/exifr.js';
import { findEmbeddedJpegs, readRawMeta } from './rawfile.js';
import { parseMetaDate, sha256Hex, localIso } from './util.js';

const RAW_EXT = new Set([
  'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf', 'ori', 'rw2', 'raw', 'rwl',
  'pef', 'dng', 'srw', 'x3f', '3fr', 'fff', 'erf', 'kdc', 'dcr', 'mrw', 'iiq', 'mef', 'mos', 'gpr',
]);
const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic',
  heif: 'image/heif', avif: 'image/avif', gif: 'image/gif', tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp',
};

/** 文件选择框里允许选的类型 */
export const ACCEPT = 'image/*,.heic,.heif,' + [...RAW_EXT].map((e) => '.' + e).join(',');

export const THUMB_EDGE = 480;
export const PREVIEW_EDGE = 2048;

const extOf = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');

export function fileKind(file) {
  const ext = extOf(file.name);
  if (RAW_EXT.has(ext)) return 'raw';
  const mime = (file.type || EXT_MIME[ext] || '').toLowerCase();
  if (ext === 'heic' || ext === 'heif' || mime === 'image/heic' || mime === 'image/heif') return 'heic';
  if (mime === 'image/tiff') return 'tiff';
  if (mime.startsWith('image/')) return 'image';
  return 'other';
}

export function mimeOf(file) {
  return file.type || EXT_MIME[extOf(file.name)] || 'application/octet-stream';
}

const EXIF_OPTS = {
  tiff: true, ifd0: true, exif: true, gps: true, xmp: true,
  iptc: false, icc: false, jfif: false, ihdr: false, interop: false, makerNote: false, userComment: false,
  reviveValues: false, translateValues: false, mergeOutput: true,
};

const num = (v) => {
  const x = Array.isArray(v) ? v[0] : v;
  return typeof x === 'number' && isFinite(x) && x > 0 ? x : undefined;
};
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** 用 exifr 读 JPEG / PNG / HEIC / TIFF 的拍摄信息 */
export async function readExif(input) {
  let o = null;
  try { o = await exifr.parse(input, EXIF_OPTS); } catch { o = null; }
  if (!o) return {};
  const meta = {
    make: str(o.Make),
    model: str(o.Model),
    lens: str(o.LensModel) || str(o.Lens),
    orientation: num(o.Orientation),
    t: parseMetaDate(o.DateTimeOriginal) || parseMetaDate(o.CreateDate) || parseMetaDate(o.DateCreated) || undefined,
    ex: num(o.ExposureTime),
    fn: num(o.FNumber),
    iso: num(o.ISO),
    fl: num(o.FocalLength),
  };
  const lat = typeof o.latitude === 'number' ? o.latitude : undefined;
  const lng = typeof o.longitude === 'number' ? o.longitude : undefined;
  if (lat != null && lng != null && isFinite(lat) && isFinite(lng) && (lat !== 0 || lng !== 0)) {
    meta.lat = lat;
    meta.lng = lng;
  }
  return meta;
}

async function decode(blob) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch { /* 换下面的办法再试 */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function canvasToJpeg(canvas, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('生成图片失败'))), 'image/jpeg', quality));
}

/** 把图缩到最长边不超过 maxEdge，按需要旋转（orientation 是 EXIF 的方向值） */
function render(src, sw, sh, maxEdge, orientation = 1) {
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const quarter = orientation === 6 || orientation === 8;
  const cw = quarter ? h : w;
  const ch = quarter ? w : h;
  const canvas = makeCanvas(cw, ch);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cw, ch);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (orientation === 6) { ctx.translate(cw, 0); ctx.rotate(Math.PI / 2); }
  else if (orientation === 8) { ctx.translate(0, ch); ctx.rotate(-Math.PI / 2); }
  else if (orientation === 3) { ctx.translate(cw, ch); ctx.rotate(Math.PI); }
  ctx.drawImage(src, 0, 0, w, h);
  return canvas;
}

function mergeMeta(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) if (out[k] == null && v != null) out[k] = v;
  return out;
}

/**
 * 分析一个待导入的文件。返回：
 * { kind, hash, meta, t, tSrc, w, h, thumbBlob, previewBlob }
 * RAW 没有可用的内嵌预览时 thumbBlob / previewBlob 为 null，文件仍然可以上传。
 */
export async function analyze(file) {
  const kind = fileKind(file);
  if (kind === 'other') throw new Error('不是图片文件');
  const buf = await file.arrayBuffer();
  const hash = await sha256Hex(buf);

  let meta = {};
  let bitmap = null;
  let orientation = 1; // 画的时候还要不要自己转

  if (kind === 'raw' || kind === 'tiff') {
    const u8 = new Uint8Array(buf);
    meta = readRawMeta(u8);
    let embedded = null;
    for (const c of findEmbeddedJpegs(u8)) {
      const blob = new Blob([u8.subarray(c.start, c.end)], { type: 'image/jpeg' });
      try { bitmap = await decode(blob); embedded = blob; break; } catch { /* 试下一张 */ }
    }
    if (embedded) {
      const inner = await readExif(embedded);
      // 内嵌预览自己带方向信息时浏览器已经转好了；不带的话按 RAW 里记的方向转
      if (!inner.orientation && meta.orientation) orientation = meta.orientation;
      meta = mergeMeta(meta, inner);
    } else if (kind === 'tiff') {
      meta = mergeMeta(meta, await readExif(file));
      try { bitmap = await decode(file); } catch { bitmap = null; }
    }
  } else if (kind === 'heic') {
    meta = await readExif(file);
    try {
      bitmap = await decode(file); // Safari 能直接解 HEIC
    } catch {
      const { heicTo } = await import('../vendor/heic-to.js');
      const jpeg = await heicTo({ blob: file, type: 'image/jpeg', quality: 0.92 });
      bitmap = await decode(jpeg);
    }
  } else {
    meta = await readExif(file);
    bitmap = await decode(file);
  }

  let w = 0, h = 0, thumbBlob = null, previewBlob = null;
  if (bitmap) {
    const sw = bitmap.width || bitmap.naturalWidth;
    const sh = bitmap.height || bitmap.naturalHeight;
    const preview = render(bitmap, sw, sh, PREVIEW_EDGE, orientation);
    if (bitmap.close) bitmap.close();
    const quarter = orientation === 6 || orientation === 8;
    w = quarter ? sh : sw;
    h = quarter ? sw : sh;
    previewBlob = await canvasToJpeg(preview, 0.86);
    const thumb = render(preview, preview.width, preview.height, THUMB_EDGE);
    thumbBlob = await canvasToJpeg(thumb, 0.8);
  }

  const t = meta.t || localIso(new Date(file.lastModified || Date.now()));
  return { kind, hash, meta, t, tSrc: meta.t ? 'exif' : 'file', w, h, thumbBlob, previewBlob };
}

/** 相机名：型号里已经带品牌时不重复写 */
export function cameraName(make, model) {
  if (!model) return make || '';
  if (!make) return model;
  const brand = make.split(' ')[0].toLowerCase();
  return model.toLowerCase().startsWith(brand) ? model : `${make} ${model}`;
}
