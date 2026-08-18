/* =========================================================================
   A real .xlsx, written by hand.

   WHY THIS EXISTS
   ---------------
   The admin panel has to hand somebody a spreadsheet they can open in Excel
   and upload to Meta. There is no bundler in this repo and no npm package
   reaches the Workers runtime at request time, so SheetJS is not an option —
   and a .csv renamed .xlsx is not a spreadsheet, it is a file Excel argues
   with. Meta's catalogue upload rejects it outright.

   An .xlsx is a ZIP of XML. Both halves are small enough to write directly:
   the ZIP needs one CRC32 and three record layouts, and the OOXML needs five
   parts. That is this file. Nothing here is generic — it writes the one
   shape of workbook this site needs and no more.

   STORED, NOT DEFLATED
   --------------------
   Every entry goes in uncompressed (method 0). The runtime does have
   CompressionStream('deflate-raw'), but a stored entry needs no stream, no
   await inside the writer, and no second size to track — and the largest
   workbook here is a 60-row catalogue, tens of kilobytes. Excel, Numbers,
   LibreOffice and Meta's uploader all read stored entries; the format has
   allowed them since 1989.

   FIXED TIMESTAMP
   ---------------
   Every entry is stamped 1980-01-01, the DOS epoch, rather than "now". The
   modification time of a file inside a generated download is noise nobody
   reads, and pinning it makes the bytes a pure function of the input — which
   is what lets test/xlsx.test.js assert on them.

   SHARED STRINGS
   --------------
   Text goes in the shared string table and cells reference it by index. That
   is what Excel itself produces (see the supplied VG_Meta_Catalog.xlsx, which
   is entirely t="s"), and in a catalogue where "in stock" and "new" repeat on
   every row it is also the smaller file.
   ========================================================================= */

/* -------------------------------------------------------------------------
   CRC32 — required by the ZIP central directory, one table, computed once.
   ------------------------------------------------------------------------- */
let CRC_TABLE = null;

function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

function crc32(bytes) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* -------------------------------------------------------------------------
   ZIP

   Three records, in the order the spec wants them: a local header + data per
   entry, then the central directory, then the end-of-central-directory.
   ------------------------------------------------------------------------- */
const DOS_TIME = 0;        /* 00:00:00 */
const DOS_DATE = 33;       /* 1980-01-01 — (0 << 9) | (1 << 5) | 1 */

function zip(entries) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const data = e.bytes;
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);   /* local file header signature */
    lv.setUint16(4, 20, true);           /* version needed */
    lv.setUint16(6, 0, true);            /* flags */
    lv.setUint16(8, 0, true);            /* method: stored */
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); /* compressed   == uncompressed */
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);           /* extra length */
    local.set(nameBytes, 30);

    parts.push(local, data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);   /* central directory signature */
    cv.setUint16(4, 20, true);           /* version made by */
    cv.setUint16(6, 20, true);           /* version needed */
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);           /* extra */
    cv.setUint16(32, 0, true);           /* comment */
    cv.setUint16(34, 0, true);           /* disk number start */
    cv.setUint16(36, 0, true);           /* internal attributes */
    cv.setUint32(38, 0, true);           /* external attributes */
    cv.setUint32(42, offset, true);      /* offset of the local header */
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  let centralSize = 0;
  for (const c of central) centralSize += c.length;

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  let total = offset + centralSize + end.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts)   { out.set(p, at); at += p.length; }
  for (const c of central) { out.set(c, at); at += c.length; }
  out.set(end, at);
  return out;
}

/* -------------------------------------------------------------------------
   XML

   The five characters XML reserves, plus the control characters XML 1.0
   forbids outright. A raw 0x0B in a product name does not produce a warning,
   it produces a workbook Excel refuses to open — and the text here comes out
   of a database an administrator types into.
   ------------------------------------------------------------------------- */
function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    /* eslint-disable-next-line no-control-regex */
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/* A1, B1 … Z1, AA1. Columns past 26 exist here because the offline-conversion
   sheet is wider than the alphabet. */
