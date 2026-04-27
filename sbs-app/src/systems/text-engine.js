/**
 * SBS — Text styling engine.
 * ──────────────────────────
 * One module that handles every text styling operation across the
 * overlay text boxes AND the project-level header items. The engine
 * is selection-aware OR root-wide: a Range narrows the operation to
 * a sub-tree; no Range means "operate on every text run inside the
 * root".
 *
 * The cardinal rule: NORMALISE ALWAYS. Every operation runs the
 * normaliser first (clean state in) and again after (clean state
 * out). That guarantees:
 *   • no legacy <u> / <s> / <strike> / <font> tags
 *   • no inline line-height declarations (the rasteriser's outer
 *     line-height:1.2 multiplier handles spacing from font-size)
 *   • no empty inline wrappers carrying stale font-size declarations
 *   • no zero-width-space / BOM litter
 *
 * Every text run that survives normalisation is wrapped in a <span>
 * carrying ONLY the inline styles we explicitly support:
 *   color · font-family · font-size · font-weight · font-style ·
 *   text-decoration · text-align (on block elements only)
 *
 * Public API
 * ──────────
 *   apply(root, range, action, value)
 *     root   — DOM element (the contenteditable, or a tmp parsed div)
 *     range  — Range object (from window.getSelection) OR null
 *              null  → operate on every text run under root
 *              live  → operate on text runs inside the range
 *              collapsed → set up a "next-typed character gets this style"
 *                          pending span at the caret (single-editor only)
 *     action — see ACTIONS below
 *     value  — depends on action
 *
 *   normalize(root)
 *     standalone — exposed so callers can clean up after their own
 *     mutations (e.g. paste).
 *
 *   ACTIONS = the supported set; call sites can introspect.
 *
 * Strikethrough was removed per spec — too many edge cases for the
 * value it added.
 */

export const ACTIONS = Object.freeze([
  'color',
  'fontFamily',
  'fontSize',
  'bold',
  'italic',
  'underline',
  'alignLeft',
  'alignCenter',
  'alignRight',
]);

const ALLOWED_TAGS = new Set(['DIV', 'P', 'BR', 'SPAN', 'B', 'I', 'STRONG', 'EM']);
const ZWSP = '​';

// ─── Public ─────────────────────────────────────────────────────────────────

/**
 * Apply a styling action to text under `root`, optionally narrowed by `range`.
 * Idempotent for any given (action, value) pair.
 */
export function apply(root, range, action, value) {
  if (!root || !ACTIONS.includes(action)) return;

  // Caret-only — set up a pending styled wrapper so the next typed
  // character picks up the style. Only meaningful in single-editor mode
  // (where there's a live selection); mass-mode callers pass null range.
  if (range && range.collapsed) {
    _applyAtCaret(root, range, action, value);
    return;
  }

  // Range or root-wide:
  //   • range present + non-collapsed → extract, transform, re-insert
  //   • range absent                 → transform root in place
  if (range) {
    _applyToRange(root, range, action, value);
  } else {
    normalize(root);
    _operate(root, action, value);
    normalize(root);
  }
}

/**
 * Normalise the styling tree inside `root`. Safe to call repeatedly.
 * No-op if root has no children.
 */
