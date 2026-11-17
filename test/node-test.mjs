// 在 Node 里跑的自检：RAW 解析、鸟种搜索、日期解析、合并逻辑。
// 用法：node test/node-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.fetch = async (url) => ({
  ok: true,
  status: 200,
  json: async () => JSON.parse(fs.readFileSync(String(url).startsWith('file:') ? fileURLToPath(url) : path.join(root, String(url).replace(/^\.\//, '')), 'utf8')),
});

const { parseMetaDate, fmtDate, fmtExposure, safeName } = await import('../js/util.js');
const { findEmbeddedJpegs, readRawMeta, readTiff } = await import('../js/rawfile.js');
const { loadTaxonomy, searchTaxa, speciesLevel, groupCode, spLabel } = await import('../js/taxonomy.js');
const synth = await import('./synth.js');
const exifr = await import('../vendor/exifr.js');

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };
const okAsync = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name); };

console.log('日期与格式');
ok('EXIF 日期', () => assert.equal(parseMetaDate('2026:11:14 07:42:10'), '2026-11-14T07:42:10'));
ok('XMP 日期带时区', () => assert.equal(parseMetaDate('2026-11-14T07:42:10-05:00'), '2026-11-14T07:42:10'));
ok('只有日期', () => assert.equal(parseMetaDate('2026-11-14'), '2026-11-14T00:00:00'));
ok('空日期', () => assert.equal(parseMetaDate('0000:00:00 00:00:00'), null));
ok('显示日期', () => assert.equal(fmtDate('2026-11-14'), '2026年11月14日 周六'));
ok('快门', () => { assert.equal(fmtExposure(1 / 2000), '1/2000s'); assert.equal(fmtExposure(2), '2s'); });
ok('文件夹名', () => assert.equal(safeName('2026-11-14 Bolsa Chica: north/side?'), '2026-11-14 Bolsa Chica north side'));

console.log('RAW 解析');
const jpegSmall = synth.structuralJpeg(160, 120);
const jpegBig = synth.structuralJpeg(8192, 5464);
const tags = synth.sampleTags({ lat: 33.69611, lng: -118.04639, orientation: 6 });
ok('结构 JPEG 可被识别', () => {
  const r = findEmbeddedJpegs(jpegBig);
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].start, r[0].end, r[0].width, r[0].height], [0, jpegBig.length, 8192, 5464]);
});
ok('TIFF 系 RAW：取最大的内嵌预览', () => {
  const withThumb = synth.insertExif(jpegBig, synth.buildTiff(synth.sampleTags()));
  const raw = synth.fakeTiffRaw(withThumb, tags);
  const big = new Uint8Array(raw.length + jpegSmall.length);
  big.set(raw); big.set(jpegSmall, raw.length);
  const r = findEmbeddedJpegs(big);
  assert.equal(r[0].width, 8192);
  assert.equal(r[1].width, 160);
  assert.equal(r[0].end - r[0].start, withThumb.length);
});
ok('TIFF 系 RAW：拍摄信息', () => {
  const m = readRawMeta(synth.fakeTiffRaw(jpegBig, tags));
  assert.equal(m.t, '2026-11-14T07:42:10');
  assert.equal(m.model, 'Canon EOS R5');
  assert.equal(m.lens, 'RF100-500mm F4.5-7.1 L IS USM');
  assert.equal(m.orientation, 6);
  assert.equal(m.iso, 800);
  assert.equal(m.fl, 500);
  assert.ok(Math.abs(m.ex - 1 / 2000) < 1e-9);
  assert.ok(Math.abs(m.fn - 7.1) < 1e-9);
  assert.ok(Math.abs(m.lat - 33.69611) < 1e-4, 'lat ' + m.lat);
  assert.ok(Math.abs(m.lng + 118.04639) < 1e-4, 'lng ' + m.lng);
});
ok('CR3：拍摄信息和预览', () => {
  const cr3 = synth.fakeCr3(jpegBig, tags);
  const m = readRawMeta(cr3);
  assert.equal(m.t, '2026-11-14T07:42:10');
  assert.equal(m.make, 'Canon');
  assert.equal(m.iso, 800);
  assert.ok(Math.abs(m.lat - 33.69611) < 1e-4);
  assert.equal(findEmbeddedJpegs(cr3)[0].width, 8192);
});
ok('乱数据不误报', () => {
  const junk = new Uint8Array(300000);
  let x = 5;
  for (let i = 0; i < junk.length; i++) { x = (x * 1103515245 + 12345) >>> 0; junk[i] = x >>> 24; }
  for (let i = 0; i < junk.length - 3; i += 997) { junk[i] = 0xff; junk[i + 1] = 0xd8; junk[i + 2] = 0xff; }
  assert.equal(findEmbeddedJpegs(junk).length, 0);
  assert.deepEqual(readRawMeta(junk), {});
  assert.equal(readTiff(new Uint8Array(4)), null);
});

