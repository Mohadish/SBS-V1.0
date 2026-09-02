'use strict';
// End-to-end smoke: plain Hebrew -> nikud (ONNX) -> IPA (port) -> tokens ->
// Hebrew Kokoro model -> WAV. Pure Node, same modules Electron runs.
const path = require('path');
const fs = require('fs');
const g2p = require('../electron/hebrew-g2p.js');

const HE_DIR = path.join(__dirname, '..', 'kokoro-he');

(async () => {
  const nikud = new g2p.Nikud(
    path.join(HE_DIR, 'nikud', 'phonikud-1.0.onnx'),
    path.join(HE_DIR, 'nikud', 'tokenizer.json'),
  );

  const sentences = [
    'הכנס את הבורג לתוך החור העליון.',
    'ודא שהאטם יושב נכון לפני ההרכבה.',
    'סובב את הידית עם כיוון השעון.',
  ];

  // Stage 1+2: nikud + phonemize
  const rows = [];
  for (const s of sentences) {
    const t0 = Date.now();
    const voc = await nikud.addDiacritics(s);
    const ipa = g2p.phonemize(voc);
    console.log(`[g2p ${Date.now() - t0}ms] ${s}`);
    console.log(`   voc: ${voc}`);
    console.log(`   ipa: ${ipa}`);
    if (!ipa.trim()) throw new Error('empty IPA');
    rows.push(ipa);
  }

  // Stage 3: synth through kokoro-js against the local add-on
  const tx = require('@huggingface/transformers');
  tx.env.allowRemoteModels = false;
  tx.env.allowLocalModels = true;
  tx.env.localModelPath = path.join(__dirname, '..') + path.sep;
  const km = require('kokoro-js');
  const tts = await km.KokoroTTS.from_pretrained('kokoro-he', { dtype: 'fp32', device: 'cpu' });

  const voiceRaw = fs.readFileSync(path.join(HE_DIR, 'voices', 'he_shaul.bin'));
  const voice = new Float32Array(voiceRaw.buffer.slice(voiceRaw.byteOffset, voiceRaw.byteOffset + voiceRaw.byteLength));

  fs.mkdirSync(path.join(__dirname, '..', 'out-he-test'), { recursive: true });
  for (let i = 0; i < rows.length; i++) {
    const { input_ids } = tts.tokenizer(rows[i], { truncation: true });
    const n = input_ids.dims.at(-1);
    const off = 256 * Math.min(Math.max(n - 2, 0), 509);
    const style = voice.slice(off, off + 256);
    const t0 = Date.now();
    const { waveform } = await tts.model({
      input_ids,
      style: new tx.Tensor('float32', style, [1, 256]),
      speed: new tx.Tensor('float32', [1.0], [1]),
    });
    const audio = new tx.RawAudio(waveform.data, 24000);
    const out = path.join(__dirname, '..', 'out-he-test', `e2e_${i + 1}.wav`);
    fs.writeFileSync(out, Buffer.from(audio.toWav()));
    console.log(`[synth ${Date.now() - t0}ms] ${(waveform.data.length / 24000).toFixed(2)}s -> ${out}`);
  }
  console.log('\nE2E OK');
})().catch(e => { console.error('E2E FAILED:', e); process.exit(1); });
