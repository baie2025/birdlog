// 测试用：合成带拍摄信息的 JPEG 和「假 RAW」文件。Node 和浏览器里都能用。

/**
 * 生成一段 TIFF/EXIF 数据。
 * 每条标签写成 [标签号, 类型, 值]，类型：'A' 文本、'S' 短整数、'L' 长整数、'R' 分数（[分子, 分母] 或它们的数组）。
 */
export function buildTiff({ ifd0 = [], exif = [], gps = [] }) {
  const le = true;
  const i0 = ifd0.map((e) => [...e]);
  const ex = exif.map((e) => [...e]);
  const gp = gps.map((e) => [...e]);
  const size = (ents) => (ents.length ? 2 + ents.length * 12 + 4 : 0);
  if (ex.length) i0.push([0x8769, 'L', 0]);
  if (gp.length) i0.push([0x8825, 'L', 0]);
  const off0 = 8;
  const offE = off0 + size(i0);
  const offG = offE + size(ex);
  let dataOff = offG + size(gp);
  for (const e of i0) {
    if (e[0] === 0x8769) e[2] = offE;
    if (e[0] === 0x8825) e[2] = offG;
  }
  const buf = new Uint8Array(1 << 16);
  const dv = new DataView(buf.buffer);
  buf[0] = 0x49; buf[1] = 0x49;
  dv.setUint16(2, 42, le);
  dv.setUint32(4, off0, le);
  const writeIfd = (ents, off) => {
    if (!ents.length) return;
    ents.sort((a, b) => a[0] - b[0]);
    dv.setUint16(off, ents.length, le);
    ents.forEach(([tag, type, val], i) => {
      const e = off + 2 + i * 12;
      dv.setUint16(e, tag, le);
      if (type === 'A') {
        const s = val + '\0';
        dv.setUint16(e + 2, 2, le);
        dv.setUint32(e + 4, s.length, le);
        if (s.length <= 4) {
          for (let k = 0; k < s.length; k++) buf[e + 8 + k] = s.charCodeAt(k);
        } else {
          dv.setUint32(e + 8, dataOff, le);
          for (let k = 0; k < s.length; k++) buf[dataOff + k] = s.charCodeAt(k);
          dataOff += s.length + (s.length & 1);
        }
      } else if (type === 'S') {
        dv.setUint16(e + 2, 3, le);
        dv.setUint32(e + 4, 1, le);
        dv.setUint16(e + 8, val, le);
      } else if (type === 'L') {
        dv.setUint16(e + 2, 4, le);
        dv.setUint32(e + 4, 1, le);
        dv.setUint32(e + 8, val, le);
      } else if (type === 'R') {
        const arr = Array.isArray(val[0]) ? val : [val];
        dv.setUint16(e + 2, 5, le);
        dv.setUint32(e + 4, arr.length, le);
        dv.setUint32(e + 8, dataOff, le);
        for (const [a, b] of arr) {
          dv.setUint32(dataOff, a, le);
          dv.setUint32(dataOff + 4, b, le);
          dataOff += 8;
        }
      }
    });
    dv.setUint32(off + 2 + ents.length * 12, 0, le);
  };
  writeIfd(i0, off0);
  writeIfd(ex, offE);
  writeIfd(gp, offG);
  return buf.slice(0, dataOff);
}

/** 十进制度 → EXIF 的度分秒分数 */
export function toDms(deg) {
  const a = Math.abs(deg);
  const d = Math.floor(a);
  const m = Math.floor((a - d) * 60);
  const s = Math.round(((a - d) * 60 - m) * 60 * 1000);
  return [[d, 1], [m, 1], [s, 1000]];
}

/** 常用的一组拍摄信息 */
export function sampleTags({ t = '2026:11:14 07:42:10', make = 'Canon', model = 'Canon EOS R5', lens = 'RF100-500mm F4.5-7.1 L IS USM', lat, lng, orientation = 1 } = {}) {
  const tags = {
    ifd0: [[0x010f, 'A', make], [0x0110, 'A', model], [0x0112, 'S', orientation], [0x0132, 'A', t]],
    exif: [
      [0x9003, 'A', t],
      [0x829a, 'R', [1, 2000]],
      [0x829d, 'R', [71, 10]],
      [0x8827, 'S', 800],
      [0x920a, 'R', [500, 1]],
      [0xa434, 'A', lens],
    ],
    gps: [],
  };
  if (lat != null && lng != null) {
    tags.gps = [
      [1, 'A', lat >= 0 ? 'N' : 'S'],
      [2, 'R', toDms(lat)],
      [3, 'A', lng >= 0 ? 'E' : 'W'],
      [4, 'R', toDms(lng)],
    ];
  }
  return tags;
}

function concat(parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** 在 JPEG 的开头插入一段 EXIF */
export function insertExif(jpeg, tiff) {
  const len = 2 + 6 + tiff.length;
  const head = new Uint8Array([0xff, 0xe1, len >> 8, len & 0xff, 0x45, 0x78, 0x69, 0x66, 0, 0]);
  return concat([jpeg.subarray(0, 2), head, tiff, jpeg.subarray(2)]);
}

/** 假的 TIFF 系 RAW（像 NEF/ARW/CR2）：TIFF 头和拍摄信息 + 一段乱数据 + 内嵌 JPEG 预览 + 一段乱数据 */
export function fakeTiffRaw(jpeg, tags) {
  const tiff = buildTiff(tags);
  const noise = (n, seed) => {
    const a = new Uint8Array(n);
    let x = seed;
    for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; a[i] = x >>> 24; }
    return a;
  };
  return concat([tiff, noise(5000, 7), jpeg, noise(20000, 99)]);
}

/** 假的佳能 CR3：ftyp 盒子 + 装着 CMT1/CMT2/CMT4 的盒子 + 内嵌 JPEG */
export function fakeCr3(jpeg, tags) {
  const box = (name, payload) => {
    const b = new Uint8Array(8 + payload.length);
    new DataView(b.buffer).setUint32(0, b.length);
    b.set(ascii(name), 4);
    b.set(payload, 8);
    return b;
  };
  const cmt1 = box('CMT1', buildTiff({ ifd0: tags.ifd0 }));
  const cmt2 = box('CMT2', buildTiff({ ifd0: tags.exif }));
  const parts = [cmt1, cmt2];
  if (tags.gps && tags.gps.length) parts.push(box('CMT4', buildTiff({ ifd0: tags.gps })));
  const moov = box('moov', concat(parts));
  const ftyp = box('ftyp', ascii('crx \x00\x00\x00\x01crx isom'));
  const mdat = box('mdat', concat([new Uint8Array(3000).fill(0x55), jpeg, new Uint8Array(3000).fill(0xaa)]));
  return concat([ftyp, moov, mdat]);
}

/** 结构合法的最小 JPEG（解不出画面，只用来测结构解析） */
export function structuralJpeg(width = 1620, height = 1080) {
  const seg = (m, payload) => concat([new Uint8Array([0xff, m, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
  return concat([
    new Uint8Array([0xff, 0xd8]),
    seg(0xdb, new Uint8Array(65).fill(1)),
    seg(0xc0, new Uint8Array([8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0])),
    seg(0xc4, new Uint8Array(20).fill(0)),
    seg(0xda, new Uint8Array([1, 1, 0, 0, 63, 0])),
    new Uint8Array([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a]),
    new Uint8Array([0xff, 0xd9]),
  ]);
}
