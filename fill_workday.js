// Drives Workday's "Edit Expense Report" form using workday_manifest.json.
// Never touches Submit — it only adds and saves individual Expense Lines,
// exactly like doing it by hand. You review and submit yourself in the browser.
//
// FIRST RUN — do this watched, one row at a time:
//   node fill_workday.js --row 44
// Then, once that looks right in Workday:
//   node fill_workday.js --from 45 --to 65
//
// Flags:
//   --row N        do only row N
//   --from N       start at row N (default: lowest unresolved row in manifest)
//   --to N         stop at row N (default: highest row in manifest)
//   --dry-run      log what it would do without clicking anything destructive
//   --headless     run without a visible window (only use after you trust it)

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const MANIFEST_FILE = 'workday_manifest.json';
const PROFILE_DIR = path.join(__dirname, 'playwright-profile');
const WORKDAY_HOME = 'https://launch.workday.wm.edu/';

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { headless: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--row') out.row = parseInt(args[++i], 10);
    else if (args[i] === '--from') out.from = parseInt(args[++i], 10);
    else if (args[i] === '--to') out.to = parseInt(args[++i], 10);
    else if (args[i] === '--dry-run') out.dryRun = true;
    else if (args[i] === '--headless') out.headless = true;
  }
  return out;
}

function log(rowNum, msg) {
  console.log(`[row ${rowNum ?? '-'}] ${msg}`);
}

// SAFETY NET (added 2026-08-26 after a real incident): Workday can show a
// "Discard Changes?" dialog (buttons "Discard" / "Continue") mid-flow —
// confirmed happening during the Destination step of an automated run, with
// no manual interaction. If left unhandled, any later blind key/click
// (e.g. an Enter meant for a search box) could land on it and hit the
// wrong button, discarding the whole in-progress line/report. Call this
// before any action that could plausibly trigger it, and treat its return
// value as "something unexpected happened — stop and investigate" rather
// than silently pressing on. NEVER clicks "Discard" — only ever "Continue".
async function dismissDiscardDialogIfPresent(page, rowNum) {
  const dialog = page.getByText('Discard Changes?', { exact: false }).first();
  const isUp = await dialog.isVisible({ timeout: 800 }).catch(() => false);
  if (!isUp) return false;
  log(rowNum, `WARN: "Discard Changes?" dialog appeared unexpectedly — clicking "Continue" (never "Discard") to stay safe.`);
  const continueBtn = page.getByRole('button', { name: 'Continue', exact: true });
  if (await continueBtn.count()) {
    await continueBtn.first().click();
    await page.waitForTimeout(500);
  } else {
    log(rowNum, `WARN: "Continue" button not found on the Discard dialog — leaving it open, fix by hand.`);
  }
  return true;
}

// Workday has no real "Save" button — per documented behavior, the actual
// commit action is clicking the grey-highlighted Expense Line entry in the
// left sidebar list; that's what makes whatever was just typed actually
// stick. This used to only be called once, at the very end of a row, after
// every field including itemization. Kevin's insight (2026-08-26): fields
// entered before that click may still be UNCOMMITTED in Workday's own model
// — which would explain three different symptoms we'd been chasing
// separately as if they were unrelated timing bugs: a Destination that
// visibly showed "Jakarta" but our verification read back as unconfirmed,
// the itemization Edit button intermittently not rendering, and Workday's
// own "Discard Changes?" dialog appearing at seemingly random points
// (Workday treating uncommitted work in the line as discardable). Calling
// this after each major piece of data entry, not just at the very end,
// should keep the line in a consistently committed state throughout.
async function commitLine(page, rowNum) {
  await page.mouse.wheel(0, -5000); // scroll the panel back to top first
  await page.waitForTimeout(300);
  const sidebarFirstItem = page.locator('[role="listbox"]').first().locator('[role="option"], li').first();
  await sidebarFirstItem.click({ timeout: 5000 });
  await page.waitForTimeout(1200);
  log(rowNum, `Committed (clicked sidebar entry).`);
}

async function waitForEnter(promptText) {
  console.log('\n' + promptText);
  process.stdin.setRawMode && process.stdin.setRawMode(false);
  await new Promise(resolve => {
    process.stdin.once('data', () => resolve());
  });
}

