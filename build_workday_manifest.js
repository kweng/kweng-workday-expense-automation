// Builds workday_manifest.json: one entry per spreadsheet row, with everything
// fill_workday.js needs to create the matching Workday Expense Line —
// Workday item, amount, receipt file(s), converter PDF, and (for Airfare/Hotel)
// the extra Item Details / Itemization fields.
//
// Run: node build_workday_manifest.js
// Re-run any time the spreadsheet or receipts folder changes; it's safe to
// regenerate — it never touches the source files.
//
// *** ADAPTING THIS FOR YOUR OWN TRIP: see the lookup tables just below.
// They're hand-maintained on purpose (see README's "Before you start"
// checklist) — this script never guesses a city, airline, or ambiguous
// receipt match; it flags anything it can't resolve in
// workday_manifest_warnings.txt instead. ***

const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

const SHEET_NAME = 'OANDA Aligned Expenses';
const RECEIPTS_DIR = 'receipts';
const CONVERTER_DIR = 'oanda_converter_pdfs';
const RATES_FILE = 'rates_result_converter.json';
const OUT_FILE = 'workday_manifest.json';

// Auto-picks the freshest rebuild_spreadsheet.js output instead of a
// hand-maintained constant (2026-08-26) — that file has the
// Oanda_Converter_Rate/USD columns this script reads, and picking it was
// pure copy-paste bookkeeping with no judgment call involved: the filename
// is always "YYYYMMDD_HHMM_Travel_Expenses_verified.xlsx", which sorts
// chronologically as a plain string, so the last one alphabetically is
// always the most recent. rebuild_spreadsheet.js never overwrites, so old
// ones can pile up here — that's fine, only the newest is ever used.
function findLatestVerifiedXlsx() {
  const candidates = fs.readdirSync('.').filter(f => /_Travel_Expenses_verified\.xlsx$/.test(f));
  if (!candidates.length) {
    console.error('No "*_verified.xlsx" file found in this folder — run rebuild_spreadsheet.js first.');
    process.exit(1);
  }
  candidates.sort();
  return candidates[candidates.length - 1];
}

// Optional, growing reference list of Workday Expense Item names actually
// confirmed to exist (2026-08-26) — one per row, no header, in
// WORKDAY_ITEMS_FILE. Nothing in CATEGORY_TO_ITEM/DEFAULT_ITEM/
// FLIGHT_DETAILS is validated against Workday itself when this manifest is
// built, so a typo'd item name would otherwise only surface as a live
// failure much later, in fill_workday.js. This catches it earlier instead
// — but only as a WARNING, never a block: the list is expected to be
// incomplete (you add to it as you confirm new items exist), so "not on
// the list" and "not real" look identical from here and can't be treated
// the same as a hard error. Missing the file entirely is fine too —
// validation is just skipped.
const WORKDAY_ITEMS_FILE = 'workday_expense_items.xlsx';
async function loadKnownWorkdayItems() {
  if (!fs.existsSync(WORKDAY_ITEMS_FILE)) return null;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(WORKDAY_ITEMS_FILE);
  const sheet = wb.worksheets[0];
  const items = new Set();
  sheet.eachRow((row) => {
    const v = row.getCell(1).value;
    if (v) items.add(String(v).trim());
  });
  return items;
}

// Small city -> nearest MAJOR city that's actually in Workday's location
// picker, used for AIRFARE rows only (see FLIGHT_DETAILS below) — per
// organizational policy, hotel/flight destinations always use the nearest
// major city Workday recognizes, with the true (small) destination going
// in the Memo/Description instead. This resolution happens HERE, at
// manifest-build time, not at fill_workday.js runtime — trying the true
// small city first and falling back at runtime meant clearing/retyping the
// same field a second time, which repeatedly triggered Workday's own
// "Discard Changes?" dialog in live testing. Resolving to the major city
// here means fill_workday.js only ever types ONE, already-correct city.
// (HOTEL rows don't use this table — see "True Destination"/"Major City"
// spreadsheet columns below instead, 2026-08-26.)
const MAJOR_CITY = {};

// Look up the major city to actually type into Workday, and whether this
// was a substitution (in which case the true city belongs in the memo).
// Used for Airfare (FLIGHT_DETAILS) only — Hotel rows read their own
// "True Destination"/"Major City" spreadsheet columns directly instead.
function resolveCity(trueCity) {
  if (!trueCity) return { destination: null, trueCity: null, usedMajorCity: false };
  const major = MAJOR_CITY[trueCity];
  return major
    ? { destination: major, trueCity, usedMajorCity: true }
    : { destination: trueCity, trueCity, usedMajorCity: false };
}