console.log('exifr 读 JPEG');
await okAsync('读出时间、参数、GPS', async () => {
  const jpg = synth.insertExif(jpegBig, synth.buildTiff(tags));
  const o = await exifr.parse(jpg, { tiff: true, ifd0: true, exif: true, gps: true, xmp: true, reviveValues: false, translateValues: false });
  assert.equal(o.DateTimeOriginal, '2026:11:14 07:42:10');
  assert.equal(o.Model, 'Canon EOS R5');
  assert.equal(o.Orientation, 6);
  assert.equal(o.ISO, 800);
  assert.equal(o.FocalLength, 500);
  assert.ok(Math.abs(o.ExposureTime - 1 / 2000) < 1e-9);
  console.log('    latitude/longitude =', o.latitude, o.longitude, '| GPSLatitude =', JSON.stringify(o.GPSLatitude), o.GPSLatitudeRef);
});
await okAsync('没有 EXIF 的图返回空', async () => {
  const o = await exifr.parse(jpegBig, { tiff: true, exif: true, gps: true, reviveValues: false }).catch((e) => 'ERR ' + e.message);
  console.log('    结果 =', o);
});

console.log('鸟种名录');
await loadTaxonomy();
const first = (q) => searchTaxa(q)[0]?.code;
ok('英文前缀', () => assert.equal(first('northern card'), 'norcar'));
ok('英文各词开头', () => assert.equal(first('red tai haw'), 'rethaw'));
ok('中文名', () => assert.equal(first('主红雀'), 'norcar'));
ok('四字母代码', () => assert.equal(first('NOCA'), 'norcar'));
ok('四字母代码小写', () => assert.equal(first('rtha'), 'rethaw'));
ok('学名', () => assert.equal(first('Cardinalis cardinalis'), 'norcar'));
ok('带撇号', () => assert.equal(first("coopers hawk"), searchTaxa("Cooper's Hawk")[0].code));
ok('鸟种优先于杂交', () => assert.equal(first('mallard'), 'mallar3'));
ok('最近用过的排前面', () => {
  const plain = searchTaxa('hawk').map((t) => t.code);
  const boosted = searchTaxa('hawk', { boost: new Set([plain[5]]) }).map((t) => t.code);
  assert.ok(boosted.indexOf(plain[5]) < 5);
});
ok('归并到鸟种', () => {
  assert.equal(speciesLevel('norcar'), 'norcar');
  assert.equal(speciesLevel('rocpig1'), null);      // 驯养型不计
  assert.equal(speciesLevel('x00004'), null);        // 杂交不计
  assert.equal(speciesLevel('sobkiw2'), 'sobkiw1');  // 亚种归到鸟种
  assert.equal(groupCode('x00004'), 'x00004');
  assert.equal(spLabel('norcar'), '主红雀');
  assert.equal(spLabel(''), '未识别');
  assert.equal(spLabel('nosuch'), 'nosuch');
});
ok('搜索速度', () => {
  const t0 = performance.now();
  for (const q of ['a', 'wa', 'warb', 'yellow war', '莺', '鹰', 'buteo', 'sp']) searchTaxa(q);
  const ms = (performance.now() - t0) / 8;
  console.log('    平均每次 ' + ms.toFixed(1) + ' ms');
  assert.ok(ms < 60);
});

console.log(`\n全部通过：${n} 项`);