export function normalize(root) {
  if (!root || !root.querySelectorAll) return;

  // 1. Promote legacy <u> / <s> / <strike> / <font> to span style.
  //    underline / line-through both become text-decoration on the span;
  //    the toggle code only ever produces underline now (strike is
  //    dropped from the UI), but the conversion still handles legacy
  //    pasted content.
  root.querySelectorAll('u').forEach(el => _convertToSpanWithStyle(el, 'textDecoration', 'underline'));
  root.querySelectorAll('s,strike').forEach(el => _convertToSpanWithStyle(el, 'textDecoration', 'line-through'));
  root.querySelectorAll('font').forEach(_convertFontTag);

  // 2. Strip line-height everywhere — let the rasteriser's outer
  //    line-height:1.2 multiplier compute from the current font-size.
  if (root.style) root.style.lineHeight = '';
  root.querySelectorAll('[style]').forEach(el => { el.style.lineHeight = ''; });

  // 3. Remove zero-width-space and BOM litter from text nodes. They're
  //    invisible but can break shaping in the SVG renderer and pollute
  //    save files. Caret-style placeholders (empty span+ZWSP) are kept
  //    INTACT because they hold next-character styling for the user;
  //    only ZWSPs adjacent to real characters are normalised away.
  _stripStrayZwsp(root);

  // 4. Iteratively drop empty inline wrappers (carrying stale styles).
  //    Multiple passes — removing one might empty its parent; loop
  //    until stable. Capped at 8 passes for safety.
  for (let i = 0; i < 8; i++) {
    let changed = false;
    root.querySelectorAll('span,b,i,strong,em').forEach(el => {
      if (_isStaleEmpty(el)) {
        el.remove();
        changed = true;
      }
    });
    if (!changed) break;
  }

  // 5. Flatten redundant single-child span nesting:
  //      <span style="A"><span style="B">X</span></span>
  //    becomes
  //      <span style="A;B">X</span>
  //    when neither span has siblings to worry about. Avoids the
  //    "deeply nested wrappers" buildup over many edits.
  for (let i = 0; i < 8; i++) {
    let changed = false;
    root.querySelectorAll('span').forEach(el => {
      if (_tryFlattenSingleChild(el)) changed = true;
    });
    if (!changed) break;
  }

  // 6. Strip redundant ancestor property declarations.
  //    Per CSS cascade only the INNERMOST ancestor's declaration of a
  //    given property reaches the text. Outer declarations of the same
  //    property are dead weight — they don't affect rendering of THIS
  //    text run, but they DO inflate line-box layout (font-size on a
  //    parent contributes to the line height even when an inner span
  //    overrides it).
  //    For every text run, walk its ancestor chain. The innermost
  //    declaration of each property wins — strip the property from
  //    every outer ancestor.
  //    This is the layer that fixes "set size 40 → set size 20 → line
  //    height stays at 40": the outer wrapper's stale font-size:40 was
  //    surviving flatten when it had siblings, but it no longer needs
  //    to declare font-size at all because the inner span:20 fully
  //    covers the text inside it.
  _stripRedundantAncestorProps(root);
}

function _stripRedundantAncestorProps(root) {
  const TRACKED = ['color', 'font-family', 'font-size', 'font-weight', 'font-style'];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (!n.textContent.length) continue;
    const seen = new Set();
    let p = n.parentElement;
    while (p && p !== root) {
      if (p.style) {
        for (const prop of TRACKED) {
          const v = p.style.getPropertyValue(prop);
          if (!v) continue;
          if (seen.has(prop)) {
            p.style[prop] = '';     // outer ancestor — strip, inner already wins
          } else {
            seen.add(prop);          // first (= innermost) declaration — keep
          }
        }
      }
      p = p.parentElement;
    }
  }
}

/**
 * Walk up from the range's start container to root, collecting the
 * INNERMOST declaration of each tracked property. Returns an object
 * { color, fontFamily, fontSize, fontWeight, fontStyle, textDecoration }
 * with only the keys that have a value — used to wrap an extracted
 * fragment with the styling it would have inherited in the live doc.
 *
 * "Innermost wins" is consistent with CSS inheritance — and with how
 * _stripRedundantAncestorProps treats overlapping declarations during
 * normalisation, so the same wrapper is safe to add and let normalize
 * clean up.
 */
function _captureInheritedStyles(root, range) {
  const TRACKED = ['color', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'textDecoration'];
  const out = {};
  let p = range.startContainer;
  if (p && p.nodeType === 3) p = p.parentElement;
  while (p && p !== root) {
    if (p.style) {
      for (const prop of TRACKED) {
        const v = p.style[prop];
        if (v && !out[prop]) out[prop] = v;
      }
    }
    p = p.parentElement;
  }
  return out;
}

// ─── Range / caret paths ───────────────────────────────────────────────────

