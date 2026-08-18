/* =========================================================================
   The spreadsheet exports.

   Two things are being tested and they fail in different ways.

   lib/xlsx.js writes a ZIP by hand. A wrong offset in the central directory
   does not throw — it produces a file that downloads happily and then makes
   Excel say "we found a problem with some content", which is a bug report
   from a client rather than a failing build. So the ZIP is read back here,
   entry by entry, with the same arithmetic in reverse.

   lib/metafeed.js decides which of the shop's two numbers is the price. That
   one is money: getting it backwards publishes the purchase price of every
   product in the catalogue to Meta and to anyone who looks at the feed.

   No framework — node:test ships with Node. `npm test`.
   ========================================================================= */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';

import { buildWorkbook, attachment, _internals } from '../lib/xlsx.js';
import {
  catalogSheet, conversionSheet, audienceSheet, orderSheet, eventSheet,
  CATALOG_COLUMNS, _internals as feed
} from '../lib/metafeed.js';

/* -------------------------------------------------------------------------
   A minimal ZIP reader, so the test does not trust the writer's own idea of
   where it put things. Walks the central directory, which is what every real
   unzip does, rather than scanning for local headers.
   ------------------------------------------------------------------------- */
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();

  /* End of central directory: fixed 22 bytes here, since nothing writes a
     comment. */
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50, 'end-of-central-directory signature');

  const count = view.getUint16(end + 10, true);
  const cdSize = view.getUint32(end + 12, true);
  let at = view.getUint32(end + 16, true);
  assert.equal(at + cdSize, end, 'central directory runs exactly up to the EOCD');

  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(at, true), 0x02014b50, `central header ${i} signature`);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compSize = view.getUint32(at + 20, true);
    const rawSize = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));

    /* Follow the offset the central directory gave us into the local header
       — a mismatch here is the classic "Excel repairs your file" bug. */
    assert.equal(view.getUint32(localAt, true), 0x04034b50, `local header for ${name}`);
    const localNameLen = view.getUint16(localAt + 26, true);
    const localExtraLen = view.getUint16(localAt + 28, true);
    assert.equal(
      dec.decode(bytes.subarray(localAt + 30, localAt + 30 + localNameLen)), name,
      'local header names the same file as the central directory'
    );

    const dataAt = localAt + 30 + localNameLen + localExtraLen;
    const raw = bytes.subarray(dataAt, dataAt + compSize);
    const content = method === 0 ? raw : inflateSync(raw);

    assert.equal(content.length, rawSize, `${name}: uncompressed size matches`);
    assert.equal(_internals.crc32(content), crc, `${name}: CRC32 matches`);

    files[name] = dec.decode(content);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/* Pull a sheet's rows back out as arrays of display strings. */