// Reads one line of typed input, returning it trimmed (empty string if the
// user just presses Enter). Used once at startup to ask for attachment
// comment text — see uploadComment below.
async function promptForLine(promptText) {
  console.log('\n' + promptText);
  process.stdin.setRawMode && process.stdin.setRawMode(false);
  return new Promise(resolve => {
    process.stdin.once('data', (data) => resolve(data.toString().trim()));
  });
}

// Click an [role="option"] row's own radio control, not the row's text —
// confirmed by direct testing that Workday only reliably registers the
// selection when the click lands on the little radio circle, not elsewhere
// in the row (matches the nested radio-role element seen in earlier DOM
// reconnaissance: each option wraps an `input[type=radio]`/[role=radio]).
async function clickOptionRadio(optionLocator) {
  const radio = optionLocator.locator('input[type="radio"], [role="radio"]').first();
  if (await radio.count()) {
    await radio.click();
  } else {
    await optionLocator.click(); // fallback if no nested radio found
  }
}

// Select a field's value via the "By Alphabetical Order" menu path instead
// of typing a search query. Live search via typed keystrokes proved
// unreliable under CDP automation (repeatedly showed the static root menu
// instead of "Search Results", even after multiple clearing strategies) —
// but this pure click-and-scroll navigation is what worked 100% of the time
// during manual entry, since it never depends on a debounced search firing.
async function selectViaAlphabeticalList(page, scope, labelText, exactText, rowNum) {
  const li = fieldByLabel(scope, labelText);
  const input = li.locator('input').first();
  await input.click();

  const alphaLink = page.getByText('By Alphabetical Order', { exact: true }).first();
  try {
    await alphaLink.waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    log(rowNum, `WARN: "${labelText}" — root menu (By Alphabetical Order) never appeared.`);
    return false;
  }
  await alphaLink.click();
  await page.waitForTimeout(600);

  // The expanded alphabetical list uses role="menu"/"menuitemradio" (per
  // earlier DOM reconnaissance), NOT role="listbox"/"option" like the
  // search-results popup uses — that mismatch is why scrolling never found
  // anything last attempt. Try both container role and both item roles so
  // this stays correct even if it's one or the other.
  const container = page.locator('[role="menu"], [role="listbox"]').last();
  const itemSelector = '[role="menuitemradio"], [role="option"]';
  const match = container.locator(itemSelector).filter({ hasText: new RegExp(`^${exactText}$`, 'i') });

  let foundIt = await match.count() > 0;
  for (let i = 0; i < 60 && !foundIt; i++) {
    await container.hover().catch(() => {});
    await page.mouse.wheel(0, 250);
    await page.waitForTimeout(120);
    foundIt = await match.count() > 0;
  }
  if (!foundIt) {
    log(rowNum, `WARN: "${labelText}" — "${exactText}" not found while scrolling the alphabetical list.`);
    return false;
  }

  await clickOptionRadio(match.first());
  await page.waitForTimeout(400);
  if ((await li.innerText()).toLowerCase().includes(exactText.toLowerCase())) {
    log(rowNum, `${labelText} set via alphabetical list "${exactText}"`);
    return true;
  }
  log(rowNum, `WARN: "${labelText}" — clicked "${exactText}" in the list but selection didn't stick.`);
  return false;
}

// Find the <li> containing a form field by its visible label text. There can
// be a same-named field elsewhere in the DOM at the same time (e.g. a
// not-yet-opened Itemization sub-form's own "Memo" field) that is present
// but hidden — restrict to :visible so a hidden duplicate can't win .first()
// and cause fill() to hang waiting for it to become actionable.
function fieldByLabel(scope, labelText) {
  return scope.locator('li:visible').filter({
    has: scope.locator(`label:text-is("${labelText}")`),
  }).first();
}

