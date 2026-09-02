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
process.exit(fail ? 1 : 0);
