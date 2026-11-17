// 从 eBird 官方接口下载鸟种名录（英文 + 简体中文），压缩成 data/taxonomy.json。
// 用法：node tools/build-taxonomy.js
// eBird 每年十月左右更新一次分类，届时重新运行本脚本即可。
const fs = require('fs');
const path = require('path');

const BASE = 'https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json';
const CATS = ['species', 'issf', 'hybrid', 'slash', 'spuh', 'domestic', 'form', 'intergrade'];

async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
  return r.json();
}

(async () => {
  const [en, zh, versions] = await Promise.all([
    get(BASE + '&locale=en'),
    get(BASE + '&locale=zh_SIM'),
    get('https://api.ebird.org/v2/ref/taxonomy/versions'),
  ]);
  const latest = (versions.find((v) => v.latest) || {}).authorityVer;
  const zhByCode = new Map(zh.map((t) => [t.speciesCode, t.comName]));

  en.sort((a, b) => a.taxonOrder - b.taxonOrder);

  const orders = [];
  const orderIdx = new Map();
  const families = [];
  const familyIdx = new Map();
  const taxa = [];
  let zhCount = 0;

  for (const t of en) {
    const cat = CATS.indexOf(t.category);
    if (cat < 0) throw new Error('未知类别: ' + t.category);
    let oi = -1;
    if (t.order) {
      if (!orderIdx.has(t.order)) { orderIdx.set(t.order, orders.length); orders.push(t.order); }
      oi = orderIdx.get(t.order);
    }
    let fi = -1;
    if (t.familyCode) {
      if (!familyIdx.has(t.familyCode)) {
        familyIdx.set(t.familyCode, families.length);
        families.push([t.familyCode, t.familySciName || '', t.familyComName || '', oi]);
      }
      fi = familyIdx.get(t.familyCode);
    }
    let zhName = zhByCode.get(t.speciesCode) || '';
    if (zhName === t.comName) zhName = '';
    if (zhName) zhCount++;
    const codes = [...(t.bandingCodes || []), ...(t.comNameCodes || [])];
    taxa.push([
      t.speciesCode,
      t.comName,
      zhName,
      t.sciName,
      cat,
      fi,
      [...new Set(codes)].join(' '),
      t.reportAs || '',
    ]);
  }

  const out = {
    version: latest ? String(latest) : '',
    fetched: new Date().toISOString().slice(0, 10),
    source: 'eBird/Clements taxonomy, api.ebird.org (Cornell Lab of Ornithology)',
    cats: CATS,
    orders,
    families,
    // 每条：[代码, 英文名, 中文名, 学名, 类别序号, 科序号, 四字母代码, 归并到的鸟种代码]，按分类顺序排列
    taxa,
  };
  const file = path.join(__dirname, '..', 'data', 'taxonomy.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out));
  const species = taxa.filter((t) => t[4] === 0).length;
  console.log(`版本 ${out.version}：共 ${taxa.length} 条，其中鸟种 ${species} 个，有中文名 ${zhCount} 条，${families.length} 科 ${orders.length} 目`);
  console.log(`已写入 ${file}（${(fs.statSync(file).size / 1024 / 1024).toFixed(2)} MB）`);
})().catch((e) => { console.error(e); process.exit(1); });