async function setDateField(scope, labelText, mdyString, rowNum) {
  const [mm, dd, yyyy] = mdyString.split('/');
  const li = fieldByLabel(scope, labelText);
  const inputs = li.locator('input[type="number"], input');
  // Wait for the sub-inputs to actually render rather than an instant
  // count() check — seen intermittently returning 0 right after a new
  // Expense Line panel opens, before its fields have finished rendering
  // (same class of timing issue fixed elsewhere in this file).
  let count = await inputs.count();
  for (let i = 0; i < 20 && count < 3; i++) {
    await scope.waitForTimeout(200);
    count = await inputs.count();
  }
  if (count < 3) throw new Error(`${labelText}: expected 3 date sub-inputs, found ${count}`);
  await inputs.nth(0).click();
  await inputs.nth(0).fill('');
  await inputs.nth(0).pressSequentially(mm, { delay: 40 });
  await inputs.nth(1).click();
  await inputs.nth(1).fill('');
  await inputs.nth(1).pressSequentially(dd, { delay: 40 });
  await inputs.nth(2).click();
  await inputs.nth(2).fill('');
  await inputs.nth(2).pressSequentially(yyyy, { delay: 40 });
  log(rowNum, `${labelText} set to ${mdyString}`);
}

// Generic typeahead: click the field, type the search text with real
// keystrokes (Workday's widgets don't reliably react to a synthetic value
// set — confirmed by DOM inspection), wait for the "Search Results" popup to
// actually render (not a fixed timeout — Workday's search is debounced and a
// fixed wait races it), then click the exact-matching option. VERIFY the
// field's own text changed before trusting it.
//
// Earlier version #1 clicked the first page-wide `[role="option"]` element,
// which is unsafe: Workday's "Grant" field already has a pre-selected chip
// that is *also* `role="option"` and doesn't contain "USD", so a filter meant
// to skip the sidebar list ended up clicking that instead of the real result.
// Earlier version #2 tried pressing Enter first — confirmed by screenshot
// that Workday renders the results popup correctly (with the right option
// highlighted) but Enter on the raw input doesn't reliably commit it in
// automation, even though it often did during manual entry.
async function selectTypeahead(page, scope, labelText, searchText, rowNum) {
  // Deriving the input as "first input inside the li containing this label"
  // (via fieldByLabel) breaks when a field shares its li with a neighboring
  // field — both would resolve to the same li, and .first() would grab
  // whichever input happens to come first, silently typing into the wrong
  // field. getByLabel() resolves the input actually associated with this
  // specific label instead. li is kept only for the post-fill text check below.
  const li = fieldByLabel(scope, labelText);
  const input = scope.getByLabel(labelText, { exact: true }).first();
  const resultsHeading = page.getByText(/^Search Results/).first();

  // Workday's search sometimes shows the static root group menu (By
  // Expense Item Group / By Spend Category / By Alphabetical Order) instead
  // of executing the search — same flakiness seen constantly during manual
  // entry. Re-clicking and re-typing reliably fixes it; retry a few times.
  let found = false;
  for (let attempt = 1; attempt <= 3 && !found; attempt++) {
    await input.click();
    if (attempt > 1) {
      // Clear leftover text via real Backspace keystrokes, not a synthetic
      // .fill('') — suspected that .fill('') (even on an already-empty
      // field, on attempt 1 previously) resets Workday's widget state in a
      // way that stops the live search from ever firing, unlike real typing.
      for (let i = 0; i < searchText.length + 5; i++) await input.press('Backspace');
    }
    await input.pressSequentially(searchText, { delay: 60 });
    try {
      await resultsHeading.waitFor({ state: 'visible', timeout: 3000 });
      found = true;
    } catch {
      log(rowNum, `"${labelText}" — search results didn't appear (attempt ${attempt}/3), retrying...`);
    }
  }
  if (!found) {
    log(rowNum, `WARN: "${labelText}" — no "Search Results" popup appeared for "${searchText}" after 3 attempts.`);
    return false;
  }

  const popup = resultsHeading.locator('xpath=ancestor::*[@role="listbox"][1]');
  const options = (await popup.count()) ? popup.locator('[role="option"]') : page.locator('[role="option"]');
  const exact = options.filter({ hasText: new RegExp(`^${searchText}$`, 'i') });
  const target = (await exact.count()) ? exact.first() : options.first();
  await clickOptionRadio(target);
  await page.waitForTimeout(400);

  if ((await li.innerText()).toLowerCase().includes(searchText.toLowerCase())) {
    log(rowNum, `${labelText} set via option click "${searchText}"`);
    return true;
  }

  log(rowNum, `WARN: "${labelText}" — clicked a result but selection didn't stick for "${searchText}".`);
  return false;
}

