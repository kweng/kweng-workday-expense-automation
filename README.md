# Travel expense automation

This tool looks up official foreign-currency conversion rates and pre-fills
your Workday expense report for you, using a browser window you watch. It
never clicks Submit — you review everything and submit it yourself.

This is a step-by-step user guide. For the reasoning behind how it's built,
see `DEVELOPER_NOTES.md` instead.

**New to this tool?** Do the Appendix at the bottom first, with the example
data that's already included — it's a fast way to confirm everything works
before you use your own trip's data.

## Prerequisites

1. Node.js and npm are installed.
2. Google Chrome (the real app, not just any browser) is installed.
3. You don't need to install any Chrome extensions.
4. You'll log into Workday yourself, by hand, in the Chrome window the tool
   opens for you. Nothing types your password for you.

## Setup

1. Download this project (however it was shared with you — a GitHub
   download/clone, a Google Drive or OneDrive folder, a zip file, etc.) and
   save it somewhere on your computer you'll keep around long-term, e.g.
   `Documents/travel-expense-automation`. If it downloaded as a `.zip`,
   unzip it first — you need the actual folder, not the zip file. **This is
   your permanent reference copy** — don't delete it, and don't use it
   directly for any one trip's data (see "Start a new trip folder" below).
   Note where you put it; you'll need that location in the next step.
2. Open a terminal in that folder. (On a Mac: open Finder, navigate to the
   folder, right-click it, and look for "New Terminal at Folder" — or open
   Terminal and type `cd ` followed by dragging the folder into the
   window, then press Return.)
3. Run:
   ```
   npm install
   ```
   This installs everything needed, including the browser used for the
   currency-lookup step. Nothing else to install.

## Start a new trip folder

Do this once per trip, from inside this folder (the one you were given —
not a trip folder from a previous trip):

1. Run:
   ```
   node setup_new_trip.js /path/to/wherever/you/want/this/trips/folder
   ```
   This creates that folder and copies in exactly the code this tool needs
   — nothing example-specific, nothing generated. It also creates an empty
   `receipts/` folder there.
2. `cd` into that new folder.
3. Run:
   ```
   npm install
   ```
4. Continue with "Generating your spreadsheet with Claude" below, working
   from inside this new folder — except where a step says to grab
   something from this original folder specifically (`Travel_Expenses.xlsx`
   isn't copied into your new trip folder on purpose, so you'll come back
   here for it once).

## Generating your spreadsheet with Claude

Do this first, before "Setting up your own trip" below. If you'd rather
type your spreadsheet by hand instead, skip to "Setting up your own trip"
and fill in the spreadsheet yourself using the column table there.

1. Put all your receipts (PDFs or photos) for one trip into a folder on
   your computer.
2. Open a Claude session in a web browser (e.g. claude.ai) and sign in.
3. Open this README file and copy the prompt below (everything inside the
   gray box). Paste it into your Claude session. **Do not press Return
   yet.**