function readSheet(files, n) {
  const shared = [];
  for (const m of (files['xl/sharedStrings.xml'] || '').matchAll(/<si><t[^>]*>([\s\S]*?)<\/t><\/si>/g)) {
    shared.push(m[1]
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&'));
  }
  const xml = files[`xl/worksheets/sheet${n}.xml`];
  assert.ok(xml, `sheet${n} exists`);
  const rows = [];
  for (const r of xml.matchAll(/<row r="\d+">([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const c of r[1].matchAll(/<c r="[A-Z]+\d+" s="\d+"(?: t="(s)")?(?:\/>|><v>([\s\S]*?)<\/v><\/c>)/g)) {
      if (c[2] === undefined) cells.push('');
      else cells.push(c[1] === 's' ? shared[Number(c[2])] : c[2]);
    }
    rows.push(cells);
  }
  return rows;
}

/* =========================================================================
   THE CONTAINER
   ========================================================================= */

test('the workbook is a ZIP whose every entry reads back intact', () => {
  const bytes = buildWorkbook([{
    name: 'Worksheet',
    columns: [{ header: 'a', width: 10 }, { header: 'b', width: 10, center: true }],
    rows: [['one', { v: 2, number: true }], ['', 'four']]
  }]);

  const files = readZip(bytes);          // asserts every CRC and offset
  for (const part of [
    '[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml',
    'xl/styles.xml', 'xl/sharedStrings.xml'
  ]) {
    assert.ok(files[part], `${part} is present`);
  }

  assert.deepEqual(readSheet(files, 1), [
    ['a', 'b'],
    ['one', '2'],
    ['', 'four']
  ]);
});

test('every sheet is declared in the rels and the content types, with matching ids', () => {
  const sheet = (name) => ({ name, columns: [{ header: 'x', width: 8 }], rows: [['y']] });
  const files = readZip(buildWorkbook([sheet('One'), sheet('Two'), sheet('Three')]));

  const rels = files['xl/_rels/workbook.xml.rels'];
  const book = files['xl/workbook.xml'];
  const types = files['[Content_Types].xml'];

  for (let i = 1; i <= 3; i++) {
    assert.match(book, new RegExp(`sheetId="${i}" r:id="rId${i}"`), `workbook declares rId${i}`);
    assert.match(rels, new RegExp(`Id="rId${i}"[^>]*worksheets/sheet${i}\\.xml`), `rels resolves rId${i}`);
    assert.match(types, new RegExp(`/xl/worksheets/sheet${i}\\.xml`), `content types covers sheet${i}`);
  }
  /* Styles and sharedStrings take the ids AFTER the sheets — the bug this
     pins is a fourth sheet silently colliding with rId4 = styles. */
  assert.match(rels, /Id="rId4"[^>]*styles\.xml/);
  assert.match(rels, /Id="rId5"[^>]*sharedStrings\.xml/);
});

test('XML metacharacters and Arabic survive the round trip', () => {
  const nasty = 'Tapo & "C200" <b>كاميرا';
  const files = readZip(buildWorkbook([{
    name: 'S', columns: [{ header: 'h', width: 10 }], rows: [[nasty]]
  }]));
  assert.deepEqual(readSheet(files, 1)[1], [nasty]);
});

test('a control character is stripped rather than written into the XML', () => {
  /* A raw 0x0B is illegal in XML 1.0. Excel does not warn, it refuses the
     file — so this has to be removed before it reaches the shared strings. */
  const VT = String.fromCharCode(0x0b);
  const files = readZip(buildWorkbook([{
    name: 'S', columns: [{ header: 'h', width: 10 }], rows: [[`bad${VT}value`]]
  }]));
  assert.deepEqual(readSheet(files, 1)[1], ['badvalue']);
  assert.ok(!files['xl/sharedStrings.xml'].includes(VT));
});

test('numbers are numeric cells and blanks keep their style', () => {
  const files = readZip(buildWorkbook([{
    name: 'S',
    columns: [{ header: 'n', width: 8 }, { header: 'b', width: 8 }],
    rows: [[{ v: 1250, number: true }, '']]
  }]));
  const xml = files['xl/worksheets/sheet1.xml'];
  assert.match(xml, /<c r="A2" s="1"><v>1250<\/v><\/c>/, 'no t="s" on a number');
  assert.match(xml, /<c r="B2" s="1"\/>/, 'the empty cell is still styled');
});

test('column letters continue past Z', () => {
  assert.equal(_internals.colName(0), 'A');
  assert.equal(_internals.colName(25), 'Z');
  assert.equal(_internals.colName(26), 'AA');
  assert.equal(_internals.colName(27), 'AB');
});

test('the download filename is safe in both header forms', () => {
  const h = attachment('VG_Meta_Catalog_2026-08-10.xlsx');
  assert.match(h, /filename="VG_Meta_Catalog_2026-08-10\.xlsx"/);
  assert.match(h, /filename\*=UTF-8''VG_Meta_Catalog_2026-08-10\.xlsx/);
  /* A quote in the name must not be able to close the quoted string. */
  assert.ok(!attachment('a"b.xlsx').includes('"b.xlsx"'));
});

/* =========================================================================
   THE CATALOGUE FEED — the money
   ========================================================================= */

const ORIGIN = 'https://visionguardeg.com';

const PRODUCT = {
  id: 'unv-2mp', cat: 'analog', brand: 'Uniview', name: 'Uniview 2MP HD',
  ar: '٢ ميجابكسل', en: '2MP · indoor and outdoor',
  img: 'assets/products/unv-2mp.jpg', price: 440, was: 0, active: 1
};

test('the selling price goes in price, and cost is nowhere in the file', () => {
  const { rows } = catalogSheet([PRODUCT], ORIGIN);
  const row = rows[0];
  const col = (name) => row[CATALOG_COLUMNS.findIndex((c) => c.header === name)];

  assert.equal(col('price'), '440 EGP', 'the price customers pay');
  assert.equal(col('sale_price'), '', 'no invented discount');

  /* The supplied workbook had 350 in `price` and 437.5 in `sale_price` for
     this camera — cost, and cost + 25%. Neither number may appear. */
  const flat = rows.flat().join(' ');
  assert.ok(!flat.includes('350'), 'the purchase price is not in the feed');
  assert.ok(!flat.includes('437.5'), 'the inverted sale price is not in the feed');
});

test('a real discount maps price <- was and sale_price <- price', () => {
  const { rows } = catalogSheet([{ ...PRODUCT, price: 400, was: 500 }], ORIGIN);
  const col = (name) => rows[0][CATALOG_COLUMNS.findIndex((c) => c.header === name)];
  assert.equal(col('price'), '500 EGP', 'the before price is the list price');
  assert.equal(col('sale_price'), '400 EGP', 'the discounted price is what they pay');

  /* Meta rejects a feed whose sale_price exceeds its price — the exact
     defect in the supplied workbook. */
  const p = Number(col('price').split(' ')[0]);
  const s = Number(col('sale_price').split(' ')[0]);
  assert.ok(s <= p, 'sale_price never exceeds price');
});

test('id is the slug the pixel fires, and link resolves to it', () => {
  const { rows } = catalogSheet([PRODUCT], ORIGIN);
  assert.equal(rows[0][0], 'unv-2mp');
  assert.equal(rows[0][5], 'https://visionguardeg.com/product?id=unv-2mp');
  assert.equal(rows[0][1], 'https://visionguardeg.com/assets/products/unv-2mp.jpg');
});

test('a withdrawn product stays in the feed as out of stock', () => {
  const { rows } = catalogSheet([{ ...PRODUCT, active: 0 }], ORIGIN);
  assert.equal(rows[0][6], 'out of stock');
});

test('a missing image is reported rather than shipped silently', () => {
  const { rows, warnings } = catalogSheet([{ ...PRODUCT, img: '' }], ORIGIN);
  assert.equal(rows[0][1], '');
  assert.match(warnings.join(' '), /unv-2mp: no image/);
});

test('an SVG image is flagged — Meta will not take one', () => {
  /* Found by exporting the real catalogue: the line drawings that stand in
     for coax, connectors and the rack are .svg, and every one of those rows
     fails at upload with nothing on screen to say why. */
  const { rows, warnings } = catalogSheet(
    [{ ...PRODUCT, id: 'junction-box', img: 'assets/products/junction-box.svg' }], ORIGIN
  );
  assert.equal(rows[0][1], 'https://visionguardeg.com/assets/products/junction-box.svg',
    'the row still exports — the shop decides, not this function');
  assert.match(warnings.join(' '), /junction-box: image is an SVG/);
});

test('an ordinary photo raises no warning at all', () => {
  assert.deepEqual(catalogSheet([PRODUCT], ORIGIN).warnings, [],
    'a warning list that cries wolf is one nobody reads');
});

test('a trailing slash on the origin does not double up in the URLs', () => {
  const { rows } = catalogSheet([PRODUCT], 'https://visionguardeg.com/');
  assert.equal(rows[0][1], 'https://visionguardeg.com/assets/products/unv-2mp.jpg');
  assert.equal(rows[0][5], 'https://visionguardeg.com/product?id=unv-2mp');
});

test('the column order is the supplied workbook, exactly', () => {
  assert.deepEqual(CATALOG_COLUMNS.map((c) => c.header), [
    'id', 'image_link', 'description', 'title', 'price',
    'link', 'availability', 'condition', 'brand', 'sale_price'
  ]);
});

/* =========================================================================
   THE DATA EXPORT
   ========================================================================= */

const ORDER = {
  id: 'VG-260810-A1B2', created_at: '2026-08-10T09:00:00.000Z', status: 'confirmed',
  name: 'Omar Bakkar', phone: '201105006854', email: 'Omar@Example.com',
  governorate: 'القاهرة', address: '1 Street',
  items: JSON.stringify([
    { id: 'unv-2mp', name: 'Uniview 2MP HD', qty: 2, unit: 440, line: 880 },
    { id: 'psu-12v-10a', name: 'Power Supply 12V 10A', qty: 1, unit: 220, line: 220 }
  ]),
  subtotal: 1100, shipping: 0, total: 990, currency: 'EGP', payment: 'cod',
  discount: 110, discount_code: 'WELCOME10'
};

test('an order becomes one Purchase row with the identifiers Meta matches on', () => {
  const { rows } = conversionSheet([ORDER]);
  assert.equal(rows.length, 1);
  const [name, time, id, value, cur, email, phone, fn, ln, ct, country, ids, type, num] = rows[0];
  assert.equal(name, 'Purchase');
  assert.equal(time, '2026-08-10T09:00:00.000Z');
  assert.equal(id, 'VG-260810-A1B2');
  assert.deepEqual(value, { v: 990, number: true }, 'the amount actually charged, after the discount');
  assert.equal(cur, 'EGP');
  assert.equal(email, 'omar@example.com', 'lower-cased for matching');
  assert.equal(phone, '+201105006854', 'E.164 with the plus');
  assert.equal(fn, 'Omar');
  assert.equal(ln, 'Bakkar');
  assert.equal(ct, 'Cairo', 'the Arabic governorate is translated');
  assert.equal(country, 'EG');
  assert.equal(ids, 'unv-2mp,psu-12v-10a', 'the ids the pixel also sends');
  assert.equal(type, 'product');
  assert.deepEqual(num, { v: 3, number: true });
});

test('a cancelled order is not reported as revenue', () => {
  assert.equal(conversionSheet([{ ...ORDER, status: 'cancelled' }]).rows.length, 0);
  assert.equal(orderSheet([{ ...ORDER, status: 'cancelled' }]).rows.length, 1,
    'but it stays on the internal sheet');
});

test('a malformed items column does not take the export down with it', () => {
  const { rows } = conversionSheet([{ ...ORDER, items: 'not json' }]);
  assert.equal(rows[0][11], '');
  assert.deepEqual(rows[0][13], { v: 0, number: true });
});

test('the customer list carries only people who consented to marketing', () => {
  const { rows } = audienceSheet({
    users: [
      { email: 'yes@example.com', name: 'Yes Please', phone: '201000000001', marketing: 1 },
      { email: 'no@example.com',  name: 'No Thanks',  phone: '201000000002', marketing: 0 }
    ],
    newsletter: [
      { email: 'news@example.com', name: 'News Reader', marketing: 1, unsub_at: null },
      { email: 'gone@example.com', name: 'Unsubbed',    marketing: 1, unsub_at: '2026-08-01' }
    ],
    orders: []
  });
  const emails = rows.map((r) => r[0]).sort();
  assert.deepEqual(emails, ['news@example.com', 'yes@example.com']);
});

test('buying something does not add you to an advertising audience', () => {
  const { rows } = audienceSheet({ users: [], newsletter: [], orders: [ORDER] });
  assert.equal(rows.length, 0, 'an order is not a marketing consent');
});

test('an order tops up the city and lifetime value of someone who did consent', () => {
  const { rows } = audienceSheet({
    users: [{ email: 'omar@example.com', name: 'Omar Bakkar', phone: '', marketing: 1 }],
    newsletter: [],
    orders: [ORDER, { ...ORDER, id: 'VG-2', total: 500 }]
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0][1], '+201105006854', 'the phone came off the order');
  assert.equal(rows[0][4], 'Cairo');
  assert.deepEqual(rows[0][6], { v: 1490, number: true }, 'both orders counted');
});

test('the same person through two sources is one row', () => {
  const { rows } = audienceSheet({
    users: [{ email: 'dup@example.com', name: 'Dup Person', phone: '201000000003', marketing: 1 }],
    newsletter: [{ email: 'dup@example.com', name: 'Dup Person', marketing: 1, unsub_at: null }],
    orders: []
  });
  assert.equal(rows.length, 1);
});

test('the orders sheet keeps the discount and the line items in words', () => {
  const { rows } = orderSheet([ORDER]);
  assert.equal(rows[0][8], '2× Uniview 2MP HD, 1× Power Supply 12V 10A');
  assert.equal(rows[0][10], 'WELCOME10');
  assert.deepEqual(rows[0][11], { v: 110, number: true });
  assert.deepEqual(rows[0][13], { v: 990, number: true });
});

test('the orders sheet says whether the money arrived', () => {
  /* The fixture is a cash-on-delivery order from before the change, with no
     payment_status on it at all. It must export as pending: nobody has said
     the money arrived, and a spreadsheet claiming otherwise is worse than a
     blank. */
  assert.equal(orderSheet([ORDER]).rows[0][16], 'pending');
  assert.equal(orderSheet([{ ...ORDER, payment_status: 'paid' }]).rows[0][16], 'paid');
  assert.equal(orderSheet([{ ...ORDER, payment_status: 'failed' }]).rows[0][16], 'failed');
});

test('daily events pivot into counts a spreadsheet can total', () => {
  const { rows } = eventSheet([{ day: '2026-08-10', event: 'ViewContent', n: 42, people: 12, value: 0 }]);
  assert.deepEqual(rows[0], [
    '2026-08-10', 'ViewContent',
    { v: 42, number: true }, { v: 12, number: true }, { v: 0, number: true }, 'EGP'
  ]);
});

test('a mononym gives a first name and no invented surname', () => {
  assert.deepEqual(feed.splitName('Cher'), { fn: 'Cher', ln: '' });
  assert.deepEqual(feed.splitName('  Omar   Bakkar  '), { fn: 'Omar', ln: 'Bakkar' });
  assert.deepEqual(feed.splitName(''), { fn: '', ln: '' });
  assert.deepEqual(feed.splitName('a b c'), { fn: 'a', ln: 'b c' });
});

/* =========================================================================
   END TO END — the bytes an administrator actually downloads
   ========================================================================= */

test('the real catalogue export opens as a four-row workbook with the right prices', () => {
  const products = [
    PRODUCT,
    { ...PRODUCT, id: 'tapo-c200', name: 'Tapo C200 Wi-Fi', brand: 'Tapo', price: 1190, img: 'assets/products/tapo-c200.jpg' },
    { ...PRODUCT, id: 'sale-item', name: 'On Sale', price: 800, was: 1000 },
    { ...PRODUCT, id: 'gone', name: 'Withdrawn', active: 0 }
  ];
  const sheet = catalogSheet(products, ORIGIN);
  const files = readZip(buildWorkbook([sheet]));
  const rows = readSheet(files, 1);

  assert.equal(rows.length, 5, 'a header and four products');
  assert.deepEqual(rows[0], [
    'id', 'image_link', 'description', 'title', 'price',
    'link', 'availability', 'condition', 'brand', 'sale_price'
  ]);
  assert.equal(rows[1][4], '440 EGP');
  assert.equal(rows[1][9], '');
  assert.equal(rows[3][4], '1000 EGP');
  assert.equal(rows[3][9], '800 EGP');
  assert.equal(rows[4][6], 'out of stock');
});

test('the real data export is a four-sheet workbook in a fixed order', () => {
  const files = readZip(buildWorkbook([
    conversionSheet([ORDER]),
    audienceSheet({ users: [], newsletter: [], orders: [ORDER] }),
    orderSheet([ORDER]),
    eventSheet([{ day: '2026-08-10', event: 'Purchase', n: 1, people: 1, value: 990 }])
  ]));

  const book = files['xl/workbook.xml'];
  for (const name of ['Offline Conversions', 'Customer List', 'Orders', 'Daily Events']) {
    assert.ok(book.includes(`name="${name}"`), `${name} is a sheet`);
  }
  assert.equal(readSheet(files, 1).length, 2, 'one conversion');
  assert.equal(readSheet(files, 2).length, 1, 'no consented customers, so header only');
  assert.equal(readSheet(files, 3).length, 2, 'one order');
  assert.equal(readSheet(files, 4).length, 2, 'one event day');
});

test('an empty database still produces a workbook Excel can open', () => {
  /* Nothing has been ordered on the live site yet, so this IS the case the
     first download hits. A zero-row sheet must still carry its headers. */
  const files = readZip(buildWorkbook([
    conversionSheet([]), audienceSheet({ users: [], newsletter: [], orders: [] }),
    orderSheet([]), eventSheet([])
  ]));
  assert.equal(readSheet(files, 1).length, 1);
  assert.equal(readSheet(files, 1)[0][0], 'event_name');
  assert.equal(readSheet(files, 3)[0][0], 'order_id');
});
