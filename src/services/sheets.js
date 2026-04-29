const { google } = require('googleapis');

let sheetsClientPromise;

function getServiceAccountCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
}

async function getSheetsClient() {
  if (!sheetsClientPromise) {
    const creds = getServiceAccountCredentials();
    if (!creds) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set (required for Google Sheets)');
    }
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheetsClientPromise = google.sheets({ version: 'v4', auth });
  }
  return sheetsClientPromise;
}

/** Normalize to digits only for matching */
function digitsOnly(phone) {
  return String(phone || '').replace(/\D/g, '');
}

/**
 * Match variants: E.164, national 10-digit US, last 10 digits.
 */
function phoneMatchKeys(raw) {
  const d = digitsOnly(raw);
  const keys = new Set();
  if (d) keys.add(d);
  if (d.length === 11 && d.startsWith('1')) keys.add(d.slice(1));
  if (d.length > 10) keys.add(d.slice(-10));
  return [...keys];
}

function normalizeHeaderMap(headerRow) {
  const map = {};
  headerRow.forEach((h, i) => {
    if (h == null || h === '') return;
    const key = String(h).trim().toLowerCase().replace(/\s+/g, '_');
    map[key] = i;
  });
  return map;
}

async function readTab(spreadsheetId, tabName, rangeSuffix = '') {
  const sheets = await getSheetsClient();
  const range = rangeSuffix ? `'${tabName.replace(/'/g, "''")}'!${rangeSuffix}` : `'${tabName.replace(/'/g, "''")}'`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  return res.data.values || [];
}

/**
 * Find 1-based row index (including header) for prospect by phone column.
 */
async function findProspectRow(spreadsheetId, tabName, phone) {
  const rows = await readTab(spreadsheetId, tabName, 'A:Z');
  if (!rows.length) return { row: null, headers: {}, rowData: null };

  const headers = normalizeHeaderMap(rows[0]);
  const phoneCol =
    headers.phone ?? headers['phone_number'] ?? headers.mobile ?? headers.cell;
  if (phoneCol === undefined) {
    throw new Error(`Sheet tab "${tabName}" must have a "phone" column in row 1`);
  }

  const keys = phoneMatchKeys(phone);
  for (let i = 1; i < rows.length; i++) {
    const cell = rows[i][phoneCol];
    const cellKeys = phoneMatchKeys(cell);
    if (keys.some((k) => cellKeys.includes(k))) {
      return { row: i + 1, headers, rowData: rows[i] };
    }
  }
  return { row: null, headers, rowData: null };
}

async function updateCells(spreadsheetId, tabName, updates) {
  const sheets = await getSheetsClient();
  const data = updates.map(({ row, colLetter, value }) => ({
    range: `'${tabName.replace(/'/g, "''")}'!${colLetter}${row}`,
    values: [[value]],
  }));
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data,
    },
  });
}

