'use strict';
// Parity gate: the JS port must reproduce Python phonikud byte-for-byte on
// every fixture. Run: node scripts/test-hebrew-g2p.js
const { phonemize } = require('../electron/hebrew-g2p.js');
const fixtures = require('./hebrew-g2p-fixtures.json');

let pass = 0, fail = 0;
for (const { text, ipa } of fixtures) {
  const got = phonemize(text);
  if (got === ipa) { pass++; continue; }
  fail++;
  console.log('TEXT :', text);
  console.log('  py :', JSON.stringify(ipa));
  console.log('  js :', JSON.stringify(got));
}
console.log(`\n${pass}/${fixtures.length} identical`);
// ---- Nikud-tokenizer parity: JS _tokenize must emit the same input_ids as
// the Python `tokenizers` library on the same tokenizer.json (review finding:
// the dictabert Replace->[UNK] normalizers are behavioural, not cosmetic).
const path = require('path');
const { Nikud } = require('../electron/hebrew-g2p.js');
const tokFixtures = require('./hebrew-nikud-tokenizer-fixtures.json');
const nik = new Nikud(
  path.join(__dirname, '..', 'kokoro-he', 'nikud', 'phonikud-1.0.onnx'),
  path.join(__dirname, '..', 'kokoro-he', 'nikud', 'tokenizer.json'),
);
let tPass = 0, tFail = 0;
for (const { text, ids } of tokFixtures) {
  const got = nik._tokenize(text).ids;
  if (JSON.stringify(got) === JSON.stringify(ids)) { tPass++; continue; }
  tFail++;
  console.log('TOK TEXT:', JSON.stringify(text));
  console.log('  py:', JSON.stringify(ids));
  console.log('  js:', JSON.stringify(got));
}
console.log(tPass + '/' + tokFixtures.length + ' tokenizer identical');
process.exit((fail || tFail) ? 1 : 0);