// Airfare row -> {airline, origin, destination}. origin/destination are TRUE
// cities (resolved through MAJOR_CITY the same as Hotel rows used to be).
// Airline is the search term used at runtime (matched via search+Enter,
// same as manual entry). Add entries here for your own Airfare rows.
const FLIGHT_DETAILS = {};

// Rows whose converter PDF was regenerated by hand OUTSIDE the batch OANDA
// pipeline (rates_result_converter.json doesn't know about these) — e.g.
// after correcting a date or amount post-hoc. Empty in this example.
const CONVERTER_OVERRIDES = {};

// Used when a row's Category isn't in CATEGORY_TO_ITEM below, instead of
// skipping the row (Kevin's call, 2026-08-26): a wrong-but-visible category
// is easy to fix by hand in Workday during the mandatory pre-Submit review;
// a missing line is easy to forget entirely. A Memo note and a
// workday_manifest_warnings.txt entry flag every row this happens to.
const DEFAULT_ITEM = 'Field Supplies - Travel';

// Spreadsheet Category -> Workday Expense Item. Description is checked FIRST
// (for Airfare / bag fees) because the Category column alone doesn't
// distinguish "Flight: X to Y" (Category="Transport") from a taxi ride.
const CATEGORY_TO_ITEM = {
  'Visa / Fees': 'Visas',
  'Telecom': 'Phone',
  'Accommodation': 'Hotel',
  'Gear / Equipment': 'Field Supplies - Travel',
  'Activities': 'Field Supplies - Travel',
  'Medical / Personal': 'Medical-Other',
  'Insurance': 'Membership Dues',
  'Transport': 'Transportation',
  'Transportation': 'Transportation',
  'Transport / Repair': 'Transportation',
  'Air Travel': 'Airfare',
};

function excelDateToYMD(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}
function ymdToMDY(ymd) {
  const [y, m, d] = ymd.split('-');
  return `${m}/${d}/${y}`;
}

function mapWorkdayItem(desc, cat) {
  const d = desc.toLowerCase();
  if (d.includes('flight') || d.includes('bag fee')) return 'Airfare';
  return CATEGORY_TO_ITEM[cat] || null; // null => needs manual review
}

// Parse "(N nights)" / "(N night)" out of a free-text description. Not used
// to compute the Workday amount (that's always the row's full USD value),
// only for the Arrival/Departure dates shown in Hotel Item Details and for
// the auto-generated Memo text.
function parseNights(desc) {
  const m = desc.match(/(\d+)\s*night/i);
  return m ? parseInt(m[1], 10) : null;
}
function parseRooms(desc) {
  const m = desc.match(/(\d+)\s*room/i);
  return m ? parseInt(m[1], 10) : null;
}