// City fields (Destination/Origination) need the fallback-on-"No matches
// found" behavior discovered during manual entry. Click-based, same as
// selectTypeahead — but city option text includes the country (e.g.
// "Surabaya, Indonesia"), so match by prefix, not exact equality.
// Simplified 2026-08-26: build_workday_manifest.js now resolves each
// city to the nearest MAJOR city (the one Workday actually has) at
// manifest-build time — see MAJOR_CITY/resolveCity there. That means this
// function only ever needs to type ONE, already-correct city, ONCE. It
// used to also try a true small city first and fall back to a major city
// here at runtime; that meant clearing and retyping the same field a
// second time when the small city failed, and that retry — automated —
// repeatedly triggered Workday's own "Discard Changes?" dialog in live
// testing, in a way manual retesting never reproduced no matter how the
// clearing was done (.fill(''), select-all+Backspace, plain Backspace all
// triggered it at least once). Never attempting a second entry into this
// field at all removes that risk category entirely, at the cost of no
// longer having an automatic fallback if the manifest's chosen city is
// itself somehow wrong — a manual fix in that case, not a retry.
async function trySelectCity(page, input, cityName, rowNum) {
  // Mechanics confirmed by Kevin testing by hand, live, 2026-08-26: typing a
  // full, exact major-city name (which is all this file ever passes, per
  // MAJOR_CITY/resolveCity) and pressing Enter auto-populates the field
  // directly — no dropdown click needed, verified repeatedly.
  //
  // REMOVED 2026-08-26: this used to also detect and click a dropdown
  // option (a data-automation-id="promptOption" item) as an alternate
  // success path, because one early test happened to show Jakarta going
  // through a dropdown. Real incident since: a run where Destination's own
  // "not confirmed" WARN was immediately followed by the NEXT step (the
  // commit click) hanging on the exact same wd-popup-blocks-everything
  // signature that traces back to the Discard dialog — meaning something
  // during the destination step itself was leaving that dialog open,
  // consistently, in every run since the dropdown-click logic existed.
  // Clicking an already-auto-populated field's dropdown suggestion is the
  // prime remaining suspect. Since manual testing never needed that click,
  // it's removed rather than defended.
  const noMatches = page.getByText('No matches found').first();

  if (await dismissDiscardDialogIfPresent(page, rowNum)) {
    log(rowNum, `WARN: "${cityName}" not attempted — Discard dialog was already open.`);
    return false;
  }
  await input.click();
  // Brief settle pause between click and typing. Real incident (2026-08-26):
  // a batch run where every Destination field came back completely EMPTY
  // after Enter (not "no matches", not a mismatch — no text captured at
  // all), on the very first attempt of the run, not just later rows. This
  // matches the session's recurring pattern of an element passing
  // Playwright's visible/stable checks and accepting a click before the
  // page has actually finished wiring it up to capture input.
  await page.waitForTimeout(300);
  await input.pressSequentially(cityName, { delay: 60 });
  await input.press('Enter');
  if (await dismissDiscardDialogIfPresent(page, rowNum)) {
    log(rowNum, `WARN: "${cityName}" aborted — Discard dialog appeared after Enter.`);
    return false;
  }

  const gotNoMatches = await noMatches.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
  if (gotNoMatches) {
    log(rowNum, `WARN: "${cityName}" — Workday reported "No matches found". Fill in by hand.`);
    return false;
  }
  if (await dismissDiscardDialogIfPresent(page, rowNum)) {
    log(rowNum, `WARN: "${cityName}" aborted — Discard dialog appeared while waiting for a result.`);
    return false;
  }
  // Poll rather than check once. Real incident (2026-08-26): a batch run
  // where an instant check here reported failure for cities that Kevin
  // then confirmed, by looking directly in Workday, HAD actually populated
  // correctly — the value just hadn't settled into the field by the exact
  // moment we checked. Kept short (~500ms budget) at Kevin's request —
  // other steps run much faster and a multi-second pause here stood out
  // as noticeably slower to watch than everything else.
  let currentValue = '';
  let populated = false;
  for (let i = 0; i < 2 && !populated; i++) {
    currentValue = await input.inputValue().catch(() => '');
    populated = currentValue && currentValue.toLowerCase().startsWith(cityName.toLowerCase());
    if (!populated) await page.waitForTimeout(250);
  }
  if (!populated) {
    log(rowNum, `WARN: "${cityName}" — field value is "${currentValue}" after Enter, doesn't look populated. Fill in by hand.`);
    return false;
  }
  return true;
}

