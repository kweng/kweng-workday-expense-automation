const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const {
  CONVERTER_URL,
  acceptCookies,
  setBaseCurrency,
  setQuoteCurrency,
  setDate,
  setAmount,
  extractConvertedValue,
} = require('./oanda_converter_lib');

const receipts = require('./receipts.json');
const QUOTE_CCY = 'USD';
const OUT_DIR = path.join(__dirname, 'oanda_converter_pdfs');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const HEADER_TEMPLATE = `
  <div style="font-size:9px; width:100%; padding:4px 12px; color:#555; display:flex; justify-content:space-between;">
    <span class="url"></span>
    <span class="date"></span>
  </div>
`;
const FOOTER_TEMPLATE = `
  <div style="font-size:9px; width:100%; padding:4px 12px; color:#555; text-align:center;">
    Page <span class="pageNumber"></span> of <span class="totalPages"></span>
  </div>
`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function processReceipt(page, receipt) {
  const { row, date, currency, amount } = receipt;

  await page.goto(CONVERTER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);
  await acceptCookies(page);

  await setBaseCurrency(page, currency);
  await setQuoteCurrency(page, QUOTE_CCY);

  const { networkRate } = await setDate(page, date, currency, QUOTE_CCY);
  await setAmount(page, amount);

  const { displayed, numeric } = await extractConvertedValue(page);
  const impliedRate = numeric / amount;

  const relDiff = Math.abs((impliedRate - networkRate) / networkRate);
  if (relDiff > 0.01) {
    throw new Error(
      `Sanity check failed: displayed value implies rate ${impliedRate}, but network average_bid was ${networkRate} (${(relDiff * 100).toFixed(2)}% off)`
    );
  }

  const pdfFilename = `${date.replace(/-/g, '')}_OandaConverter_${currency}_${QUOTE_CCY}_row${row}.pdf`;
  const pdfPath = path.join(OUT_DIR, pdfFilename);
  await page.emulateMedia({ media: 'print' });
  await page.pdf({
    path: pdfPath,
    format: 'A4',
    landscape: false,
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: HEADER_TEMPLATE,
    footerTemplate: FOOTER_TEMPLATE,
    margin: { top: '40px', bottom: '40px', left: '20px', right: '20px' },
  });
  await page.emulateMedia({ media: 'screen' });

  return {
    row,
    date,
    currency,
    amount,
    convertedUsd: numeric,
    displayedUsd: displayed,
    impliedRate,
    networkRate,
    pdf: pdfFilename,
  };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

  const results = [];
  const failures = [];

  try {
    for (const receipt of receipts) {
      process.stdout.write(`Processing row ${receipt.row} (${receipt.date} ${receipt.currency} ${receipt.amount})... `);
      try {
        const r = await processReceipt(page, receipt);
        console.log(`OK -> ${r.displayedUsd} USD (rate=${r.impliedRate.toFixed(10)})`);
        results.push(r);
      } catch (err) {
        console.log(`FAILED: ${err.message}`);
        failures.push({ ...receipt, reason: err.message });
      }
      await sleep(2000 + Math.floor(Math.random() * 1000));
    }
  } finally {
    await browser.close();
  }

  fs.writeFileSync(path.join(__dirname, 'rates_result_converter.json'), JSON.stringify({ results, failures }, null, 2));

  console.log(`\n=== BATCH COMPLETE ===`);
  console.log(`Succeeded: ${results.length}/${receipts.length}`);
  console.log(`Failed: ${failures.length}/${receipts.length}`);
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  Row ${f.row} (${f.date} ${f.currency} ${f.amount}): ${f.reason}`));
  }
})();
