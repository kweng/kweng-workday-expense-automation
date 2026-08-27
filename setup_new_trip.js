// Creates a new, self-contained trip folder — copies exactly the files a
// new trip needs (code, package.json, the org's item reference list) and
// creates an empty receipts/ folder. Does NOT copy the example spreadsheet,
// the example receipts, README.md/DEVELOPER_NOTES.md, or anything generated
// by running the pipeline (node_modules/, package-lock.json,
// oanda_converter_pdfs/, rates_result_converter.json, receipts.json,
// *_verified.xlsx, workday_manifest.json, workday_manifest_warnings.txt) —
// none of that belongs in a fresh trip folder. Keep following README.md
// from this original folder; it references files (like Travel_Expenses.xlsx)
// that live here, not in the new trip folder.
//
// Run: node setup_new_trip.js /path/to/new/trip/folder
// Then, inside that new folder: npm install.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const FILES_TO_COPY = [
  'package.json',
  'oanda_converter_lib.js',
  'build_receipts_json.js',
  'batch_process_converter.js',
  'rebuild_spreadsheet.js',
  'build_workday_manifest.js',
  'fill_workday.js',
  'workday_expense_items.xlsx',
];

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return answer.trim().toLowerCase() === 'y';
}

async function main() {
  const dest = process.argv[2];
  if (!dest) {
    console.error('Usage: node setup_new_trip.js /path/to/new/trip/folder');
    process.exit(1);
  }
  const srcDir = __dirname;
  const destDir = path.resolve(dest);

  if (destDir === srcDir) {
    console.error('Destination can\'t be this same folder — pick a new, separate folder for the trip.');
    process.exit(1);
  }

  fs.mkdirSync(destDir, { recursive: true });

  for (const file of FILES_TO_COPY) {
    const srcPath = path.join(srcDir, file);
    if (!fs.existsSync(srcPath)) {
      console.error(`Missing expected file: ${file} — skipping.`);
      continue;
    }
    const destPath = path.join(destDir, file);
    if (fs.existsSync(destPath)) {
      const ok = await confirm(`${file} already exists in ${destDir} — overwrite it? (y/N) `);
      if (!ok) {
        console.log(`Left existing ${file} untouched.`);
        continue;
      }
    }
    fs.copyFileSync(srcPath, destPath);
    console.log(`Copied ${file}`);
  }

  const receiptsDir = path.join(destDir, 'receipts');
  fs.mkdirSync(receiptsDir, { recursive: true });
  console.log(`Created empty receipts/ folder`);

  console.log(`\nDone. New trip folder: ${destDir}`);
  console.log(`Next: cd into it, run "npm install", then come back to this README (in ${srcDir}) and follow "Generating your spreadsheet with Claude".`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
