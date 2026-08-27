# Developer notes

This is the "why" document — architecture, design rationale, and the
debugging history behind non-obvious decisions in this tool. If you just
want to run a trip through it, use **README.md** instead; nothing here is
required reading to get an expense report submitted.

## What's here

**Code — the same for every trip, nobody needs to edit these to run a
trip.** `oanda_converter_lib.js` and `batch_process_converter.js` have
nothing trip-specific in them at all. `rebuild_spreadsheet.js` and
`fill_workday.js` are also generic logic, but each holds one small constant
you point at your own data (called out below).

```
oanda_converter_lib.js         Playwright helpers for the OANDA site
build_receipts_json.js         reads the source xlsx and writes receipts.json
                                automatically — Date/Currency/Amount (Original)
                                are already in the spreadsheet per row, so
                                there's no reason to hand-type them a second
                                time. Same SRC_FILE constant as
                                rebuild_spreadsheet.js, below. Asks before
                                overwriting an existing receipts.json.
batch_process_converter.js     drives oanda_converter_lib.js for every row
                                in receipts.json -> oanda_converter_pdfs/ (a
                                saved PDF per receipt) + rates_result_converter.json
rebuild_spreadsheet.js         reads the source xlsx fresh, appends
                                Oanda_Converter_Rate / Oanda_Converter_USD,
                                writes a freshly-timestamped output file
                                (never overwrites the source). Its SRC_FILE
                                constant names the input spreadsheet — point
                                this at your own xlsx's filename.
fill_workday.js                drives a real Chrome window to create Expense
                                Lines from workday_manifest.json. Never
                                clicks Submit. Its WORKDAY_HOME constant
                                points at our organization's Workday login
                                URL — same for everyone at VIMS/W&M, nothing
                                to change.
setup_new_trip.js              copies exactly the files a new trip needs
                                into a new folder (see below) and creates an
                                empty receipts/. Run from this original
                                folder, once per trip.
```

As of this writing every code file above is byte-identical whether it's
sitting in this original folder, a `setup_new_trip.js`-created trip folder,
or a colleague's copy — there is no longer any per-trip editing needed in
any of them (see "Why there's no code duplication to manage" below). That
wasn't always true; `setup_new_trip.js` only became possible to write once
it was.

**"Semi-code" — a script everyone reuses, but which holds YOUR trip's data
as hand-written lookup tables inside it.** `build_workday_manifest.js` is
structurally the same for every trip (the algorithm — resolving cities,
building itemization — never changes), but the lookup tables near the top
(`MAJOR_CITY`, `FLIGHT_DETAILS`, `CONVERTER_OVERRIDES`, `CATEGORY_TO_ITEM`)
are your trip's actual data, just written as JS objects instead of
spreadsheet rows. It automatically picks up whichever `*_verified.xlsx`
file `rebuild_spreadsheet.js` most recently produced (they sort
chronologically by filename) — nothing to update by hand there.

Which receipt file belongs to which row, and each Hotel row's destination,
are **not** in these lookup tables — they're the spreadsheet's `Receipt
Filename`, `True Destination`, and `Major City` columns instead. Both used
to be hand-maintained JS tables (`RECEIPT_OVERRIDES`, `HOTEL_CITY`) keyed by
row number — moved into the spreadsheet itself since that's already where
you're looking at the receipt, and it removes the risk of a stale table
entry silently applying to the wrong row later. (An earlier
receipt-matching design inferred the file from the date instead of
requiring a filename at all — that broke on two unrelated expenses landing
on the same calendar date, e.g. a trip's last-day taxi and a same-day ride
home, which is part of why explicit-in-the-spreadsheet won out generally.)
As of this writing, Airfare's origin/destination still resolve through
`MAJOR_CITY`/`resolveCity` in code rather than spreadsheet columns, purely
because no example/real row has needed it yet — the same column-based
treatment could extend there.

