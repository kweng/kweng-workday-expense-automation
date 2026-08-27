// Derives receipts.json from the source spreadsheet — Date/Currency/
// Amount (Original) are already there per row, so there's no reason to
// hand-type them a second time. Skips USD rows (they don't need an OANDA
// lookup at all: rebuild_spreadsheet.js gives them rate=1 directly).
// Never overwrites receipts.json silently if it already has entries you
// hand-edited (e.g. via CONVERTER_OVERRIDES-style fixes) — see the prompt
// below.
//
// Run: node build_receipts_json.js
// Re-run any time the spreadsheet changes; safe against the source file
// (read-only) but will ask before overwriting an existing receipts.json.

const ExcelJS = require('exceljs');
const fs = require('fs');
const readline = require('readline');

const SRC_FILE = 'Travel_Expenses.xlsx';
const SHEET_NAME = 'OANDA Aligned Expenses';
const OUT_FILE = 'receipts.json';

function normalizeDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function confirmOverwrite() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.question(`${OUT_FILE} already exists. Overwrite it with a fresh derivation from the spreadsheet? (y/N) `, resolve);
  });
  rl.close();
  return answer.trim().toLowerCase() === 'y';
}

async function main() {
  if (fs.existsSync(OUT_FILE)) {
    const ok = await confirmOverwrite();
    if (!ok) {
      console.log('Left existing receipts.json untouched.');
      return;
    }
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(SRC_FILE);
  const sheet = wb.getWorksheet(SHEET_NAME);

  const headerRow = sheet.getRow(1);
  const headers = {};
  headerRow.eachCell((cell, colNumber) => {
    headers[cell.value] = colNumber;
  });
  const dateCol = headers['Date'];
  const currencyCol = headers['Currency'];
  const amountCol = headers['Amount (Original)'];
  if (!dateCol || !currencyCol || !amountCol) {
    console.error(`Could not find Date/Currency/"Amount (Original)" columns in ${SRC_FILE}. Found headers:`, headers);
    process.exit(1);
  }

  const receipts = [];
  let skippedUsd = 0;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const rawDate = row.getCell(dateCol).value;
    const currency = row.getCell(currencyCol).value;
    const amount = row.getCell(amountCol).value;
    if (!rawDate || !currency || amount == null) return;
    if (currency === 'USD') {
      skippedUsd++;
      return;
    }
    receipts.push({ row: rowNumber, date: normalizeDate(rawDate), currency, amount });
  });

  fs.writeFileSync(OUT_FILE, JSON.stringify(receipts, null, 2) + '\n');
  console.log(`Wrote ${OUT_FILE} (${receipts.length} row(s) needing an OANDA lookup${skippedUsd ? `, ${skippedUsd} USD row(s) skipped` : ''}).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
