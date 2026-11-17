// 通用小工具：日期、格式化、哈希、距离等。

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const p2 = (n) => String(n).padStart(2, '0');

/** Date 对象 → 'YYYY-MM-DDTHH:MM:SS'（按本地时间） */
export function localIso(d) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** 'YYYY-MM-DDTHH:MM:SS' → 'YYYY-MM-DD' */
export const dateOf = (t) => (t ? t.slice(0, 10) : '');

export function fmtDate(d, withWeek = true) {
  if (!d) return '未知日期';
  const [y, m, day] = d.split('-').map(Number);
  const s = `${y}年${m}月${day}日`;
  return withWeek ? `${s} ${WEEK[new Date(y, m - 1, day).getDay()]}` : s;
}

export const fmtTime = (t) => (t && t.length >= 16 ? t.slice(11, 16) : '');

/**
 * 把照片里各种写法的拍摄时间统一成 'YYYY-MM-DDTHH:MM:SS'。
 * 认得 EXIF 的 '2026:11:16 08:23:11' 和 XMP 的 '2026-11-16T08:23:11-05:00'。
 * 拍摄时间按相机当时显示的本地时间保存，不做时区换算。
 */
export function parseMetaDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v) ? null : localIso(v);
  const m = String(v).trim().match(/^(\d{4})[:\-/.](\d{1,2})[:\-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', se = '0'] = m;
  if (+y < 1990 || +y > 2100 || +mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59) return null;
  return `${y}-${p2(mo)}-${p2(d)}T${p2(h)}:${p2(mi)}:${p2(se)}`;
}

export function fmtBytes(n) {
  if (n == null || isNaN(n)) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  return (n / 1024 ** 3).toFixed(1) + ' GB';
}

export function fmtExposure(sec) {
  if (!sec || !isFinite(sec)) return '';
  if (sec >= 1) return (Math.round(sec * 10) / 10) + 's';
  return '1/' + Math.round(1 / sec) + 's';
}

export async function sha256Hex(buffer) {
  const h = await crypto.subtle.digest('SHA-256', buffer);
  const b = new Uint8Array(h);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function debounce(fn, ms) {
  let t = null;
  const f = (...a) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...a); }, ms); };
  f.flush = (...a) => { if (t) { clearTimeout(t); t = null; fn(...a); } };
  return f;
}

/** 文件夹名里去掉各系统不允许的字符 */
export function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || '未命名';
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function push(map, key, val) {
  const a = map.get(key);
  if (a) a.push(val); else map.set(key, [val]);
}

/** 限制同时进行的异步任务数量 */
export function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

export const isTouch = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

export function fmtCoord(lat, lng) {
  if (lat == null || lng == null) return '';
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

export function mapsLink(lat, lng) {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}