4. Drag all your receipt files into the Claude session to upload them.
5. Drag `Travel_Expenses.xlsx`, from this original folder (not your new
   trip folder — it isn't there), into the Claude session to upload it too.
6. Now press Return, so Claude reads your receipts and builds your
   spreadsheet.

```
I am building a travel expense report. I've uploaded:
1. A batch of receipt PDFs/images for one trip.
2. An example spreadsheet (Travel_Expenses.xlsx) showing the exact
   format I need — same sheet name, same column headers.

For each receipt, add one row to a new spreadsheet matching the example's
exact column headers and sheet name ("OANDA Aligned Expenses"). Columns,
one row per expense line:

- Date — the expense date (YYYY-MM-DD)
- Description — free text describing the expense. For a hotel stay,
  include how many nights and how many rooms it covers, e.g. "Hotel Name
  (2 Rooms, 3 nights)" — this exact phrasing ("N nights" / "N rooms")
  matters, it's parsed literally downstream. For a flight, include the
  word "flight" somewhere in the description.
- Category — a short category label. Reuse one of these where it fits:
  Visa / Fees, Telecom, Accommodation, Gear / Equipment, Activities,
  Medical / Personal, Insurance, Transportation, Air Travel. If none fit,
  use a new, clear label of your own — that's fine, it just needs one
  manual mapping added later.
- Vendor / Platform — who was paid
- Amount (Original) — the real total actually paid, in the receipt's own
  currency. Never a placeholder or rounded estimate — read the actual
  printed total.
- Currency — the 3-letter code, e.g. IDR, TWD, USD
- Payer / Guest Name — whose name is on the receipt (this can differ from
  the actual traveler — note that in Comment if so)
- Comment — optional; use for anything unusual or worth a note
- Receipt Filename — rename each receipt file to this pattern:
  YYYYMMDD_category_vendor_item.pdf (lowercase, hyphens instead of spaces
  within a single field, e.g. 20260824_airfare_united_ric-tpe.pdf), and put
  the exact new filename here. Give me the renamed files to download
  alongside the spreadsheet.
- True Destination — ONLY for Accommodation/Hotel rows: the actual
  town/city the hotel is in, exactly as it would appear on a map (not a
  neighborhood or the hotel's brand name).
- Major City — ONLY for Accommodation/Hotel rows: your best guess at the
  nearest large/well-known city a corporate travel booking system would
  likely have as an option, if the true destination is a small town. Leave
  blank if the true destination is already a major city. Put ONLY the city
  name in this field — no country, no comma, no explanation of how
  confident you are in the guess. This gets typed verbatim into a real
  form field later, so anything extra here breaks it. If you want to note
  your confidence, or flag that a city was ambiguous, put that in Comment
  instead.

If a single hotel stay is split across multiple SEPARATE receipt files
(not multiple line items on one file), don't silently combine them into
one row — flag it in Comment instead ("multiple receipt files for this
stay, needs manual handling") and list each file as its own row. I'll sort
out the combination by hand.

Don't guess or leave a field blank if you genuinely can't tell — flag
anything ambiguous or where you weren't confident, in the Comment column,
rather than silently picking something. I will review every row against
its actual receipt before using this spreadsheet, so it's fine to be
uncertain — just don't be silently wrong.
```

7. Download the spreadsheet Claude gives you, and the renamed receipt files.
8. Open the spreadsheet. Check every row against its actual receipt. Fix
   anything wrong. For hotel rows, check `True Destination` and
   `Major City` in particular.
9. Once you're satisfied with the spreadsheet and receipts, treat both as
   final. If you find a mistake later, fix it here and redo everything
   below from the start — don't edit any file produced after this point.

## Setting up your own trip

**Step 1 — your spreadsheet.** Any filename you like, one sheet named
"OANDA Aligned Expenses", one row per expense line. Column order doesn't
matter, but the header names below must match exactly.

| Column | Required? | What goes in it |
|---|---|---|
| `Date` | yes | the expense date |
| `Description` | yes | free text — must include "N nights" / "N rooms" for hotel rows, and the word "flight" for airfare rows |
| `Category` | yes | any category label |
| `Vendor / Platform` | yes | who you paid |
| `Amount (Original)` | yes | the real amount actually paid, in the receipt's own currency |
| `Currency` | yes | e.g. `IDR`, `TWD`, `USD` |
| `Payer / Guest Name` | yes | whose name is on the receipt |
| `Receipt Filename` | yes | the exact filename (in `receipts/`) of that row's receipt |
| `True Destination` | Hotel rows only | the real place, e.g. "Serpong" |
| `Major City` | optional | the nearest city Workday's picker actually has, e.g. "Jakarta" — leave blank if not needed |
| `Comment` | no | free text |

If you didn't use the Claude prompt above, fill in `True Destination` and
`Major City` yourself for each hotel row by reading that receipt (or ask an
AI assistant to read it and suggest a value, then double-check it).

Name your spreadsheet file `Travel_Expenses.xlsx` to match the default with
nothing to configure. If you'd rather use a different filename, open
`rebuild_spreadsheet.js` and `build_receipts_json.js` and change the
`SRC_FILE` constant near the top of each to your filename. Put it in your
trip folder (see "Start a new trip folder" above).

**Step 2 — your receipts.** Put all your receipt PDFs in your trip
folder's `receipts/` (created empty by `setup_new_trip.js`).

**Step 3 — run:**
```
node build_receipts_json.js
```

**Step 4 — run:**
```
node batch_process_converter.js
```
This takes ~10-15 seconds per non-USD receipt. If a row fails with a
"Sanity check failed... 900% off" error, just run this command again.

**Step 5 — run:**
```
node rebuild_spreadsheet.js
```
This writes a new file like `20260826_1400_Travel_Expenses_verified.xlsx`
and never touches your original spreadsheet.

**Step 6 — only if you have Airfare rows:** open
`build_workday_manifest.js` and add an entry to `MAJOR_CITY` and
`FLIGHT_DETAILS` for each Airfare row (airline, origin, destination).
Nothing to do here for Hotel rows.

**Step 7 — run:**
```
node build_workday_manifest.js
```
This writes `workday_manifest.json` and `workday_manifest_warnings.txt`.
**Open and read `workday_manifest_warnings.txt`.** Fix anything it lists
(in your spreadsheet or in `build_workday_manifest.js`), then run this
command again until the warnings you care about are gone.

**Step 8 — test one row.** Run:
```
node fill_workday.js --row N
```
(replace `N` with a row number). A Chrome window opens. Log into Workday
yourself, open the target expense report's Expense Lines tab, then go back
to the terminal and press Enter. Watch the whole thing happen. Check the
result in Workday against the receipt before continuing.

**Step 9 — run the rest:**
```
node fill_workday.js --from N --to M
```
(replace `N` and `M` with your row range). If a row fails, it saves a
screenshot (`error_row<N>.png`) and moves on to the next row — check the
terminal output and any error screenshots afterward, and finish those rows
by hand in Workday.

**Step 10 — review in Workday.** Check every line. Fix anything that needs
it, including any row entered as "Field Supplies - Travel" (a placeholder —
recategorize it by hand). Click Submit yourself when everything looks
right. This tool never submits for you.

## Workday Hotel itemization checklist

Use this while reviewing each Hotel line in Workday:

- One Expense Line per hotel **stay**, not per receipt. If a stay produced
  multiple receipts, they all attach to the same line, and the amount is
  the grand total of all of them.
- Quantity = `1`. Per Unit Amount = the full total.
- Inside the line's Itemization section, click **Edit** (not Add) on the
  Daily Expenses form.
- Number of Nights = `1`. Daily Rate = the same full total (not divided by
  nights).
- If the receipt has no separate tax line, delete the Taxes/Fees sub-form
  rather than leaving it at zero.

## Before you run `fill_workday.js`, double-check

- Every `Receipt Filename` in your spreadsheet exactly matches a file in
  `receipts/`.
- Every hotel row's `Description` says "N nights", and "N rooms" if more
  than one room.
- Every hotel row's `True Destination` is filled in.
- You've read `workday_manifest_warnings.txt` from the latest
  `build_workday_manifest.js` run and fixed everything it lists.

---

## Appendix: try the included example

This repo ships with 3 real, redacted receipts in `receipts/`, already
matched to `Travel_Expenses.xlsx`. Run this directly in this original
folder — no need for `setup_new_trip.js` here.

**Step 1 — run:**
```
node build_receipts_json.js
```
Writes `receipts.json`.

**Step 2 — run:**
```
node batch_process_converter.js
```
This makes real requests to `oanda.com/currency-converter` and saves a PDF
for each of the 3 example receipts, ~10-15 seconds each. Writes
`oanda_converter_pdfs/` and `rates_result_converter.json`.

**Step 3 — run:**
```
node rebuild_spreadsheet.js
```
Writes a new file like `20260825_1400_Travel_Expenses_verified.xlsx`.

**Step 4 — run:**
```
node build_workday_manifest.js
```
Writes `workday_manifest.json` and `workday_manifest_warnings.txt`. This
should finish with **0 warnings**. Open `workday_manifest.json` and compare
it against the 3 receipts in `receipts/` — every field it would enter for
each row is right there.

### Don't run `fill_workday.js` on this example data

`fill_workday.js` opens a real Chrome window against **your actual Workday
account** and asks you to log in and open a real expense report — even
before it does anything else. There's no reason to attach this fabricated
"John Doe" example data to a real expense report, so just read
`workday_manifest.json` directly to see what the tool would do.

When you've set up your own real trip (see "Setting up your own trip"
above), that's when you run `fill_workday.js --row N` for real.
