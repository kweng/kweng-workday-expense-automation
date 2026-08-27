const CONVERTER_URL = 'https://www.oanda.com/currency-converter/en/';
const STANDARD_AMOUNT = 1000000;

async function acceptCookies(page) {
  const acceptBtn = page.locator('#onetrust-accept-btn-handler');
  if (await acceptBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await acceptBtn.click();
    await page.waitForTimeout(500);
  }
}

async function setCurrencyAutocomplete(page, selector, code) {
  const input = page.locator(selector);
  await input.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(200);
  await page.keyboard.type(code, { delay: 60 });
  await page.waitForTimeout(700);
  await page.locator('[role="option"]').first().click();
  await page.waitForTimeout(600);
}

async function setBaseCurrency(page, code) {
  await setCurrencyAutocomplete(page, '#baseCurrency_currency_autocomplete', code);
}

async function setQuoteCurrency(page, code) {
  await setCurrencyAutocomplete(page, '#quoteCurrency_currency_autocomplete', code);
}

function formatForDatepicker(dateStr) {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const [y, m, d] = dateStr.split('-').map(Number);
  // The site normalizes single-digit days to a zero-padded form once parsed
  // (e.g. typing "2 June 2026" redisplays as "02 June 2026"), so match that.
  return `${String(d).padStart(2, '0')} ${months[m - 1]} ${y}`;
}

async function setDate(page, dateStr, baseCcy, quoteCcy) {
  const formatted = formatForDatepicker(dateStr);
  const dateInput = page.locator('.react-datepicker-wrapper input').first();

  const responsePromise = page.waitForResponse((resp) => {
    const url = resp.url();
    return (
      url.includes('cc-api/currencies') &&
      url.includes(`base=${baseCcy}`) &&
      url.includes(`quote=${quoteCcy}`) &&
      url.includes('general_currency_pair')
    );
  }, { timeout: 20000 });

  await dateInput.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(200);
  await page.keyboard.type(formatted, { delay: 40 });
  await page.keyboard.press('Enter');

  const resp = await responsePromise;
  await page.waitForTimeout(500);

  const json = await resp.json();
  const entry = json.response && json.response[0];
  if (!entry) {
    throw new Error(`No rate data returned for ${dateStr} ${baseCcy}->${quoteCcy}`);
  }

  const actualDateInput = await dateInput.inputValue();
  if (actualDateInput !== formatted) {
    throw new Error(`Date did not apply correctly. Expected "${formatted}", got "${actualDateInput}"`);
  }

  return { networkRate: parseFloat(entry.average_bid), networkEntry: entry };
}

async function setAmount(page, amount = STANDARD_AMOUNT) {
  const amountInput = page.locator('input[name="numberformat"]').first();
  await amountInput.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(150);
  await page.keyboard.type(String(amount), { delay: 30 });
  await page.keyboard.press('Tab');
  await page.waitForTimeout(1200);
}

async function extractConvertedValue(page) {
  const val = await page.locator('input[name="numberformat"]').nth(1).inputValue();
  return { displayed: val, numeric: parseFloat(val.replace(/,/g, '')) };
}

module.exports = {
  CONVERTER_URL,
  STANDARD_AMOUNT,
  acceptCookies,
  setBaseCurrency,
  setQuoteCurrency,
  setDate,
  setAmount,
  extractConvertedValue,
  formatForDatepicker,
};