function _applyToRange(root, range, action, value) {
  // Extract → transform in a sandbox → re-insert. This guarantees
  // changes don't fight with the live document while we work.
  //
  // Subtle: extractContents() can LOSE ancestor styles. For a partial
  // range inside a single styled span (e.g. selecting "world" inside
  //   <span style="text-decoration:underline">Hello world</span>)
  // the fragment ends up as a bare text node "world" — the underline
  // lived on the parent span which stays in the live doc. The toggle
  // engine then sees a text run with NO underline ancestor, thinks
  // "not underlined", and ADDS underline instead of removing it.
  //
  // Fix: capture inherited styles at the range boundary BEFORE
  // extraction and wrap the extracted fragment with a span carrying
  // them. The engine now sees the full styling and toggles correctly.
  // Normalize's _stripRedundantAncestorProps cleans up any redundant
  // wrappers afterward.
  const sel = window.getSelection();
  const inherited = _captureInheritedStyles(root, range);
  const fragment = range.extractContents();
  const tmp = document.createElement('div');
  tmp.appendChild(fragment);
  if (Object.keys(inherited).length) {
    const wrap = document.createElement('span');
    for (const [prop, val] of Object.entries(inherited)) wrap.style[prop] = val;
    while (tmp.firstChild) wrap.appendChild(tmp.firstChild);
    tmp.appendChild(wrap);
  }

  normalize(tmp);
  _operate(tmp, action, value);
  normalize(tmp);

  // Re-insert and track first/last for selection restore.
  const frag = document.createDocumentFragment();
  let firstInserted = null, lastInserted = null;
  while (tmp.firstChild) {
    if (!firstInserted) firstInserted = tmp.firstChild;
    lastInserted = tmp.firstChild;
    frag.appendChild(tmp.firstChild);
  }
  range.insertNode(frag);

  // Normalise the surrounding block too — extractContents may have
  // emptied the original style wrappers and left them as siblings.
  let block = lastInserted || firstInserted;
  while (block && block.parentElement && !/^(DIV|P|BODY)$/.test(block.tagName || '')) {
    block = block.parentElement;
  }
  if (block && block.querySelectorAll) normalize(block);

  // Restore selection over the re-inserted content (after normalisation
  // — first/last may have moved/merged, but DOM-position references
  // survive flattening).
  if (firstInserted && lastInserted && firstInserted.isConnected && lastInserted.isConnected) {
    const newRange = document.createRange();
    newRange.setStartBefore(firstInserted);
    newRange.setEndAfter(lastInserted);
    sel.removeAllRanges();
    sel.addRange(newRange);
  }
}

