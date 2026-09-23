/* 💉 The screen colour picker page (V0.3.4.108). The main process took a
 * snapshot of the display the pointer is on and opened this window over it,
 * edge to edge. The snapshot is drawn here; the pointer samples it; a click
 * answers with the hex, Esc (or a right-click) with nothing. Chromium's own
 * eyedropper only sees this app's window in Electron — this sees the screen. */
(async () => {
  const shot = document.getElementById('shot');
  const loupe = document.getElementById('loupe');
  const lc = document.getElementById('loupe-c');
  const tag = document.getElementById('tag');
  const tagSw = tag.querySelector('i'), tagTx = tag.querySelector('span');
  const api = window.sbsPick;
  let done = false;
  const finish = (hex) => { if (done) return; done = true; api.done(hex); };

  let src;
  try {
    const dataUrl = await api.image();
    if (!dataUrl) throw new Error('no snapshot');
    src = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = dataUrl; });
  } catch (e) { finish(null); return; }

  // the snapshot at native pixels (for sampling) …
  const nat = document.createElement('canvas');
  nat.width = src.naturalWidth; nat.height = src.naturalHeight;
  const ng = nat.getContext('2d', { willReadFrequently: true });
  ng.drawImage(src, 0, 0);
  // … and scaled to the window (for looking at)
  const fit = () => {
    shot.width = window.innerWidth * (window.devicePixelRatio || 1);
    shot.height = window.innerHeight * (window.devicePixelRatio || 1);
    const g = shot.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.drawImage(src, 0, 0, shot.width, shot.height);
  };
  fit();
  window.addEventListener('resize', fit);

  const hex = (r, g, b) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  const sampleAt = (cx, cy) => {
    const x = Math.max(0, Math.min(nat.width - 1, Math.round(cx / window.innerWidth * nat.width)));
    const y = Math.max(0, Math.min(nat.height - 1, Math.round(cy / window.innerHeight * nat.height)));
    const d = ng.getImageData(x, y, 1, 1).data;
    return { x, y, hex: hex(d[0], d[1], d[2]) };
  };
  const lg = lc.getContext('2d');
  window.addEventListener('mousemove', (e) => {
    const s = sampleAt(e.clientX, e.clientY);
    lg.clearRect(0, 0, 11, 11);
    lg.drawImage(nat, s.x - 5, s.y - 5, 11, 11, 0, 0, 11, 11);
    // the loupe IS the cursor: centred on the pointer, its crosshair on the sampled pixel
    const left = e.clientX - 66, top = e.clientY - 66;
    loupe.style.left = `${left}px`; loupe.style.top = `${top}px`; loupe.style.display = 'block';
    const tagTop = top + 138 + 28 > window.innerHeight ? top - 30 : top + 138;
    tag.style.left = `${Math.max(4, Math.min(window.innerWidth - 110, e.clientX - 40))}px`; tag.style.top = `${tagTop}px`; tag.style.display = 'block';
    tagSw.style.background = s.hex; tagTx.textContent = s.hex;
  });
  window.addEventListener('mousedown', (e) => {
    if (e.button === 0) finish(sampleAt(e.clientX, e.clientY).hex);
    else finish(null);
  });
  // the pointer may arrive from another display's picker window: sample right away
  window.addEventListener('mouseenter', (e) => window.dispatchEvent(new MouseEvent('mousemove', { clientX: e.clientX, clientY: e.clientY })));
  window.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(null); });
  // (no blur → cancel: with one picker window per display, moving to another display's window blurs this one)
})();