async function main() {
  const XLSX_FILE = findLatestVerifiedXlsx();
  console.log(`Using spreadsheet: ${XLSX_FILE}`);
  const knownItems = await loadKnownWorkdayItems();
  if (knownItems) console.log(`Validating Workday items against ${WORKDAY_ITEMS_FILE} (${knownItems.size} known).`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX_FILE);
  const sheet = wb.getWorksheet(SHEET_NAME);

  // Read columns by header NAME, not fixed position — a plain requirement
  // now that "Receipt Filename" is a required column: adding it shifts
  // where later columns land, and a positional read (the old v[1], v[2]...
  // approach) would silently start reading the wrong column instead of
  // erroring. Every column below is required except Comment.
  const headerRow = sheet.getRow(1);
  const headers = {};
  headerRow.eachCell((cell, colNumber) => { headers[cell.value] = colNumber; });
  const need = (name) => {
    const col = headers[name];
    if (!col) { console.error(`Required column "${name}" not found in ${XLSX_FILE}. Found headers:`, headers); process.exit(1); }
    return col;
  };
  const dateCol = need('Date');
  const descCol = need('Description');
  const catCol = need('Category');
  const vendorCol = need('Vendor / Platform');
  const amtCol = need('Amount (Original)');
  const currencyCol = need('Currency');
  const payerCol = need('Payer / Guest Name');
  const commentCol = headers['Comment']; // optional
  const receiptFilenameCol = need('Receipt Filename');
  const usdCol = need('Oanda_Converter_USD'); // appended by rebuild_spreadsheet.js
  // Optional — only matter for Hotel rows. Typically filled in (and
  // reviewed/corrected by you) with AI assistance reading the actual
  // receipt, the same way you already generate this spreadsheet from your
  // uploaded PDFs — not something any script here derives on its own.
  // "True Destination" is the real place; "Major City" is what actually
  // gets typed into Workday (blank = type True Destination directly, no
  // substitution needed).
  const trueDestCol = headers['True Destination'];
  const majorCityCol = headers['Major City'];

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const usdVal = row.getCell(usdCol).value;
    rows.push({
      xlsxRow: rowNumber,
      date: excelDateToYMD(row.getCell(dateCol).value),
      desc: (row.getCell(descCol).value || '').toString().trim(),
      cat: (row.getCell(catCol).value || '').toString().trim(),
      vendor: row.getCell(vendorCol).value,
      amtOriginal: row.getCell(amtCol).value,
      currency: row.getCell(currencyCol).value,
      payer: row.getCell(payerCol).value,
      comment: commentCol ? row.getCell(commentCol).value : null,
      receiptFilename: (row.getCell(receiptFilenameCol).value || '').toString().trim(),
      trueDestination: trueDestCol ? (row.getCell(trueDestCol).value || '').toString().trim() : '',
      majorCity: majorCityCol ? (row.getCell(majorCityCol).value || '').toString().trim() : '',
      amountUSD: typeof usdVal === 'number' ? Number(usdVal.toFixed(2)) : usdVal,
    });
  });

  // --- match converter PDFs by (date, currency, amountOriginal), not by the
  // row number baked into the filename (rows can get reordered later). ---
  const ratesData = JSON.parse(fs.readFileSync(RATES_FILE, 'utf8'));
  const converterEntries = ratesData.results;
  const converterPool = {}; // key: date|cur|amt -> array of {pdf} (consumed in order)
  for (const e of converterEntries) {
    const key = `${e.date}|${e.currency}|${e.amount}`;
    (converterPool[key] = converterPool[key] || []).push(e.pdf);
  }

  const warnings = [];
  const manifest = [];

  for (const r of rows) {
    const memoNotes = [];

    // Unmapped category: use DEFAULT_ITEM as a placeholder rather than
    // skipping the row entirely (Kevin's call, 2026-08-26) — same pattern
    // already used for an unrecognized Airline (falls back to "American
    // Airlines" + a Memo note) applied here too. A wrong-but-visible
    // category in Workday, flagged in both the Memo and the warnings file,
    // is judged lower-risk than the expense not being entered at all —
    // it's easy to spot and fix during the mandatory pre-Submit review,
    // versus a missing line that's easy to forget to add by hand.
    let workdayItem = mapWorkdayItem(r.desc, r.cat);
    if (!workdayItem) {
      workdayItem = DEFAULT_ITEM;
      memoNotes.push(`Category "${r.cat}" not recognized; entered as "${DEFAULT_ITEM}" as a placeholder — needs manual re-categorization in Workday`);
      warnings.push(`Row ${r.xlsxRow}: category "${r.cat}" not in CATEGORY_TO_ITEM — entered as "${DEFAULT_ITEM}" placeholder (see Memo), needs manual re-categorization.`);
    }
    if (knownItems && !knownItems.has(workdayItem)) {
      warnings.push(`Row ${r.xlsxRow}: Workday item "${workdayItem}" is not in ${WORKDAY_ITEMS_FILE} — double-check this is a real Workday Expense Item name (or add it to the file once confirmed) before running fill_workday.js.`);
    }

    // converter PDF
    let converterPdf = null;
    if (CONVERTER_OVERRIDES[r.xlsxRow]) {
      converterPdf = CONVERTER_OVERRIDES[r.xlsxRow];
      if (!fs.existsSync(path.join(CONVERTER_DIR, converterPdf))) {
        warnings.push(`Row ${r.xlsxRow}: override converter PDF "${converterPdf}" not found in ${CONVERTER_DIR}/.`);
      }
    } else if (r.currency !== 'USD') {
      const key = `${r.date}|${r.currency}|${r.amtOriginal}`;
      const pool = converterPool[key];
      if (pool && pool.length) {
        converterPdf = pool.shift();
      } else {
        warnings.push(`Row ${r.xlsxRow}: no converter PDF found for ${r.date} ${r.currency} ${r.amtOriginal} (run batch_process_converter.js first, or add a CONVERTER_OVERRIDES entry).`);
      }
    }

    // receipt file: REQUIRED "Receipt Filename" column value, checked
    // against what's actually in receipts/. Replaced date-based matching
    // (2026-08-26) — inferring "1 row + 1 file on this date = a match" broke
    // on two unrelated expenses landing on the same calendar date (e.g. a
    // foreign trip's last-day taxi and a same-day domestic ride home), and
    // more generally meant real ambiguity had to be resolved in a separate
    // JS table instead of right next to the row it belongs to. Explicit and
    // exact beats inferred: never guessed, either way.
    let receiptFile = null;
    let needsManualReceipt = false;
    if (!r.receiptFilename) {
      needsManualReceipt = true;
      warnings.push(`Row ${r.xlsxRow} (${r.date}, "${r.desc}"): "Receipt Filename" column is empty — required, fill in the exact filename from ${RECEIPTS_DIR}/.`);
    } else if (!fs.existsSync(path.join(RECEIPTS_DIR, r.receiptFilename))) {
      needsManualReceipt = true;
      warnings.push(`Row ${r.xlsxRow}: Receipt Filename "${r.receiptFilename}" not found in ${RECEIPTS_DIR}/ — check for a typo or rename.`);
    } else {
      receiptFile = r.receiptFilename;
    }

    const entry = {
      xlsxRow: r.xlsxRow,
      date: ymdToMDY(r.date),
      description: r.desc,
      workdayItem,
      amountUSD: r.amountUSD,
      payer: r.payer || null,
      receiptFile: receiptFile ? path.join(RECEIPTS_DIR, receiptFile) : null,
      needsManualReceipt,
      converterPdf: converterPdf ? path.join(CONVERTER_DIR, converterPdf) : null,
      memo: null,
      itemDetails: null, // filled below for Airfare
      hotelItemization: null, // filled below for Hotel
    };

    if (workdayItem === 'Airfare') {
      const fd = FLIGHT_DETAILS[r.xlsxRow];
      const origin = resolveCity(fd ? fd.origin : null);
      const dest = resolveCity(fd ? fd.destination : null);
      if (origin.usedMajorCity) memoNotes.push(`True origination is ${origin.trueCity}; ${origin.destination} used as nearest major city`);
      if (dest.usedMajorCity) memoNotes.push(`True destination is ${dest.trueCity}; ${dest.destination} used as nearest major city`);
      entry.itemDetails = {
        airline: fd ? fd.airline : null,
        arrivalDate: entry.date,
        departureDate: entry.date,
        classOfService: 'Economy Class',
        origination: origin.destination,
        destination: dest.destination,
      };
      if (!fd) warnings.push(`Row ${r.xlsxRow} (Airfare, "${r.desc}"): not in FLIGHT_DETAILS — add airline/origin/destination by hand before running.`);
    }

    if (workdayItem === 'Hotel') {
      const nights = parseNights(r.desc) || 1;
      const rooms = parseRooms(r.desc);
      const arrival = new Date(r.date + 'T00:00:00Z');
      const departure = new Date(arrival.getTime() + nights * 86400000);
      const memoBits = [];
      if (rooms) memoBits.push(`${rooms} room${rooms > 1 ? 's' : ''}`);
      memoBits.push(`${nights} night${nights > 1 ? 's' : ''}`);
      memoNotes.push(memoBits.join(', '));
      // "True Destination" / "Major City" spreadsheet columns replace the
      // old HOTEL_CITY/MAJOR_CITY JS tables (2026-08-26) — same reasoning
      // as Receipt Filename: trip data belongs in the spreadsheet, right
      // next to the row it's about, not in a row-number-keyed JS table.
      const usedMajorCity = r.majorCity && r.majorCity !== r.trueDestination;
      const destination = usedMajorCity ? r.majorCity : (r.trueDestination || null);
      entry.hotelItemization = {
        arrivalDate: ymdToMDY(arrival.toISOString().slice(0, 10)),
        departureDate: ymdToMDY(departure.toISOString().slice(0, 10)),
        destination, // already the major city (if needed) fill_workday.js should type — single attempt, no fallback needed
        description: usedMajorCity ? `True destination is ${r.trueDestination}; ${r.majorCity} used as nearest major city` : null,
        dailyRate: entry.amountUSD, // full amount; Number of Nights is always 1 in Workday's itemization
        memo: memoBits.join(', '),
      };
      if (!r.trueDestination) warnings.push(`Row ${r.xlsxRow} (Hotel, "${r.desc}"): "True Destination" column is empty — fill it in (with AI assistance reading the receipt, or by hand) before running.`);
    }

    if (memoNotes.length) entry.memo = memoNotes.join('; ');
    manifest.push(entry);
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), rows: manifest }, null, 2));
  fs.writeFileSync('workday_manifest_warnings.txt', warnings.join('\n'));

  console.log(`Wrote ${OUT_FILE} (${manifest.length} rows) and workday_manifest_warnings.txt (${warnings.length} warnings).`);
  console.log('Review the warnings file before running fill_workday.js — anything listed there needs a manual edit in workday_manifest.json first.');
}

main().catch(e => { console.error(e); process.exit(1); });