function _applyAtCaret(root, range, action, value) {
  // Block-level actions just operate on the line, not the caret.
  if (action === 'alignLeft' || action === 'alignCenter' || action === 'alignRight') {
    const align = _alignValue(action);
    let line = range.startContainer;
    if (line && line.nodeType === 3) line = line.parentElement;
    while (line && !/^(DIV|P)$/.test(line.tagName || '')) line = line.parentElement;
    if (line) line.style.textAlign = align;
    return;
  }

  // Inline actions — drop a styled span at the caret with a ZWSP placeholder.
  // Next-typed character lands inside it and inherits the span's style.
  //
  // Toggle-aware: detect ancestor styles at the caret. For B/I, if the
  // caret is in an already-bold/italic context, the toolbar press is a
  // toggle-OFF — write the INVERTED value (font-weight:normal etc.) so
  // the next typed character is NOT bold/italic, even though it sits
  // inside the bolded ancestor. Without this the press silently stacks
  // another bold span on top — visually invisible, breaks toggle UX.
  //
  // Underline has a CSS quirk: text-decoration on a descendant CAN'T
  // remove a parent's underline (the parent's decoration paints across
  // descendants regardless). At a collapsed caret inside an underlined
  // ancestor, "untoggle" isn't really achievable without restructuring
  // the document. We still write 'none' on the new span — better
  // semantically — but the user may have to select text and toggle to
  // visually remove underline.
  const ancestorStyles = _captureInheritedStyles(root, range);
  const span = document.createElement('span');
  _writeInlineStyleAtCaret(span, action, value, ancestorStyles);
  const tn = document.createTextNode(ZWSP);
  span.appendChild(tn);
  range.insertNode(span);
  range.setStart(tn, 1);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * Caret-flavour of _writeInlineStyle: for toggle props (B/I/underline),
 * inverts the ancestor value. For value-set props (color / font / size),
 * writes the new value verbatim — those override via cascade regardless
 * of ancestor.
 */
function _writeInlineStyleAtCaret(span, action, value, ancestor) {
  switch (action) {
    case 'color':       span.style.color           = String(value);          break;
    case 'fontFamily':  span.style.fontFamily      = String(value);          break;
    case 'fontSize':    span.style.fontSize        = `${Number(value)}px`;   break;
    case 'bold':
      span.style.fontWeight = ancestor?.fontWeight === 'bold' ? 'normal' : 'bold';
      break;
    case 'italic':
      span.style.fontStyle  = ancestor?.fontStyle === 'italic' ? 'normal' : 'italic';
      break;
    case 'underline': {
      const has = String(ancestor?.textDecoration || '').includes('underline');
      span.style.textDecoration = has ? 'none' : 'underline';
      break;
    }
  }
}

// ─── Operation dispatch ────────────────────────────────────────────────────

function _operate(root, action, value) {
  switch (action) {
    case 'color':      _setProp(root, 'color',       String(value));       break;
    case 'fontFamily': _setProp(root, 'fontFamily',  String(value));       break;
    case 'fontSize':   _setProp(root, 'fontSize',    `${Number(value)}px`); break;
    case 'bold':       _toggleProp(root, 'fontWeight', 'bold');             break;
    case 'italic':     _toggleProp(root, 'fontStyle',  'italic');           break;
    case 'underline':  _toggleDecoration(root, 'underline');                break;
    case 'alignLeft':
    case 'alignCenter':
    case 'alignRight': _setAlignment(root, _alignValue(action));            break;
  }
}

// ─── Operation primitives ──────────────────────────────────────────────────

/** Strip property from every descendant, then wrap each text run with the new value. */
function _setProp(root, prop, value) {
  root.querySelectorAll('[style]').forEach(el => { el.style[prop] = ''; });
  _wrapTextRuns(root, (span) => { span.style[prop] = value; });
}

/** Toggle: if every text run has prop=value, strip it everywhere; else apply uniformly. */
function _toggleProp(root, prop, onValue) {
  const all = _everyTextRunHasProp(root, prop, onValue);
  root.querySelectorAll('[style]').forEach(el => { el.style[prop] = ''; });
  if (!all) {
    _wrapTextRuns(root, (span) => { span.style[prop] = onValue; });
  }
}

/** Toggle: if every text run already has the decoration, strip it; else apply. */
function _toggleDecoration(root, decoration) {
  const all = _everyTextRunHasDecoration(root, decoration);
  if (all) {
    root.querySelectorAll('[style]').forEach(el => {
      el.style.textDecoration = _removeFromList(el.style.textDecoration, decoration);
    });
  } else {
    _wrapTextRuns(root, (span) => {
      const list = String(span.style.textDecoration || '').split(/\s+/).filter(Boolean);
      if (!list.includes(decoration)) list.push(decoration);
      span.style.textDecoration = list.join(' ');
    });
  }
}

/** Set text-align on each containing line block under root. */
function _setAlignment(root, align) {
  // Find every text node, walk up to its line block, set text-align there.
  const blocks = new Set();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    let p = n.parentElement;
    while (p && p !== root && !/^(DIV|P)$/.test(p.tagName || '')) p = p.parentElement;
    if (p && p !== root) blocks.add(p);
  }
  if (blocks.size === 0) {
    // No block ancestors inside root — wrap the whole content in a div.
    const wrap = document.createElement('div');
    wrap.style.textAlign = align;
    while (root.firstChild) wrap.appendChild(root.firstChild);
    root.appendChild(wrap);
  } else {
    blocks.forEach(b => { b.style.textAlign = align; });
  }
}

// ─── Walking + detection ───────────────────────────────────────────────────

function _wrapTextRuns(root, applyFn) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) if (n.textContent.length) nodes.push(n);
  for (const tn of nodes) {
    const span = document.createElement('span');
    applyFn(span);
    tn.parentNode.insertBefore(span, tn);
    span.appendChild(tn);
  }
}

function _everyTextRunHasProp(root, prop, onValue) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (!n.textContent.trim()) continue;
    let p = n.parentElement;
    let found = false;
    while (p && p !== root) {
      if (p.style?.[prop] === onValue) { found = true; break; }
      p = p.parentElement;
    }
    if (!found) return false;
  }
  return true;
}

