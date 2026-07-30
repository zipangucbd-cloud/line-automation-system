#!/usr/bin/env node
// xlsxパーサのデバッグ: ギフ回数シートの行数と列18/19の値分布をPython版と突き合わせる
const AdmZip = require('adm-zip');
const unesc = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#10;/g, '\n');
function parseXlsx(buf) {
  const zip = new AdmZip(buf);
  const read = (p) => { const e = zip.getEntry(p); return e ? zip.readAsText(e) : null; };
  const rels = read('xl/_rels/workbook.xml.rels') || '';
  const relmap = {};
  for (const m of rels.matchAll(/Id="(rId\d+)"[^>]*Target="(worksheets\/sheet\d+\.xml)"/g)) relmap[m[1]] = 'xl/' + m[2];
  const wb = read('xl/workbook.xml') || '';
  const sheets = {};
  for (const m of wb.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="(rId\d+)"[^>]*\/>/g)) if (relmap[m[2]]) sheets[unesc(m[1])] = relmap[m[2]];
  console.log('sheets found:', Object.keys(sheets).length, Object.keys(sheets).slice(0, 5));
  let shared = [];
  const ss = read('xl/sharedStrings.xml');
  if (ss) shared = [...ss.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unesc([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  console.log('shared strings:', shared.length);
  function rows(name) {
    const xml = read(sheets[name]);
    if (!xml) throw new Error('sheet not found: ' + name);
    const out = [];
    let pos = 0;
    while (true) {
      const rs = xml.indexOf('<row', pos);
      if (rs === -1) break;
      const rTagEnd = xml.indexOf('>', rs);
      if (rTagEnd === -1) break;
      if (xml[rTagEnd - 1] === '/') { pos = rTagEnd + 1; continue; }
      const re = xml.indexOf('</row>', rTagEnd);
      if (re === -1) break;
      const body = xml.slice(rTagEnd + 1, re);
      pos = re + 6;
      const cells = [];
      let i = 0;
      while (true) {
        const cs = body.indexOf('<c ', i);
        if (cs === -1) break;
        const tagEnd = body.indexOf('>', cs);
        if (tagEnd === -1) break;
        const selfClose = body[tagEnd - 1] === '/';
        const attrs = body.slice(cs + 3, selfClose ? tagEnd - 1 : tagEnd);
        let inner = '';
        if (selfClose) { i = tagEnd + 1; }
        else {
          const ce = body.indexOf('</c>', tagEnd);
          if (ce === -1) { i = tagEnd + 1; continue; }
          inner = body.slice(tagEnd + 1, ce);
          i = ce + 4;
        }
        const rm2 = attrs.match(/r="([A-Z]+)\d+"/);
        if (!rm2) continue;
        let ci = 0; for (const ch of rm2[1]) ci = ci * 26 + ch.charCodeAt(0) - 64; ci--;
        let val = '';
        if (inner) {
          const vs = inner.indexOf('<v>');
          if (/t="s"/.test(attrs) && vs !== -1) {
            val = shared[parseInt(inner.slice(vs + 3, inner.indexOf('</v>', vs)), 10)] || '';
          } else if (/t="inlineStr"/.test(attrs)) {
            val = unesc([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));
          } else if (vs !== -1) {
            val = unesc(inner.slice(vs + 3, inner.indexOf('</v>', vs)));
          }
        }
        if (val !== '') cells[ci] = val;
      }
      if (cells.length) out.push(cells);
    }
    return out;
  }
  return { rows, readRaw: read, sheets };
}
(async () => {
  const res = await fetch('https://docs.google.com/spreadsheets/d/1jDujnujP2dzaFNubqdUYc9DnYgP3ctM3srlQsmWJ8jc/export?format=xlsx', { redirect: 'follow' });
  const buf = Buffer.from(await res.arrayBuffer());
  console.log('xlsx bytes:', buf.length);
  const book = parseXlsx(buf);
  const K = book.rows('ギフ回数');
  console.log('ギフ回数 rows:', K.length);
  for (const col of [18, 19, 37]) {
    const cnt = {};
    for (const r of K) { const v = ((r[col] != null ? r[col] : '') + '').trim(); if (v) cnt[v.slice(0, 12)] = (cnt[v.slice(0, 12)] || 0) + 1; }
    console.log(`col${col}:`, JSON.stringify(cnt).slice(0, 300));
  }
  // 生XMLでのt="s"パターンの属性順チェック
  const xml = book.readRaw(book.sheets['ギフ回数']);
  const attrOrder = {};
  for (const m of xml.matchAll(/<c ([^>]*)>/g)) {
    const a = m[1];
    const key = a.replace(/"[^"]*"/g, '""').slice(0, 40);
    attrOrder[key] = (attrOrder[key] || 0) + 1;
  }
  console.log('cタグ属性パターン上位:', Object.entries(attrOrder).sort((a, b) => b[1] - a[1]).slice(0, 6));
})();