A Category your spreadsheet uses that isn't in `CATEGORY_TO_ITEM` doesn't
block that row — it gets entered as `DEFAULT_ITEM` ("Field Supplies -
Travel") as a visible placeholder, with a Memo note saying so and a matching
line in `workday_manifest_warnings.txt`. Same idea as the existing Airline
fallback (an unrecognized airline becomes "American Airlines" + a Memo
note): a wrong-but-visible category is easy to fix by hand during the
mandatory pre-Submit review in Workday; a row that's silently skipped is
easy to forget about entirely. Add real mappings to `CATEGORY_TO_ITEM` as
you find categories worth having their own Workday item — the placeholder
is a safety net, not a substitute for that.

**Optional: `workday_expense_items.xlsx`** — a growing, hand-maintained
reference list of Workday Expense Item names actually confirmed to exist
(one per row, no header — e.g. `Hotel`, `Airfare`, `Transportation`). If
present, `build_workday_manifest.js` checks every row's resolved item
against it and warns (never blocks) if it's not on the list — catching a
typo'd item name at manifest-build time instead of it only surfacing as a
live failure in `fill_workday.js` much later. The list is expected to be
incomplete; add to it as you confirm new items exist in Workday's own
picker. Not org-specific config shared across trips like `CATEGORY_TO_ITEM`
— it's a shared *reference*, so it's fine (and useful) to reuse the same
file across your own trips as it grows, unlike the trip-specific lookup
tables above.

**Data — yours, specific to one trip. Hand-author both for every new
trip:** your spreadsheet (see README's column list) and `receipts/`.
`receipts.json` used to be a third hand-authored file, but everything in it
is already sitting in the spreadsheet, so `build_receipts_json.js` derives
it for you now. You'd only ever hand-edit it afterward for a one-off
correction.

**Generated by running the pipeline — don't hand-edit, don't need to
understand these to use the tool, safe to delete and regenerate anytime:**
`oanda_converter_pdfs/`, `rates_result_converter.json`,
`*_verified.xlsx`, `workday_manifest.json`, `workday_manifest_warnings.txt`.

## Why `setup_new_trip.js` exists, and why it's not a `starter-kit/` folder

Once `MAJOR_CITY`/`FLIGHT_DETAILS`/`CONVERTER_OVERRIDES` all became `{}` by
default and Hotel destinations moved to spreadsheet columns, every code
file stopped having any per-trip content at all — `CATEGORY_TO_ITEM`,
`DEFAULT_ITEM`, and `WORKDAY_HOME` are org-wide, not trip-specific. That
made an earlier idea — a separate `starter-kit/` subfolder holding its own
copy of the code, kept in sync with this folder's copy by hand — pointless:
there's nothing left that would ever diverge between the two copies, so
"keeping them in sync" would just mean copying identical files forever.

The real problem `starter-kit/` was meant to solve was narrower: a new
trip needs a subset of this folder's files, in a new location, without the
example data or anything the pipeline generates — and doing that copy by
hand, file by file, is exactly the kind of thing a person gets subtly wrong
(a summary of the first attempt at this: a folder that had `receipts/`
copied in but not `package.json` or any of the code). `setup_new_trip.js`
solves that directly — it copies precisely the files a trip needs (see
`FILES_TO_COPY` at its top) into a new folder, and nothing else, with no
separate template copy to fall out of date.

`README.md`/`DEVELOPER_NOTES.md` are deliberately NOT copied into a new
trip folder — the Claude-prompt step still references `Travel_Expenses.xlsx`
from this original folder as a format template, so the docs stay valid only
from here. Treat this folder as the permanent copy you keep around and read
from; trip folders are disposable, code-wise (`setup_new_trip.js` can
recreate one from scratch anytime).

`Travel_Expenses.xlsx` was renamed from `Travel_Expenses_Example.xlsx` for
the same reason: `rebuild_spreadsheet.js`/`build_receipts_json.js`'s
`SRC_FILE` constant defaults to that exact filename, and a real trip's
spreadsheet shouldn't have to be named "..._Example" to hit the
zero-config path.

## Why `True Destination`/`Major City` live in the spreadsheet, not code

Workday's **Destination** field is a constrained dropdown that often won't
have the actual town (e.g. a homestay in a small town) — the convention is
to pick the nearest big city Workday *does* offer, and note the true
destination elsewhere. An earlier version tried the true (small) city
first in the browser and fell back to a major city only after Workday
rejected it — that live retry (clearing and retyping the same field)
turned out to trigger a real, occasionally destructive Workday "Discard
Changes?" dialog in testing. Resolving to the major city up front, at
manifest-build time, means `fill_workday.js` only ever types ONE,
already-correct city into that field — no retry, no clearing, no dialog
risk.

Filling in `True Destination`/`Major City` is genuinely different from
every other step in this tool: it requires actually reading a receipt
(sometimes an image with no text layer, sometimes multiple candidate
addresses on one document) and making a judgment call about the nearest
city a corporate travel system would recognize. No deterministic script can
do that reliably — it's why this is the one AI-assisted step in the whole
pipeline (see README's "Generating your xlsx with Claude"), not a `node
something.js` command.

## Why receipt matching requires an exact filename, not inference

Superseded design: match receipts to spreadsheet rows by date, falling back
to a hand-maintained `RECEIPT_OVERRIDES` table only when a date had more
than one row or file. This was the single biggest source of back-and-forth
building the original version of this tool — and it broke again on a later
trip when two completely unrelated expenses (a foreign trip's last-day
taxi, a same-day ride home domestically) landed on the same calendar date.
Requiring the exact filename explicitly, every row, removes the whole
ambiguity category rather than trying to resolve it more cleverly.

## Why `CONVERTER_OVERRIDES` should rarely (or never) be needed

The policy this tool assumes: once you've reviewed your spreadsheet and
receipts and are satisfied with them, treat them as **frozen**. If you find
a mistake later, fix it in the source spreadsheet and re-run the pipeline
from `build_receipts_json.js` onward — don't hand-patch a generated file
partway through. Every step from `build_receipts_json.js` through
`build_workday_manifest.js` is cheap and safe to rerun in full. Under that
discipline, `CONVERTER_OVERRIDES` (a table for "this receipt's date/amount
was corrected after its OANDA PDF was already generated") shouldn't come up
at all — the override existed to patch around a workflow that allowed
post-hoc corrections without full regeneration. It's kept as an escape
hatch, not a normal part of the flow.

## Comment-on-upload mechanics

If your organization wants something entered on every attached
receipt/converter PDF (e.g. "Less than 60 days have elapsed since
completion of travel."), `fill_workday.js` prompts for it once at the start
of each run. Confirmed by hand: Workday shows a comment box tied to each
upload as its own event — the cursor lands there automatically right after
that one file finishes uploading, and Enter does not submit/commit it (same
"click sidebar to save" rule as everything else). This is why the script
uploads files one at a time rather than batching them: batching two files
into a single `setInputFiles()` call produced two comment boxes with
unpredictable/shared focus, which split or dropped the typed text.

## Workday Hotel itemization — the full story

- **One Expense Line per hotel *stay*, not per receipt.** If a stay
  produced multiple receipts (e.g. one per room), they all attach to the
  *same* line, and the amount is the grand total, not any single receipt's
  printed figure.
- **Quantity is always `1`** at the Expense Line level, regardless of how
  many nights or rooms. **Per Unit Amount = the full total.**
- Inside the Itemization sub-section's "Daily Expenses" form (**Edit**, not
  Add): **Number of Nights is always `1`**, **Daily Rate = the same grand
  total** as the top-level amount — not divided by nights. This matches the
  org's convention, confirmed by hand. There are two itemization sub-forms,
  Room Rate and Taxes/Fees — if the receipt shows no separate tax line,
  delete the Taxes/Fees sub-form rather than leaving zeros.
- Room/traveler counts are never inferred from the receipt PDF itself —
  `parseRooms()` only picks up a count if the spreadsheet's Description
  literally contains "N room(s)". Deliberate: some receipts have no
  extractable text layer at all, and inferring a count from a receipt's
  layout is exactly the kind of silent guess this tool is built to avoid.

## How battle-tested this actually is

`fill_workday.js` has been extensively live-tested against a real Workday
W&M instance, not just written and hoped for — including full runs across
multiple real trips. Real bugs were found and fixed this way: a
field-lookup bug that silently corrupted itemization data, Workday's own
"Discard Changes?" confirmation dialog appearing at several points (now
always safely dismissed via "Continue", never "Discard"), and Workday's "no
real Save button — click the sidebar entry to commit" behavior turning out
to apply throughout the whole flow, not just at the end (see `commitLine()`
in the source). Still, Workday tenants and expense-report templates can
differ — always watch the single-row test rather than assuming a fresh
trip will behave identically to the last one.

## Gotchas, with the full backstory

1. **Per-passenger vs. total fare on multi-traveler flights.** Some airline
   confirmations print the fare *per passenger* even on a combined
   booking — if a row is modeled as "covers N travelers," verify the
   receipt's actual total rather than assuming the printed figure already
   is the total. (Hotel receipts differ: a printed total already covers
   every room/traveler.) This caused a real 2x undercount on the trip this
   tool was built for, caught only because the receipt was actually read
   carefully.
2. **Receipt Filename typos.** They're safe (flagged in
   `workday_manifest_warnings.txt`, never silently attach the wrong file)
   but real — every filename has to be exact.
3. **`MAJOR_CITY`/`FLIGHT_DETAILS`/`CONVERTER_OVERRIDES` are trip-specific
   and hand-maintained on purpose**, expected to be reset to `{}` for a new
   trip (see README's setup steps) — a leftover entry from a previous
   trip's spreadsheet-row numbering could otherwise silently apply to an
   unrelated row.
4. Room/traveler counts and destinations are never inferred from receipt
   content by code — see the itemization section above and the
   `True Destination`/`Major City` section.
5. Spreadsheet column names are read by name, not position — a renamed or
   reordered header just won't be found, rather than silently
   misattributing data to the wrong column.

## Appendix rationale

The 3 example receipts (redacted: names/contact info/card numbers removed,
guest name replaced with "John Doe") were deliberately chosen to exercise
the two hardest parts of the process: currency conversion (one IDR pair,
one TWD pair) and Workday's Hotel itemization (including a multi-room
stay). The FXDS "mathematically correct rate" pipeline is intentionally
excluded from this package — the organization's actual procedure requires
the OANDA public currency-converter specifically, including its documented
1-day lag, not the historically-correct rate, so only that one tool is
automated here.
