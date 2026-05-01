/**
 * Parse CSV buffer (UTF-8) into row objects with `phone` + header columns.
 * Phone column: phone | phone_number | mobile (first column if no header match).
 */
function parseCsvToLeadRows(buf) {
  const text = buf.toString('utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { headerRow: null, rows: [], csv_rows: 0 };

  const rawHeader = lines[0].split(',').map((s) => s.trim().replace(/^"|"$/g, '').toLowerCase());
  const hasHeader = rawHeader.some((h) => h === 'phone' || h === 'phone_number' || h === 'mobile');
  const headerRow = hasHeader ? rawHeader : null;
  const dataLines = hasHeader ? lines.slice(1) : lines;

  const normKey = (k) => String(k || '').trim().toLowerCase().replace(/\s+/g, '_');

  const rows = [];
  for (const line of dataLines) {
    const cells = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') inQ = !inQ;
      else if (ch === ',' && !inQ) {
        cells.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    cells.push(cur.trim());

    let phoneIdx = 0;
    if (headerRow) {
      phoneIdx = headerRow.findIndex((h) => h === 'phone' || h === 'phone_number' || h === 'mobile');
      if (phoneIdx < 0) phoneIdx = 0;
    }
    const phone = cells[phoneIdx] ? cells[phoneIdx].replace(/^"|"$/g, '').trim() : '';
    if (!phone) continue;

    const obj = { phone };
    if (headerRow) {
      headerRow.forEach((h, i) => {
        if (i === phoneIdx) return;
        const k = normKey(h);
        if (!k) return;
        if (cells[i] != null && cells[i] !== '') obj[k] = cells[i].replace(/^"|"$/g, '').trim();
      });
    }
    rows.push(obj);
  }

  return { headerRow, rows, csv_rows: rows.length };
}

module.exports = { parseCsvToLeadRows };
