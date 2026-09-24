/* The screen colour picker page (V0.3.4.108). The main process took a
 * snapshot of this window's display and shows this window over it, edge to
 * edge. The snapshot is drawn here; the pointer samples it; a click answers
 * with the hex, Esc (or a right-click) with nothing. Chromium's own
 * eyedropper only sees this app's window in Electron — this sees the screen.
 *
 * V0.3.4.117 — the window is POOLED: it lives hidden between picks. Each pick
 * is a session ('session' → ask for the snapshot, draw it, report 'drawn' so
 * main shows the window; 'end' → forget the snapshot). The snapshot arrives
 * as raw RGBA straight into a canvas (no PNG round trip). */
(() => {
  const shot = document.getElementById('shot');
  const loupe = document.getElementById('loupe');
  const lc = document.getElementById('loupe-c');
  const tag = document.getElementById('tag');
  const tagSw = tag.querySelector('i'), tagTx = tag.querySelector('span');
  const api = window.sbsPick;

  // the snapshot at native pixels (for sampling) …
  const nat = document.createElement('canvas');
  const ng = nat.getContext('2d', { willReadFrequently: true });
  let active = false;   // a session is on and this display has its snapshot
  let done = false;     // this session answered already
  const finish = (hex) => { if (!active || done) return; done = true; api.done(hex); };

  // … and scaled to the window (for looking at)
  const fit = () => {
    shot.width = window.innerWidth * (window.devicePixelRatio || 1);
    shot.height = window.innerHeight * (window.devicePixelRatio || 1);
    const g = shot.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.drawImage(nat, 0, 0, shot.width, shot.height);
  };
  window.addEventListener('resize', () => { if (active) fit(); });

  const hex = (r, g, b) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  const sampleAt = (cx, cy) => {
    const x = Math.max(0, Math.min(nat.width - 1, Math.round(cx / window.innerWidth * nat.width)));
    const y = Math.max(0, Math.min(nat.height - 1, Math.round(cy / window.innerHeight * nat.height)));
    const d = ng.getImageData(x, y, 1, 1).data;
    return { x, y, hex: hex(d[0], d[1], d[2]) };
  };
  const lg = lc.getContext('2d');
  window.addEventListener('mousemove', (e) => {
    if (!active) return;
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
    if (!active) return;
    if (e.button === 0) finish(sampleAt(e.clientX, e.clientY).hex);
    else finish(null);
  });
  // the pointer may arrive from another display's picker window: sample right away, and take the keyboard (Esc)
  window.addEventListener('mouseenter', (e) => {
    if (!active) return;
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: e.clientX, clientY: e.clientY }));
    api.focus();
  });
  window.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(null); });
  // (no blur → cancel: with one picker window per display, moving to another display's window blurs this one)

  const hide = () => { loupe.style.display = 'none'; tag.style.display = 'none'; };

  // a pick begins: the snapshot (main answers when the capture is in) → draw → 'drawn' → main shows us
  const session = async () => {
    done = false;
    let shotData = null;
    try { shotData = await api.image(); } catch {}
    if (!shotData || !shotData.width || !shotData.height || !shotData.rgba) return;   // no snapshot for this display this time: stay hidden
    const { width, height, rgba } = shotData;
    try {
      nat.width = width; nat.height = height;
      const px = rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
      ng.putImageData(new ImageData(px, width, height), 0, 0);
    } catch (e) { console.warn('[pick] snapshot draw failed:', e?.message); return; }
    hide();
    active = true;
    fit();
    // straight away, not on requestAnimationFrame: this window is HIDDEN until
    // main shows it, and a hidden page gets no animation frames (the report
    // would never come — seen in the probe on the second session)
    api.drawn();
  };
  // the pick is over: forget the snapshot (the window stays, hidden, for the next one)
  const end = () => {
    active = false; done = false;
    hide();
    nat.width = nat.height = 1;
    shot.width = shot.height = 1;
  };
  api.onSession(session);
  api.onEnd(end);
})();
