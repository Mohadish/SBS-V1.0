'use strict';
/**
 * TEST-ONLY installer config: the standard build PLUS the Hebrew Kokoro
 * add-on (kokoro-he/ -> resources/kokoro-he).
 *
 * The Hebrew voice derives from SASPEECH ((c) IPBC) and is NON-COMMERCIAL.
 * An installer produced with this config must never be distributed to
 * customers - it exists solely to prove the Hebrew pipeline on the offline
 * test machine. The default `npm run build` remains clean: `kokoro-he/` is
 * outside build.files (asar whitelist) and outside build.extraResources.
 */
const base = require('./package.json').build;

module.exports = {
  ...base,
  extraResources: [
    ...(base.extraResources || []),
    { from: 'kokoro-he', to: 'kokoro-he', filter: ['**/*'] },
  ],
  // Mark the artifact unmistakably so it can't be confused with a release.
  artifactName: '${productName} Setup ${version} HEBREW-TEST.${ext}',
};