function colLetterFromIndex(zeroBasedIndex) {
  let n = zeroBasedIndex;
  let s = '';
  while (n >= 0) {
    s = String.fromCharCode((n % 26) + 65) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

/**
 * Update prospect row fields by header names (partial update).
 */
async function updateProspectByHeaders(spreadsheetId, tabName, rowNumber, headersMap, fields) {
  const updates = [];
  for (const [headerKey, value] of Object.entries(fields)) {
    const norm = String(headerKey).trim().toLowerCase().replace(/\s+/g, '_');
    const colIdx = headersMap[norm];
    if (colIdx === undefined) {
      console.warn('[Sheets] Unknown column', { headerKey: norm });
      continue;
    }
    const letter = colLetterFromIndex(colIdx);
    updates.push({ row: rowNumber, colLetter: letter, value });
  }
  if (updates.length) await updateCells(spreadsheetId, tabName, updates);
}

async function appendRow(spreadsheetId, tabName, values) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${tabName.replace(/'/g, "''")}'!A:Z`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] },
  });
  const updatedRange = res.data.updates?.updatedRange || '';
  const m = updatedRange.match(/!A(\d+)/);
  const rowNum = m ? parseInt(m[1], 10) : null;
  return { updatedRange, rowNum };
}

async function appendDnc(spreadsheetId, tabName, { phone, reason, at }) {
  const ts = at || new Date().toISOString();
  await appendRow(spreadsheetId, tabName, [ts, phone, reason || 'dnc'].filter(Boolean));
}

/** Return Set of digit keys present in DNC tab (column phone — col B if header says phone, else col A). */
async function loadDncPhoneKeys(spreadsheetId, tabName) {
  const rows = await readTab(spreadsheetId, tabName, 'A:Z');
  if (!rows.length) return new Set();
  const headers = normalizeHeaderMap(rows[0]);
  let col = headers.phone ?? headers.mobile;
  if (col === undefined) col = rows[0].length > 1 ? 1 : 0;
  const set = new Set();
  for (let i = 1; i < rows.length; i++) {
    const cell = rows[i][col];
    phoneMatchKeys(cell).forEach((k) => set.add(k));
  }
  return set;
}

/** Parse A1 or default B2 → { sheet: tabName or default, cell: A1 } */
function parseCellRef(ref, defaultTab) {
  const r = String(ref || '').trim();
  if (!r) return { tab: defaultTab, cell: 'B2' };
  if (r.includes('!')) {
    const [tabPart, cellPart] = r.split('!');
    const tab = tabPart.replace(/^'+|'+$/g, '');
    return { tab, cell: cellPart };
  }
  return { tab: defaultTab, cell: r };
}

async function getSettingCell(spreadsheetId, client) {
  const tab = client.sheet_tab_settings || 'Settings';
  const ref = parseCellRef(client.settings_last_email_check_cell, tab);
  const rows = await readTab(spreadsheetId, ref.tab, ref.cell);
  const val = rows[0]?.[0];
  return { ...ref, value: val != null && val !== '' ? String(val) : null };
}

function splitA1(a1) {
  const m = String(a1).match(/^([A-Za-z]+)(\d+)$/);
  if (!m) return { col: 'B', row: 2 };
  return { col: m[1].toUpperCase(), row: parseInt(m[2], 10) };
}

async function setLastEmailCheckIso(spreadsheetId, client, isoString) {
  const tab = client.sheet_tab_settings || 'Settings';
  const ref = parseCellRef(client.settings_last_email_check_cell, tab);
  const { col, row } = splitA1(ref.cell);
  await updateCells(spreadsheetId, ref.tab, [{ row, colLetter: col, value: isoString }]);
}

const EMAIL_LOG_HEADERS = ['timestamp_utc', 'sender_email', 'sender_name', 'subject', 'status', 'gmail_message_id'];

async function ensureEmailLogHeaders(spreadsheetId, tabName) {
  const sheets = await getSheetsClient();
  const range = `'${tabName.replace(/'/g, "''")}'!A1:F1`;
  const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const first = existing.data.values?.[0];
  if (!first || !first.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: [EMAIL_LOG_HEADERS] },
    });
  }
}

async function appendEmailLogPending(spreadsheetId, tabName, row) {
  await ensureEmailLogHeaders(spreadsheetId, tabName);
  const values = [
    row.timestamp,
    row.senderEmail,
    row.senderName,
    row.subject,
    'pending',
    row.gmailMessageId,
  ];
  return appendRow(spreadsheetId, tabName, values);
}

async function markEmailLogHandled(spreadsheetId, tabName, rowNumber) {
  if (!rowNumber) return;
  const sheets = await getSheetsClient();
  const headers = await readTab(spreadsheetId, tabName, 'A1:F1');
  const map = normalizeHeaderMap(headers[0] || []);
  const statusCol = map.status;
  if (statusCol === undefined) return;
  const letter = colLetterFromIndex(statusCol);
  await updateCells(spreadsheetId, tabName, [{ row: rowNumber, colLetter: letter, value: 'handled' }]);
}

module.exports = {
  getSheetsClient,
  phoneMatchKeys,
  digitsOnly,
  findProspectRow,
  updateProspectByHeaders,
  appendDnc,
  loadDncPhoneKeys,
  getSettingCell,
  setLastEmailCheckIso,
  appendEmailLogPending,
  markEmailLogHandled,
  readTab,
};