function _everyTextRunHasDecoration(root, decoration) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (!n.textContent.trim()) continue;
    let p = n.parentElement;
    let found = false;
    while (p && p !== root) {
      const td = String(p.style?.textDecoration || '');
      if (td.split(/\s+/).includes(decoration)) { found = true; break; }
      p = p.parentElement;
    }
    if (!found) return false;
  }
  return true;
}

// ─── Normalise helpers ─────────────────────────────────────────────────────

function _convertToSpanWithStyle(el, prop, value) {
  const span = document.createElement('span');
  // Preserve any preexisting inline styles on the legacy tag.
  if (el.getAttribute('style')) span.setAttribute('style', el.getAttribute('style'));
  span.style[prop] = value;
  while (el.firstChild) span.appendChild(el.firstChild);
  el.replaceWith(span);
}

const FONT_SIZE_PX = { 1: 10, 2: 12, 3: 16, 4: 18, 5: 24, 6: 32, 7: 48 };
function _convertFontTag(f) {
  const span = document.createElement('span');
  if (f.getAttribute('color')) span.style.color = f.getAttribute('color');
  if (f.getAttribute('face'))  span.style.fontFamily = f.getAttribute('face');
  const sz = f.getAttribute('size');
  if (sz && FONT_SIZE_PX[sz]) span.style.fontSize = `${FONT_SIZE_PX[sz]}px`;
  while (f.firstChild) span.appendChild(f.firstChild);
  f.replaceWith(span);
}

function _isStaleEmpty(el) {
  // Carrier for nothing visible — drop it so its stale style declarations
  // can't keep affecting line-box layout.
  if (el.querySelector('br,img,svg,canvas,input')) return false;
  const txt = (el.textContent || '').replace(/[​﻿\s]+/g, '');
  return txt === '';
}

function _tryFlattenSingleChild(el) {
  // Only flatten if THIS span has exactly one element child and that
  // child is a span with no text-only siblings — merging styles is safe.
  if (el.childNodes.length !== 1) return false;
  const child = el.firstChild;
  if (child.nodeType !== 1 || child.tagName !== 'SPAN') return false;
  // Merge child's styles into el (el wins on conflicts — outer is "older").
  // Actually inner usually wins per CSS cascade — let's preserve that:
  // copy inner styles last so they overwrite outer.
  const merged = {};
  for (const e of [el, child]) {
    if (!e.style) continue;
    for (let i = 0; i < e.style.length; i++) {
      const prop = e.style[i];
      merged[prop] = e.style.getPropertyValue(prop);
    }
  }
  // Replace el's children with child's children; rewrite styles.
  while (el.firstChild) el.removeChild(el.firstChild);
  while (child.firstChild) el.appendChild(child.firstChild);
  // Clear el's existing inline style, then apply merged.
  el.removeAttribute('style');
  for (const [k, v] of Object.entries(merged)) {
    if (v) el.style.setProperty(k, v);
  }
  return true;
}

function _stripStrayZwsp(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets = [];
  let n;
  while ((n = walker.nextNode())) {
    if (!n.textContent.includes(ZWSP) && !n.textContent.includes('﻿')) continue;
    // Keep the ZWSP if it's the ONLY content — that's a caret-style placeholder.
    if (n.textContent === ZWSP || n.textContent === '﻿') continue;
    targets.push(n);
  }
  for (const tn of targets) {
    tn.textContent = tn.textContent.replace(/[​﻿]+/g, '');
  }
}

// ─── Tiny utilities ────────────────────────────────────────────────────────

function _writeInlineStyle(span, action, value) {
  switch (action) {
    case 'color':      span.style.color           = String(value);          break;
    case 'fontFamily': span.style.fontFamily      = String(value);          break;
    case 'fontSize':   span.style.fontSize        = `${Number(value)}px`;   break;
    case 'bold':       span.style.fontWeight      = 'bold';                 break;
    case 'italic':     span.style.fontStyle       = 'italic';               break;
    case 'underline':  span.style.textDecoration  = 'underline';            break;
  }
}

function _alignValue(action) {
  return action === 'alignLeft'   ? 'left'
       : action === 'alignRight'  ? 'right'
                                  : 'center';
}

function _removeFromList(s, value) {
  return String(s || '').split(/\s+/).filter(t => t && t !== value).join(' ');
}
