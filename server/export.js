'use strict';
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const FONT = path.join(__dirname, '..', 'fonts', 'DejaVuSans.ttf');
const FONT_B = path.join(__dirname, '..', 'fonts', 'DejaVuSans-Bold.ttf');

const hmStr = m => { if (m == null || m === '') return ''; const neg = m < 0; m = Math.abs(Math.round(m)); return (neg ? '−' : '') + Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0'); };
function fmt(c, v, row) {
  if (v == null || v === '') return '';
  if (row && row._money && typeof v === 'number') return v.toFixed(2);
  switch (c.t) {
    case 'hm': case 'hmd': return typeof v === 'number' ? hmStr(v) : String(v);
    case 'money': return typeof v === 'number' ? v.toFixed(2) : String(v);
    case 'dec': return typeof v === 'number' ? v.toFixed(2) : String(v);
    case 'pallets': return typeof v === 'number' ? String(v).replace('.', ',') : String(v);
    default: return String(v);
  }
}
const colLetter = n => { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const NUMFMT = { hm: '[h]:mm', hmd: '[h]:mm;-[h]:mm', money: '#,##0.00', dec: '0.00', pallets: '0.0', int: '0' };

async function xlsx(rep) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Żabka Grafik';
  const used = new Set();
  rep.sections.forEach((s, si) => {
    let name = (s.title || rep.title || 'Sheet').replace(/[\\/?*[\]:]/g, ' ').slice(0, 28) || 'Sheet';
    while (used.has(name)) name = name.slice(0, 26) + si;
    used.add(name);
    const ws = wb.addWorksheet(name, { pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    ws.addRow([rep.title + (s.title ? ' — ' + s.title : '')]).font = { bold: true, size: 13 };
    ws.addRow([`${rep.locations}   ${rep.from} — ${rep.to}`]);
    ws.addRow([]);
    const cols = s.columns;
    if (s.grouped) {
      const gr = ws.addRow(cols.map(c => c.group || c.l));
      gr.font = { bold: true };
      let i = 0;
      while (i < cols.length) { let j = i; while (cols[i].group && j + 1 < cols.length && cols[j + 1].group === cols[i].group) j++; if (j > i) ws.mergeCells(gr.number, i + 1, gr.number, j + 1); i = j + 1; }
      ws.addRow(cols.map(c => c.sub || '')).font = { bold: true };
    } else ws.addRow(cols.map(c => c.l)).font = { bold: true };
    const headerRow = ws.rowCount;
    const firstData = headerRow + 1;
    const idx = {}; cols.forEach((c, i) => idx[c.k] = i);
    const toCell = (c, v) => {
      if (v == null || v === '') return null;
      if ((c.t === 'hm' || c.t === 'hmd') && typeof v === 'number') return v / 1440;
      return v;
    };
    const formulaFor = (c, rowNum) => c.f.replace(/\{(\w+)\}/g, (_, k) => colLetter(idx[k]) + rowNum);
    s.rows.forEach(r => {
      const row = ws.addRow(cols.map(c => toCell(c, r[c.k])));
      cols.forEach((c, i) => {
        if (c.f && cols.every(() => true) && /\{(\w+)\}/.test(c.f) && [...c.f.matchAll(/\{(\w+)\}/g)].every(m => idx[m[1]] != null))
          row.getCell(i + 1).value = { formula: formulaFor(c, row.number), result: toCell(c, r[c.k]) ?? 0 };
      });
      cols.forEach((c, i) => { if (NUMFMT[c.t]) row.getCell(i + 1).numFmt = NUMFMT[c.t]; });
      if (r._cls === 'sun') row.eachCell({ includeEmpty: true }, cell => cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF4C2' } });
      if (r._cls === 'warn' || r._cls === 'diff') row.eachCell({ includeEmpty: true }, cell => cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: r._cls === 'warn' ? 'FFFFD6D6' : 'FFFFE5C7' } });
    });
    const lastData = ws.rowCount;
    if (s.totalRow) {
      const tr = ws.addRow(cols.map((c, i) => i === 0 ? s.totalRow[c.k] : null));
      cols.forEach((c, i) => { if (c.sum) tr.getCell(i + 1).value = { formula: `SUM(${colLetter(i)}${firstData}:${colLetter(i)}${Math.max(firstData, lastData)})`, result: toCell(c, s.totalRow[c.k]) ?? 0 }; });
      cols.forEach((c, i) => { if (NUMFMT[c.t]) tr.getCell(i + 1).numFmt = NUMFMT[c.t]; });
      tr.font = { bold: true };
    }
    for (const r of s.afterRows || []) {
      const ar = ws.addRow(cols.map(c => typeof r[c.k] === 'number' ? r[c.k] : (r[c.k] ?? null)));
      cols.forEach((c, i) => { if (typeof r[c.k] === 'number') ar.getCell(i + 1).numFmt = NUMFMT.money; });
      ar.font = { bold: true };
    }
    cols.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      if (NUMFMT[c.t]) col.numFmt = NUMFMT[c.t];
      const maxLen = Math.max(String(c.group ? '' : c.l || '').length, String(c.sub || '').length, ...s.rows.slice(0, 200).map(r => fmt(c, r[c.k]).length));
      col.width = Math.min(c.wrap ? 50 : 30, Math.max(6, maxLen + 2));
      if (c.wrap) col.alignment = { wrapText: true, vertical: 'top' };
    });
    for (let r = headerRow - (s.grouped ? 1 : 0); r <= headerRow; r++) ws.getRow(r).eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3EFE6' } }; cell.border = { bottom: { style: 'thin' } }; cell.alignment = { wrapText: true, vertical: 'middle' }; });
    ws.views = [{ state: 'frozen', ySplit: headerRow }];
  });
  if (!rep.sections.length) wb.addWorksheet('—');
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function pdf(rep) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 24, bufferPages: true });
    const chunks = []; doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.registerFont('R', FONT); doc.registerFont('B', FONT_B);
    const M = 24, W = doc.page.width - 2 * M, H = doc.page.height - 2 * M;
    const header = () => {
      doc.font('B').fontSize(12).fillColor('#000').text(rep.title, M, M, { width: W });
      doc.font('R').fontSize(8).fillColor('#444').text(`${rep.locations}   ${rep.from} — ${rep.to}`, { width: W });
      doc.moveDown(0.3);
    };
    let firstPage = true;
    rep.sections.forEach(s => {
      if (!firstPage && (s.fitPage || doc.y > doc.page.height - M - 80)) { doc.addPage(); header(); }
      if (firstPage) { header(); firstPage = false; }
      const cols = s.columns;
      const rows = s.rows.slice();
      if (s.totalRow) rows.push({ ...s.totalRow, _cls: 'total' });
      if (s.afterRows) rows.push(...s.afterRows);
      const pad = 2;
      // measure natural widths at size 7
      let fs0 = 7.5;
      const measure = (fs) => cols.map(c => {
        doc.font('B').fontSize(fs);
        let w = Math.max(doc.widthOfString(String(s.grouped ? (c.sub || c.l) : c.l)), 10);
        for (const r of rows.slice(0, 400)) { doc.font(r._cls === 'total' || r._cls === 'bold' ? 'B' : 'R').fontSize(fs); w = Math.max(w, doc.widthOfString(fmt(c, r[c.k], r))); }
        return Math.min(w + 2 * pad + 1, c.wrap ? 200 : 260);
      });
      let widths = measure(fs0);
      let total = widths.reduce((a, b) => a + b, 0);
      const fitW = () => { let n = 0; while (total > W && fs0 > 3.5 && n++ < 8) { fs0 = Math.max(3.5, fs0 * W / total * 0.98); widths = measure(fs0); total = widths.reduce((a, b) => a + b, 0); } if (total > W) widths = widths.map(w => w * W / total); };
      fitW();
      if (s.fitPage) {
        const titleH = 14, headH = (s.grouped ? 2 : 1) * (fs0 * 1.45 + 2);
        const avail = doc.page.height - M - doc.y - titleH - headH;
        const rh = fs0 * 1.45 + 2;
        if (rows.length * rh > avail) { const k = avail / (rows.length * rh); fs0 = Math.max(3.5, fs0 * k); widths = measure(fs0); total = widths.reduce((a, b) => a + b, 0); fitW(); }
      } else if (total < W && cols.some(c => c.wrap)) {
        const extra = W - total; const wc = cols.filter(c => c.wrap).length; widths = widths.map((w, i) => cols[i].wrap ? w + extra / wc : w);
      }
      const rowH = fs0 * 1.45 + 2;
      if (s.title) { doc.font('B').fontSize(9).fillColor('#000').text(s.title, M, doc.y, { width: W }); doc.moveDown(0.2); }
      const drawHead = () => {
        let y = doc.y; doc.font('B').fontSize(fs0);
        if (s.grouped) {
          let x = M, i = 0;
          while (i < cols.length) {
            let j = i, w = widths[i];
            while (cols[i].group && j + 1 < cols.length && cols[j + 1].group === cols[i].group) { j++; w += widths[j]; }
            doc.rect(x, y, w, rowH).fillAndStroke('#dfeee3', '#9a9a9a'); doc.fillColor('#000').text(cols[i].group || cols[i].l, x + pad, y + 1.5, { width: w - 2 * pad, height: rowH, ellipsis: true, lineBreak: false, align: 'center' });
            x += w; i = j + 1;
          }
          y += rowH;
        }
        let x = M;
        cols.forEach((c, i) => { doc.rect(x, y, widths[i], rowH).fillAndStroke('#dfeee3', '#9a9a9a'); doc.fillColor('#000').text(s.grouped ? (c.sub || c.l) : c.l, x + pad, y + 1.5, { width: widths[i] - 2 * pad, height: rowH, ellipsis: true, lineBreak: false }); x += widths[i]; });
        doc.y = y + rowH;
      };
      drawHead();
      for (const r of rows) {
        doc.font(r._cls === 'total' || r._cls === 'bold' ? 'B' : 'R').fontSize(fs0);
        let h = rowH;
        cols.forEach((c, i) => { if (c.wrap) h = Math.max(h, doc.heightOfString(fmt(c, r[c.k], r), { width: widths[i] - 2 * pad }) + 3); });
        if (doc.y + h > doc.page.height - M) { doc.addPage(); doc.y = M; drawHead(); doc.font(r._cls === 'total' ? 'B' : 'R').fontSize(fs0); }
        const y = doc.y; let x = M;
        const bg = { sun: '#fff4c2', warn: '#ffd6d6', diff: '#ffe5c7', total: '#eeeeee' }[r._cls];
        cols.forEach((c, i) => {
          if (bg) doc.rect(x, y, widths[i], h).fillAndStroke(bg, '#bdbdbd'); else doc.rect(x, y, widths[i], h).stroke('#bdbdbd');
          const txt = fmt(c, r[c.k], r);
          const right = ['hm', 'hmd', 'money', 'dec', 'int', 'pallets'].includes(c.t);
          doc.fillColor(r._cls === 'warn' && c.k !== 'date' ? '#b00000' : '#000').text(txt, x + pad, y + 1.5, c.wrap ? { width: widths[i] - 2 * pad } : { width: widths[i] - 2 * pad, height: h, ellipsis: true, lineBreak: false, align: right ? 'right' : 'left' });
          x += widths[i];
        });
        doc.y = y + h;
      }
      doc.moveDown(0.8);
      doc.x = M;
    });
    if (!rep.sections.length) header();
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) { doc.switchToPage(i); doc.page.margins.bottom = 0; doc.font('R').fontSize(6).fillColor('#888').text(`Żabka Grafik · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${i + 1}/${range.count}`, M, doc.page.height - 16, { width: W, align: 'right', lineBreak: false }); }
    doc.end();
  });
}

function ods(xbuf) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zabka-'));
    const inp = path.join(dir, 'report.xlsx');
    fs.writeFileSync(inp, xbuf);
    const bin = process.env.SOFFICE || 'soffice';
    execFile(bin, ['--headless', '--convert-to', 'ods', '--outdir', dir, inp], { timeout: 60000 }, (err) => {
      try {
        if (err) return reject(Object.assign(new Error('ODS export requires LibreOffice (soffice) on the server. Use .xlsx instead.'), { status: 501 }));
        const out = fs.readFileSync(path.join(dir, 'report.ods'));
        fs.rmSync(dir, { recursive: true, force: true });
        resolve(out);
      } catch (e) { reject(e); }
    });
  });
}
module.exports = { xlsx, pdf, ods, fmt };
