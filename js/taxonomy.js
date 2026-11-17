// eBird 鸟种名录：加载 data/taxonomy.json，提供按代码查找和搜索。

let T = null;
let loading = null;

export const CAT_LABEL = {
  species: '',
  issf: '亚种',
  form: '型',
  intergrade: '亚种间',
  domestic: '驯养型',
  hybrid: '杂交',
  slash: '未定到种',
  spuh: '未定到种',
};

/** 搜索用的规范化：小写、去重音、去撇号，连字符当空格 */
export function norm(s) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’`.]/g, '')
    .replace(/[-/(),]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function build(raw) {
  const byCode = new Map();
  const taxa = raw.taxa.map((a, i) => {
    const enN = norm(a[1]);
    const t = {
      i,
      code: a[0],
      en: a[1],
      zh: a[2],
      sci: a[3],
      cat: raw.cats[a[4]],
      fam: a[5],
      codes: a[6] ? a[6].split(' ') : [],
      reportAs: a[7] || '',
      enN,
      words: enN.split(' '),
      sciN: a[3].toLowerCase(),
    };
    byCode.set(t.code, t);
    return t;
  });
  T = {
    version: raw.version,
    fetched: raw.fetched,
    taxa,
    byCode,
    families: raw.families.map((f) => ({ code: f[0], sci: f[1], en: f[2], order: raw.orders[f[3]] || '' })),
  };
  return T;
}

export function loadTaxonomy() {
  if (!loading) {
    loading = fetch(new URL('../data/taxonomy.json', import.meta.url))
      .then((r) => {
        if (!r.ok) throw new Error('鸟种名录加载失败 (' + r.status + ')');
        return r.json();
      })
      .then(build)
      .catch((e) => { loading = null; throw e; });
  }
  return loading;
}

export const taxonomyReady = () => !!T;
export const taxonomyInfo = () => (T ? { version: T.version, fetched: T.fetched, count: T.taxa.length } : null);

export function taxon(code) {
  return T && code ? T.byCode.get(code) || null : null;
}

export function family(t) {
  return T && t && t.fam >= 0 ? T.families[t.fam] : null;
}

/** 主显示名：有中文名用中文名，否则英文名 */
export function spLabel(code) {
  if (!code) return '未识别';
  const t = taxon(code);
  return t ? t.zh || t.en : code;
}

export function spEn(code) {
  const t = taxon(code);
  return t ? t.en : '';
}

/**
 * 计入「已拍鸟种」时归到哪个鸟种：鸟种本身算自己，亚种和色型归到所属鸟种；
 * 杂交、未定到种、驯养型不计入，返回 null。这和 eBird 生涯清单的算法一致。
 */
export function speciesLevel(code) {
  const t = taxon(code);
  if (!t) return null;
  if (t.cat === 'species') return t.code;
  if (t.reportAs && (t.cat === 'issf' || t.cat === 'form' || t.cat === 'intergrade')) {
    const parent = taxon(t.reportAs);
    if (parent && parent.cat === 'species') return parent.code;
  }
  return null;
}

/** 鸟种页里归到哪一组 */
export const groupCode = (code) => (code ? speciesLevel(code) || code : '');

export function taxonOrder(code) {
  const t = taxon(code);
  return t ? t.i : 1e9;
}

/**
 * 搜索鸟种。支持中文名、英文名（可只打每个词的开头，如 "red tai haw"）、学名、
 * 四字母代码（如 NOCA）和 eBird 六位代码。boost 里的代码（比如最近用过的）排前面。
 */
export function searchTaxa(q, { limit = 40, boost } = {}) {
  if (!T) return [];
  const raw = q.trim();
  if (!raw) return [];
  const hasCjk = /[㐀-鿿]/.test(raw);
  const qn = norm(raw);
  const toks = qn.split(' ').filter(Boolean);
  const lower = raw.toLowerCase();
  const upper = raw.toUpperCase();
  const out = [];
  for (const t of T.taxa) {
    let score = 0;
    if (hasCjk) {
      const k = t.zh.indexOf(raw);
      if (k === 0) score = t.zh.length === raw.length ? 100 : 90;
      else if (k > 0) score = 70;
    } else {
      if (raw.length === 4 && t.codes.includes(upper)) score = 99;
      else if (t.code === lower) score = 98;
      else if (t.enN === qn) score = 97;
      else if (qn && t.enN.startsWith(qn + ' ')) score = 90;
      // 名字里完整包含这几个词（如搜 "hawk" 找到 "Red-tailed Hawk"，搜 "yellow warbler" 找到 "Northern Yellow Warbler"）
      else if (qn.length >= 3 && (' ' + t.enN + ' ').includes(' ' + qn + ' ')) score = 87;
      else if (qn && t.enN.startsWith(qn)) score = 85;
      else if (qn.length >= 3 && (' ' + t.enN).includes(' ' + qn)) score = 83;
      else if (toks.length && toks.every((tok) => t.words.some((w) => w.startsWith(tok)))) score = t.words[0].startsWith(toks[0]) ? 82 : 78;
      else if (qn.length >= 3 && t.enN.includes(qn)) score = 60;
      else if (lower.length >= 3 && t.sciN.startsWith(lower)) score = 75;
      else if (lower.length >= 4 && t.sciN.includes(lower)) score = 50;
    }
    if (!score) continue;
    if (t.cat === 'species') score += 6;
    else if (t.cat === 'issf' || t.cat === 'form') score -= 2;
    else score -= 4;
    if (boost && boost.has(t.code)) score += 5;
    out.push([score, t]);
  }
  out.sort((a, b) => b[0] - a[0]
    || (hasCjk ? a[1].zh.length - b[1].zh.length : a[1].en.length - b[1].en.length)
    || a[1].i - b[1].i);
  return out.slice(0, limit).map((x) => x[1]);
}