async function selectCity(page, scope, labelText, cityName, rowNum) {
  if (!cityName) {
    log(rowNum, `WARN: ${labelText} has no city configured in the manifest — skipping, fill in by hand.`);
    return false;
  }
  // Same reasoning as selectTypeahead(): use getByLabel for the actual input
  // target rather than "first input in the li containing this label", which
  // breaks when the field shares its li with a neighbor.
  const input = scope.getByLabel(labelText, { exact: true }).first();

  if (await trySelectCity(page, input, cityName, rowNum)) {
    log(rowNum, `${labelText} set to "${cityName}"`);
    return true;
  }
  log(rowNum, `WARN: ${labelText} "${cityName}" not confirmed — leaving blank, fill in by hand.`);
  return false;
}

async function fillOneRow(page, entry, uploadComment) {
  const rowNum = entry.xlsxRow;
  log(rowNum, `--- ${entry.description} (${entry.workdayItem}, $${entry.amountUSD}) ---`);

  await page.getByRole('button', { name: 'Add', exact: true }).first().click();
  // Wait for the actual Expense Date field rather than a fixed timeout —
  // a fixed 1200ms wait here has intermittently not been enough (seen
  // twice now: "expected 3 date sub-inputs, found 0" right at the start,
  // before any other field is touched), the same class of issue fixed
  // elsewhere in this file by waiting for real element visibility instead.
  await page.locator('label:text-is("Expense Date")').first().waitFor({ state: 'visible', timeout: 10000 });

  // Fields are unique enough on the page while a line is open, so scope to
  // the whole page rather than trying to isolate the panel's DOM subtree.
  const scope = page;

  await setDateField(scope, 'Expense Date', entry.date, rowNum);
  const itemOk = await selectViaAlphabeticalList(page, scope, 'Expense Item', entry.workdayItem, rowNum);
  if (!itemOk) throw new Error(`Expense Item "${entry.workdayItem}" did not select — aborting this row before it cascades into other field failures.`);
  await page.waitForTimeout(600);

  // Quantity/Per Unit Amount appear after the item is selected; Total Amount
  // alone is the pre-selection state. Handle both.
  const hasQuantity = await scope.locator('label:text-is("Quantity")').count();
  if (hasQuantity) {
    const qtyLi = fieldByLabel(scope, 'Quantity');
    await qtyLi.locator('input').first().fill('1');
    const puLi = fieldByLabel(scope, 'Per Unit Amount');
    await puLi.locator('input').first().fill(String(entry.amountUSD));
  } else {
    const totalLi = fieldByLabel(scope, 'Total Amount');
    await totalLi.locator('input').first().fill(String(entry.amountUSD));
  }
  log(rowNum, `Amount set to ${entry.amountUSD}`);

  if (entry.memo) {
    const memoLi = fieldByLabel(scope, 'Memo');
    await memoLi.locator('input, textarea').first().fill(entry.memo);
    log(rowNum, `Memo set`);
  }

  // File uploads. Confirmed by hand (2026-08-26): the per-attachment
  // comment box is tied to the individual upload EVENT — right after each
  // single file finishes uploading, Workday puts the cursor in that file's
  // own comment box, and that's the only opportunity to enter it. This
  // used to upload both files in one setInputFiles([file1, file2]) call,
  // which doesn't match that model at all — it produced two comment boxes
  // "at once" with focus drifting unpredictably between them, splitting or
  // dropping the text. Fixed by uploading one file at a time, exactly
  // mirroring manual entry: upload -> handle its comment -> upload next.
  const files = [entry.receiptFile, entry.converterPdf].filter(Boolean);
  if (files.length) {
    for (let i = 0; i < files.length; i++) {
      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(path.resolve(files[i]));
      await page.waitForTimeout(1500);
      log(rowNum, `Uploaded (${i + 1}/${files.length}): ${files[i]}`);

      if (uploadComment) {
        // Enter does nothing in this box (confirmed by hand); it needs the
        // same "click the sidebar to commit" treatment as every other
        // field — commitLine() runs later in this function regardless of
        // row type, so no extra commit call is needed here specifically.
        const focused = page.locator(':focus');
        const isEditable = await focused.evaluate(el => el.tagName === 'TEXTAREA' || el.tagName === 'INPUT').catch(() => false);
        if (isEditable) {
          await focused.fill(uploadComment);
          log(rowNum, `Comment entered on upload ${i + 1}/${files.length}: "${uploadComment}"`);
        } else {
          log(rowNum, `WARN: expected a focused comment box for upload ${i + 1}/${files.length} but didn't find one — enter the comment by hand: "${uploadComment}"`);
        }
      }
    }
  } else {
    log(rowNum, `WARN: no receipt/converter files to upload — check manifest.`);
  }

  if (entry.workdayItem === 'Airfare' && entry.itemDetails) {
    const d = entry.itemDetails;
    const memoNotes = [];

    if (d.airline) {
      const airlineOk = await selectTypeahead(page, scope, 'Airline', d.airline, rowNum);
      if (!airlineOk) {
        log(rowNum, `Airline "${d.airline}" not an allowed value — falling back to "American Airlines" per policy`);
        const fallbackOk = await selectTypeahead(page, scope, 'Airline', 'American Airlines', rowNum);
        if (fallbackOk) {
          memoNotes.push(`True airline is ${d.airline}; not available in Workday lookup, American Airlines used as placeholder`);
        } else {
          log(rowNum, `WARN: Airline fallback "American Airlines" also failed — fill in by hand.`);
        }
      }
    }
    if (d.arrivalDate) await setDateField(scope, 'Arrival Date', d.arrivalDate, rowNum);
    if (d.departureDate) await setDateField(scope, 'Departure Date', d.departureDate, rowNum);
    if (d.classOfService) await selectTypeahead(page, scope, 'Class of Service', d.classOfService, rowNum);

    // Origination/destination are already the resolved major city from
    // build_workday_manifest.js (MAJOR_CITY/resolveCity) — a single typed
    // attempt here, no runtime fallback. Any "true city is X" memo note for
    // these is already baked into entry.memo by the manifest builder;
    // pick that up alongside the airline-fallback note below.
    if (entry.memo) memoNotes.push(entry.memo);
    if (d.origination) await selectCity(page, scope, 'Origination', d.origination, rowNum);
    if (d.destination) await selectCity(page, scope, 'Destination', d.destination, rowNum);

    if (memoNotes.length) {
      const memoLi2 = fieldByLabel(scope, 'Memo');
      await memoLi2.locator('input, textarea').first().fill(memoNotes.join('; '));
      log(rowNum, `Memo set: ${memoNotes.join('; ')}`);
    }

    // Commit here — see commitLine()'s comment (same reasoning as the Hotel
    // path: lock in what's entered so far before moving on).
    await commitLine(page, rowNum);
  }

  if (entry.workdayItem === 'Hotel' && entry.hotelItemization) {
    const h = entry.hotelItemization;
    if (h.arrivalDate) await setDateField(scope, 'Arrival Date', h.arrivalDate, rowNum);
    if (h.departureDate) await setDateField(scope, 'Departure Date', h.departureDate, rowNum);
    // h.destination is already the resolved major city from
    // build_workday_manifest.js (MAJOR_CITY/resolveCity) — a single typed
    // attempt, no runtime fallback. h.description already carries the
    // "true destination is X" note, baked in by the manifest builder,
    // when a substitution was made.
    if (h.destination) await selectCity(page, scope, 'Destination', h.destination, rowNum);
    if (h.description) {
      const descLi = fieldByLabel(scope, 'Description');
      await descLi.locator('input, textarea').first().fill(h.description);
    }

    // Commit here, before opening itemization — see commitLine()'s comment.
    // Everything so far (date/item/amount/memo/upload/destination) gets
    // locked in as actually-saved state before we move into the itemization
    // sub-form, rather than relying on it staying correctly held in an
    // uncommitted, possibly-fragile UI state through several more steps.
    await commitLine(page, rowNum);

    // Itemization: Daily Expenses -> Edit -> fill Room Rate, delete Taxes/Fees, Done
    // Wait for the button to actually render rather than an instant count()
    // check. Real incident (2026-08-26): right after Destination now
    // resolves faster (single attempt, no retry loop), the page hadn't
    // finished re-rendering the itemization panel yet at the moment of the
    // check — it logged "no Edit button found" and skipped itemization
    // entirely, leaving the line's required itemization data incomplete,
    // which is suspected to be why Workday's own "Discard Changes?" dialog
    // then appeared later at save time (see dismissDiscardDialogIfPresent
    // comment) — likely normal Workday behavior for an invalid/incomplete
    // line, not an automation-specific glitch.
    const editButtons = page.getByRole('button', { name: 'Edit', exact: true });
    const editButtonAppeared = await editButtons.first().waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
    if (editButtonAppeared) {
      await editButtons.first().click();

      // The Edit click opens a modal popup (data-automation-widget="wd-popup")
      // layered over the rest of the page. Scope everything to it — page-wide
      // lookups can otherwise match elements hidden behind the modal (e.g. the
      // uploaded receipt's own "Delete" button) or, for Number of
      // Nights/Daily Rate specifically, land on the SAME <li> if both labels
      // sit in one compact row: fieldByLabel()'s "first input in the li that
      // contains this label" breaks when two fields share an li, silently
      // writing both fills into the one input. getByLabel() resolves each
      // field via its real label association instead, so this is used here
      // rather than fieldByLabel().
      const dialogScope = page.locator('[data-automation-widget="wd-popup"]').last();

      // Wait for the actual field, not a fixed timeout. Real incident
      // (2026-08-26): a fixed 800ms wait here left Number of Nights/Daily
      // Rate showing Workday's own uninitialized garbage (e.g. -8763
      // nights, $0 rate) — the same failure signature as the very first
      // itemization bug, meaning the fill was landing before the modal's
      // fields were actually ready, not on the wrong element this time.
      const nightsField = dialogScope.getByLabel('Number of Nights', { exact: true }).first();
      const nightsReady = await nightsField.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
      if (!nightsReady) {
        log(rowNum, `WARN: itemization dialog opened but "Number of Nights" never became visible — fill Daily Expenses by hand.`);
      } else {
        await nightsField.fill('1');
        await dialogScope.getByLabel('Daily Rate', { exact: true }).first().fill(String(h.dailyRate));
        if (h.memo) {
          await dialogScope.getByLabel('Memo', { exact: true }).first().fill(h.memo);
        }
        // Remove the Taxes/Fees sub-form. Confirmed via live DOM dump
        // (2026-08-25): Workday's own control here is labeled "Remove", not
        // "Delete" — and there is exactly ONE such control in the dialog,
        // since the mandatory Room Rate box has no remove option at all (only
        // the optional Taxes/Fees box does). The earlier "delete"-text-based
        // selector was actually matching the two uploaded files' own "Delete
        // <filename>" attachment buttons (receipt + converter PDF) — 2 matches,
        // so it looked successful, but neither was the itemization control.
        const removeButton = dialogScope.getByRole('button', { name: 'Remove', exact: true });
        const removeReady = await removeButton.first().waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
        let taxesRemoved = false;
        if (removeReady) {
          await removeButton.first().click();
          await page.waitForTimeout(500);
          taxesRemoved = true;
        } else {
          log(rowNum, `WARN: no "Remove" control found in itemization dialog — Taxes/Fees box NOT removed, fill in or remove by hand.`);
        }
        const doneButton = dialogScope.getByRole('button', { name: 'Done', exact: true });
        if (await doneButton.count()) await doneButton.click();
        log(rowNum, `Itemization filled (1 night, $${h.dailyRate}${taxesRemoved ? ', taxes/fees removed' : ' — taxes/fees box NOT removed, see WARN above'})`);
      }
    } else {
      log(rowNum, `WARN: no Itemization "Edit" button found — fill Daily Expenses by hand.`);
    }
  }

  // Final commit — see commitLine()'s comment. THIS SELECTOR IS THE MOST
  // LIKELY THING TO NEED ADJUSTING — see WORKDAY_AUTOMATION_INSTRUCTIONS.md
  // "If the save-click doesn't work".
  await commitLine(page, rowNum);
  log(rowNum, `Saved.`);
}

