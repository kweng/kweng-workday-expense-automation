// Reads the source spreadsheet fresh, appends two columns
// (Oanda_Converter_Rate, Oanda_Converter_USD) from rates_result_converter.json,
// and writes a freshly-timestamped output file. Never overwrites the source.
//
// Run: node rebuild_spreadsheet.js
// Prerequisite: node batch_process_converter.js (writes rates_result_converter.json)

const ExcelJS = require('exceljs');
const fs = require('fs');

const SRC_FILE = 'Travel_Expenses.xlsx';
const SHEET_NAME = 'OANDA Aligned Expenses';

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

const OUT_FILE = `${timestamp()}_Travel_Expenses_verified.xlsx`;

// Converter results are per-receipt-row (not per date/currency), since each
// PDF was generated using that row's own actual amount.
const { results: converterResults } = JSON.parse(fs.readFileSync('rates_result_converter.json', 'utf8'));
const converterByRow = new Map();
for (const r of converterResults) {
  converterByRow.set(r.row, r);
}

function normalizeDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function main() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(SRC_FILE);
  const sheet = workbook.getWorksheet(SHEET_NAME);

  // Strip AutoFilter / defined-name metadata that references column ranges;
  // ExcelJS's spliceColumns crashes trying to renormalize these otherwise.
  sheet.autoFilter = null;
  workbook.definedNames.model = [];

  const headerRow = sheet.getRow(1);
  const headers = {};
  headerRow.eachCell((cell, colNumber) => {
    headers[cell.value] = colNumber;
  });

  const dateCol = headers['Date'];
  const currencyCol = headers['Currency'];
  const amountCol = headers['Amount (Original)'];

  // If this is re-run on an already-rebuilt file, strip the old rate columns
  // first so we never end up with duplicates.
  const namesToRemove = ['Oanda_Converter_Rate', 'Oanda_Converter_USD'];
  const colsToRemove = namesToRemove
    .map((n) => headers[n])
    .filter((c) => c !== undefined)
    .sort((a, b) => b - a);
  for (const col of colsToRemove) {
    sheet.spliceColumns(col, 1);
  }

  const originalColCount = Object.keys(headers).length - colsToRemove.length;
  const rateCol = originalColCount + 1;
  const usdCol = originalColCount + 2;

  sheet.getRow(1).getCell(rateCol).value = 'Oanda_Converter_Rate';
  sheet.getRow(1).getCell(usdCol).value = 'Oanda_Converter_USD';

  let filled = 0;
  const notFound = [];

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const rawDate = row.getCell(dateCol).value;
    const currency = row.getCell(currencyCol).value;
    if (!rawDate || !currency) return;

    if (currency === 'USD') {
      row.getCell(rateCol).value = 1;
      row.getCell(usdCol).value = row.getCell(amountCol).value;
      filled++;
      return;
    }

    const converterEntry = converterByRow.get(rowNumber);
    if (converterEntry !== undefined) {
      // impliedRate = convertedUsd / amount carries floating-point noise well
      // beyond the ~6-7 significant figures the site actually displayed;
      // round to 10 significant figures to strip that noise without losing
      // any real precision.
      row.getCell(rateCol).value = Number(converterEntry.impliedRate.toPrecision(10));
      row.getCell(usdCol).value = Math.round(converterEntry.convertedUsd * 100) / 100;
      filled++;
    } else {
      notFound.push({ row: rowNumber, date: normalizeDate(rawDate), currency });
    }
  });

  await workbook.xlsx.writeFile(OUT_FILE);

  console.log(`\nSaved: ${OUT_FILE}`);
  console.log(`Oanda_Converter filled: ${filled} rows`);
  if (notFound.length) {
    console.log('\nRows with no Converter match (run batch_process_converter.js first, or check receipts.json):');
    notFound.forEach((n) => console.log(`  Row ${n.row}: ${n.date} ${n.currency}`));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
