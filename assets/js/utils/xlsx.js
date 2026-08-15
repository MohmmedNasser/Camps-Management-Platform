/**
 * Minimal .xlsx writer — no dependencies, no build step, no network.
 *
 * An .xlsx file is a ZIP of XML parts. This module writes the smallest set of
 * parts Excel, LibreOffice and Google Sheets all accept, and zips them with the
 * "stored" method (no compression), which needs nothing but a CRC-32.
 *
 * Deliberately small: one sheet, inline strings, a bold frozen header row and
 * a right-to-left sheet view. It knows nothing about the domain — callers hand
 * it columns and rows. When the Supabase backend lands this file is unchanged;
 * only the query feeding it moves.
 */

/* ---- ZIP ---------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const utf8 = (text) => new TextEncoder().encode(text);

/** Little-endian writer over a fixed-size buffer. */
function writer(size) {
  const bytes = new Uint8Array(size);
  let at = 0;
  return {
    bytes,
    u16(value) {
      bytes[at] = value & 0xff;
      bytes[at + 1] = (value >>> 8) & 0xff;
      at += 2;
    },
    u32(value) {
      bytes[at] = value & 0xff;
      bytes[at + 1] = (value >>> 8) & 0xff;
      bytes[at + 2] = (value >>> 16) & 0xff;
      bytes[at + 3] = (value >>> 24) & 0xff;
      at += 4;
    },
    raw(chunk) {
      bytes.set(chunk, at);
      at += chunk.length;
    },
    get length() {
      return at;
    },
  };
}

/**
 * Build a ZIP archive from `[{ name, text }]` entries, stored uncompressed.
 * Entry names here are always ASCII; the payloads are UTF-8.
 */
function zip(entries) {
  const files = entries.map((entry) => {
    const name = utf8(entry.name);
    const data = utf8(entry.text);
    return { name, data, crc: crc32(data) };
  });

  const localSize = files.reduce((sum, f) => sum + 30 + f.name.length + f.data.length, 0);
  const centralSize = files.reduce((sum, f) => sum + 46 + f.name.length, 0);
  const out = writer(localSize + centralSize + 22);

  const offsets = [];
  files.forEach((file) => {
    offsets.push(out.length);
    out.u32(0x04034b50); // local file header
    out.u16(20); // version needed
    out.u16(0); // flags
    out.u16(0); // method: stored
    out.u16(0); // mod time
    out.u16(0x21); // mod date (1980-01-01)
    out.u32(file.crc);
    out.u32(file.data.length);
    out.u32(file.data.length);
    out.u16(file.name.length);
    out.u16(0); // extra length
    out.raw(file.name);
    out.raw(file.data);
  });

  const centralStart = out.length;
  files.forEach((file, index) => {
    out.u32(0x02014b50); // central directory header
    out.u16(20); // version made by
    out.u16(20); // version needed
    out.u16(0);
    out.u16(0);
    out.u16(0);
    out.u16(0x21);
    out.u32(file.crc);
    out.u32(file.data.length);
    out.u32(file.data.length);
    out.u16(file.name.length);
    out.u16(0); // extra
    out.u16(0); // comment
    out.u16(0); // disk
    out.u16(0); // internal attrs
    out.u32(0); // external attrs
    out.u32(offsets[index]);
    out.raw(file.name);
  });

  // Measured before the end record is written — writing it advances `length`.
  const directoryBytes = out.length - centralStart;

  out.u32(0x06054b50); // end of central directory
  out.u16(0); // this disk
  out.u16(0); // disk with the directory
  out.u16(files.length); // entries on this disk
  out.u16(files.length); // entries total
  out.u32(directoryBytes);
  out.u32(centralStart);
  out.u16(0); // comment length

  return new Blob([out.bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/* ---- Sheet XML ----------------------------------------------------------- */

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Control characters are illegal in XML 1.0 and would corrupt the file.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/** 0 -> "A", 25 -> "Z", 26 -> "AA" */
function columnLetter(index) {
  let letter = '';
  let n = index;
  do {
    letter = String.fromCharCode(65 + (n % 26)) + letter;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return letter;
}

function cell(reference, value, { header = false } = {}) {
  const style = header ? ' s="1"' : '';

  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${reference}"${style}><v>${value}</v></c>`;
  }

  const text = value === null || value === undefined ? '' : String(value);
  if (!text) return `<c r="${reference}"${style}/>`;

  return `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(
    text
  )}</t></is></c>`;
}

function sheetXml(columns, rows) {
  const widths = columns
    .map(
      (column, index) =>
        `<col min="${index + 1}" max="${index + 1}" width="${column.width || 18}" customWidth="1"/>`
    )
    .join('');

  const headerRow = `<row r="1">${columns
    .map((column, index) => cell(`${columnLetter(index)}1`, column.label, { header: true }))
    .join('')}</row>`;

  const bodyRows = rows
    .map((row, rowIndex) => {
      const number = rowIndex + 2;
      const cells = columns
        .map((column, index) => cell(`${columnLetter(index)}${number}`, row[column.key]))
        .join('');
      return `<row r="${number}">${cells}</row>`;
    })
    .join('');

  const lastColumn = columnLetter(Math.max(0, columns.length - 1));

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView rightToLeft="1" tabSelected="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${widths}</cols>
<sheetData>${headerRow}${bodyRows}</sheetData>
<autoFilter ref="A1:${lastColumn}${rows.length + 1}"/>
</worksheet>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

/** Two cell formats: 0 = normal, 1 = bold (the header row). */
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function workbookXml(sheetName) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
}

/* ---- Public API ---------------------------------------------------------- */

/**
 * Build a one-sheet workbook as a Blob.
 *
 * @param {{key: string, label: string, width?: number}[]} columns
 * @param {object[]} rows plain objects keyed by `column.key`
 * @param {string} [sheetName]
 */
export function buildWorkbook(columns, rows, sheetName = 'Sheet1') {
  // Excel rejects sheet names over 31 chars or containing : \ / ? * [ ]
  const safeName = String(sheetName).replace(/[:\\/?*[\]]/g, ' ').slice(0, 31) || 'Sheet1';

  return zip([
    { name: '[Content_Types].xml', text: CONTENT_TYPES },
    { name: '_rels/.rels', text: ROOT_RELS },
    { name: 'xl/workbook.xml', text: workbookXml(safeName) },
    { name: 'xl/_rels/workbook.xml.rels', text: WORKBOOK_RELS },
    { name: 'xl/styles.xml', text: STYLES },
    { name: 'xl/worksheets/sheet1.xml', text: sheetXml(columns, rows) },
  ]);
}

/** Hand a Blob to the browser as a download. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** `النازحون-2026-08-15.xlsx` */
export function timestampedName(base, { filtered = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  return `${base}${filtered ? '-نتائج-مفلترة' : ''}-${today}.xlsx`;
}

/** Build and download in one call. Returns the number of rows written. */
export function exportSheet({ columns, rows, filename, sheetName }) {
  downloadBlob(buildWorkbook(columns, rows, sheetName), filename);
  return rows.length;
}