async function main() {
  const opts = parseArgs();
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  let rows = manifest.rows;
  if (opts.row) rows = rows.filter(r => r.xlsxRow === opts.row);
  else {
    if (opts.from) rows = rows.filter(r => r.xlsxRow >= opts.from);
    if (opts.to) rows = rows.filter(r => r.xlsxRow <= opts.to);
  }

  const blockers = rows.filter(r => r.needsManualReceipt || (r.workdayItem === 'Airfare' && !r.itemDetails.airline) || (r.workdayItem === 'Hotel' && !r.hotelItemization.destination) || !r.workdayItem);
  if (blockers.length) {
    console.log('These rows are missing required manifest data — fix workday_manifest.json before running them:');
    blockers.forEach(b => console.log(`  row ${b.xlsxRow}: ${b.description}`));
    rows = rows.filter(r => !blockers.includes(r));
    console.log(`Continuing with the other ${rows.length} row(s).\n`);
  }

  console.log(`Launching Chrome (profile: ${PROFILE_DIR})...`);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: opts.headless,
    channel: 'chrome',
    viewport: { width: 1400, height: 1000 },
  });
  const page = context.pages()[0] || await context.newPage();

  const url = page.url();
  if (!url.includes('myworkday.com') || !url.includes('rel-task')) {
    await page.goto(WORKDAY_HOME);
    await waitForEnter('A Chrome window opened. Log into Workday, navigate to Expense Reports, and open the report in EDIT mode (Expense Lines tab visible). Then press Enter here to continue...');
  }

  // Asked once, reused for every uploaded PDF in this run (receipt AND
  // converter PDF both get it) — see uploadComment() below. Press Enter to
  // skip entirely if this run doesn't need one.
  const uploadComment = opts.dryRun ? '' : await promptForLine('Optional: text to enter in the comment box after each PDF upload (press Enter to skip):');

  console.log(`\nProcessing ${rows.length} row(s)${opts.dryRun ? ' (DRY RUN — no clicks will be made)' : ''}...\n`);

  for (const entry of rows) {
    if (opts.dryRun) {
      log(entry.xlsxRow, `Would fill: ${JSON.stringify(entry)}`);
      continue;
    }
    try {
      await fillOneRow(page, entry, uploadComment);
    } catch (err) {
      log(entry.xlsxRow, `ERROR: ${err.message}`);
      const shotPath = `error_row${entry.xlsxRow}.png`;
      await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
      log(entry.xlsxRow, `Screenshot saved to ${shotPath}. Skipping to next row — fix this one by hand.`);
      // Safety net: don't leave a "Discard Changes?" dialog open when moving
      // to the next row — an open dialog could block or interfere with the
      // next row's "Add" click in an unpredictable way. Always dismisses via
      // "Continue" (never "Discard").
      await dismissDiscardDialogIfPresent(page, entry.xlsxRow);
    }
  }

  console.log('\nDone with this batch. Review the report in Workday before submitting — this script never clicks Submit.');
  console.log('Browser window left open for you to inspect. This terminal will stay attached —');
  console.log('press Ctrl+C here, or just close the Chrome window, whenever you\'re done looking.');
}

main()
  .catch(e => { console.error(e); process.exit(1); });
// Deliberately no .then(() => process.exit(0)) on success: Playwright kills
// its spawned Chrome process as cleanup when the Node process exits, so an
// immediate exit here would yank the browser window away right when you
// want to inspect it (this was a real bug — the browser used to vanish
// right after the batch finished, even though the log claimed otherwise).