function colName(i) {
  let n = i + 1, s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/* -------------------------------------------------------------------------
   Styles

   Deliberately the same look as the VG_Meta_Catalog.xlsx the shop supplied:
   a bold Arial header on yellow, Arial body on white, thin borders
   throughout, and the short columns centred.

   The supplied file paints its body fill with <fgColor theme="0"/>, which
   costs a whole theme1.xml part to resolve one colour. An explicit white says
   the same thing and lets the workbook drop the theme entirely.
   ------------------------------------------------------------------------- */
export const S_DEFAULT = 0;
export const S_BODY    = 1;
export const S_HEAD    = 2;
export const S_HEAD_C  = 3;
export const S_BODY_C  = 4;

const STYLES = XML_HEAD +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="3">' +
      '<font><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/></font>' +
      '<font><sz val="11"/><color rgb="FF000000"/><name val="Arial"/></font>' +
      '<font><b/><sz val="11"/><color rgb="FF000000"/><name val="Arial"/></font>' +
    '</fonts>' +
    '<fills count="4">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/><bgColor indexed="64"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="2">' +
      '<border><left/><right/><top/><bottom/><diagonal/></border>' +
      '<border>' +
        '<left style="thin"><color indexed="64"/></left>' +
        '<right style="thin"><color indexed="64"/></right>' +
        '<top style="thin"><color indexed="64"/></top>' +
        '<bottom style="thin"><color indexed="64"/></bottom>' +
        '<diagonal/>' +
      '</border>' +
    '</borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="5">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>' +
      '<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>' +
      '<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>' +
      '<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '<dxfs count="0"/>' +
    '<tableStyles count="0" defaultTableStyle="TableStyleMedium9"/>' +
  '</styleSheet>';

/* -------------------------------------------------------------------------
   The public shape.

   buildWorkbook([{ name, columns, rows }]) -> Uint8Array

   `columns` is [{ header, width, center }]. `rows` is an array of arrays; a
   cell is either a primitive or { v, number: true }. Numbers are written as
   numeric cells so Excel can total a column — a total that arrives as text is
   a support call.
   ------------------------------------------------------------------------- */
export function buildWorkbook(sheets) {
  if (!sheets || !sheets.length) throw new Error('a workbook needs at least one sheet');

  const enc = new TextEncoder();
  const shared = [];
  const sharedIndex = new Map();

  function stringId(text) {
    const s = String(text);
    let id = sharedIndex.get(s);
    if (id === undefined) {
      id = shared.length;
      shared.push(s);
      sharedIndex.set(s, id);
    }
    return id;
  }

  const sheetXml = sheets.map((sheet) => {
    const cols = sheet.columns || [];
    let xml = XML_HEAD +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetFormatPr defaultColWidth="12" defaultRowHeight="15"/>';

    if (cols.length) {
      xml += '<cols>';
      cols.forEach((c, i) => {
        xml += `<col min="${i + 1}" max="${i + 1}" width="${c.width || 16}" customWidth="1"/>`;
      });
      xml += '</cols>';
    }

    xml += '<sheetData>';

    /* Header */
    xml += '<row r="1">';
    cols.forEach((c, i) => {
      const style = c.center ? S_HEAD_C : S_HEAD;
      xml += `<c r="${colName(i)}1" s="${style}" t="s"><v>${stringId(c.header)}</v></c>`;
    });
    xml += '</row>';

    /* Body */
    (sheet.rows || []).forEach((row, r) => {
      const n = r + 2;
      xml += `<row r="${n}">`;
      row.forEach((raw, i) => {
        const col = cols[i] || {};
        const style = col.center ? S_BODY_C : S_BODY;
        const ref = `${colName(i)}${n}`;
        const cell = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { v: raw };

        if (cell.v === null || cell.v === undefined || cell.v === '') {
          /* An empty cell still carries the style, so the banding and the
             borders do not stop halfway across a row that happens to have a
             blank in it. */
          xml += `<c r="${ref}" s="${style}"/>`;
          return;
        }
        if (cell.number) {
          xml += `<c r="${ref}" s="${style}"><v>${Number(cell.v)}</v></c>`;
          return;
        }
        xml += `<c r="${ref}" s="${style}" t="s"><v>${stringId(cell.v)}</v></c>`;
      });
      xml += '</row>';
    });

    xml += '</sheetData></worksheet>';
    return xml;
  });

  const sharedXml = XML_HEAD +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">` +
    shared.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('') +
    '</sst>';

  /* Sheets take rId1..rIdN so styles and sharedStrings can have the two ids
     after them — the numbering has to agree across workbook.xml and its
     .rels or Excel reports the file as corrupt with no further detail. */
  const styleRel  = `rId${sheets.length + 1}`;
  const sharedRel = `rId${sheets.length + 2}`;

  const workbook = XML_HEAD +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets>' +
    sheets.map((s, i) => `<sheet name="${esc(s.name || `Sheet${i + 1}`)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
    '</sheets></workbook>';

  const workbookRels = XML_HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets.map((s, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
    ).join('') +
    `<Relationship Id="${styleRel}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `<Relationship Id="${sharedRel}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
    '</Relationships>';

  const contentTypes = XML_HEAD +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheets.map((s, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    ).join('') +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    '</Types>';

  const rootRels = XML_HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const entries = [
    { name: '[Content_Types].xml',      bytes: enc.encode(contentTypes) },
    { name: '_rels/.rels',              bytes: enc.encode(rootRels) },
    { name: 'xl/workbook.xml',          bytes: enc.encode(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', bytes: enc.encode(workbookRels) },
    ...sheetXml.map((xml, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, bytes: enc.encode(xml) })),
    { name: 'xl/styles.xml',            bytes: enc.encode(STYLES) },
    { name: 'xl/sharedStrings.xml',     bytes: enc.encode(sharedXml) }
  ];

  return zip(entries);
}

export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/* A Content-Disposition a browser will honour without mangling the name.
   filename* carries the UTF-8 form for anything non-ASCII; plain filename
   stays as the ASCII fallback older clients read. */
export function attachment(filename) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/* Exported for the tests — they read a generated workbook back out. */
export const _internals = { crc32, esc, colName, zip };
