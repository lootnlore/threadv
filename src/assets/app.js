// ThreadVet calculator controller. Progressive enhancement: the page ships
// with server-rendered default results; this script makes them live.
//
// Where state lives:
// - Saved settings (fine-tune fees + marketplaces) are in localStorage and
//   change only when the user edits them outside a shared link.
// - The address bar fragment (#price=40...) holds the current main numbers,
//   so a reload or bookmark comes back to the same result. Browsers never
//   send the fragment to the server, so typed numbers stay on the device.
// - "Copy link" builds a complete shared link marked with `s=1`: everything
//   that differs from the defaults. Opening one shows exactly that result and
//   never reads or writes the visitor's saved settings.
import { DEFAULTS, normalizeInputs, inputsUsedBy, inputProblem, stillTyping, onItsWay, withDecimalPoint, PRICE_NEEDED, has } from '../engine/calc.mjs';
import { renderOutput, builtOutput, esc, MODES } from '../engine/render.mjs';
import { PLATFORMS, PLATFORM_BY_ID } from '../engine/fees.mjs';

const STORE_KEY = 'threadvet:settings:v2';
const SHARE_FLAG = 's';
const MAIN_KEYS = ['price', 'cost', 'ship', 'label', 'target'];
const TUNE_KEYS = ['taxRate', 'other', ...PLATFORMS.flatMap((p) => p.options ?? [])]; // each marketplace declares its own
const NUMERIC = [...MAIN_KEYS, ...TUNE_KEYS].filter((key) => typeof DEFAULTS[key] === 'number');
const LINK_KEYS = [SHARE_FLAG, 'mode', ...MAIN_KEYS];
const ALL_IDS = PLATFORMS.map((p) => p.id);
// Where a Ctrl-click is a right click (iPadOS with a trackpad says it's one
// too). A mousedown must know before any contextmenu event says so.
const MAC = /^Mac/.test(navigator.platform);

const storage = {
  read() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY)) ?? {};
    } catch {
      return {};
    }
  },
  write(value) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(value));
    } catch {
      /* private mode or storage full: settings just won't persist */
    }
  },
  clear() {
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {
      /* ignore */
    }
  },
};

function debounce(fn, ms) {
  let t;
  let due = null; // the arguments of the call still to come
  const call = (...args) => {
    clearTimeout(t);
    due = args;
    t = setTimeout(call.flush, ms);
  };
  call.cancel = () => {
    clearTimeout(t);
    due = null;
  };
  call.flush = () => {
    const args = due;
    call.cancel();
    if (args) fn(...args);
  };
  return call;
}

function setup(root) {
  const form = root.querySelector('form');
  const panel = root.querySelector('[role="tabpanel"]');
  const tabs = [...root.querySelectorAll('[role="tab"]')];
  const tabFor = (m) => tabs.find((tab) => tab.dataset.mode === m);
  const hint = root.querySelector('[data-hint]');
  const verdictEl = root.querySelector('[data-verdict]');
  const verdictLive = root.querySelector('[data-verdict-live]');
  const resultsEl = root.querySelector('[data-results]');
  const shareBtn = root.querySelector('[data-share]');
  const shareStatus = root.querySelector('[data-share-status]');
  const resetBtn = root.querySelector('[data-reset]');
  const sharedNote = root.querySelector('[data-shared-note]');
  const seeResults = root.querySelector('.see-results');
  const focus = root.dataset.focus || undefined;
  const field = (name) => form.elements.namedItem(name);
  const fieldBox = (name) => root.querySelector(`[data-field="${name}"]`);
  const hintFor = (name) => root.querySelector(`#h-${name} [data-live]`); // the text on show; the rest only keep room for it
  for (const key of NUMERIC) {
    const h = hintFor(key);
    if (h) h.dataset.default = h.textContent;
  }
  let mode = 'profit';
  let sharedView = false;
  let pendingField = null; // what to fix before results can show
  let reveal = false; // open Fine-tune for bad values a link brought in (set by load, done by the next draw)
  let drawnMode = null; // the mode the tabs and fields show
  let rendered = null; // the form as last judged: what the address bar holds
  let paintedFrom = null; // what the output on screen was worked out from: the prompt, or the result's numbers (see paint)
  // Its parts as drawn, { verdict, list } (the list alone, hidden, under a
  // prompt), or null for what the page was built with (see builtOutput):
  // a first paint of that draws nothing.
  let painted = null;
  let shown = null; // what it shows, or will once no press holds its drawing
  let dirty = ''; // the text field typed into since the last judged render
  let loadedEarly = {}; // what the settings changed before the script ran would have been (see load)
  const canShare = typeof navigator.share === 'function';
  const shareSupported = Boolean(navigator.clipboard) || canShare;

  // ---- state in/out of the form ----

  function setValue(name, value) {
    const el = field(name);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = value === true || value === 'true';
    else if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === String(value))) el.value = DEFAULTS[name];
    else el.value = String(value);
  }

  function setPlatforms(ids, keep = []) {
    for (const box of form.querySelectorAll('input[name="platform"]')) if (!keep.includes(box)) box.checked = ids.includes(box.value);
  }

  // A comma read as the decimal point, shown as one where a value is taken
  // in (left, Enter, a link): "2,50" becomes "2.50", so a slip meant as 250
  // can't pass unseen. Never while the field is still being typed in.
  const caretOf = (el) => [el.selectionStart, el.selectionEnd, el.selectionDirection]; // for setSelectionRange
  function showPoint(el) {
    const text = withDecimalPoint(el.name, el.value);
    if (text === el.value) return;
    const caret = caretOf(el);
    el.value = text; // the same length: one comma became a point
    if (document.activeElement === el) el.setSelectionRange(...caret); // the caret (or selection) stays as it was
  }

  /** The form's values; `standIn` gives some in place of what their fields hold (see render). */
  function readForm(standIn = {}) {
    const data = new FormData(form);
    const values = {};
    // A setting with no field on the page (say, a new option declared before its
    // field is added) keeps its default rather than reading as empty (0%). A
    // comma read as the decimal point is a point here, so a link, saved
    // settings and the result don't depend on which one was typed.
    for (const key of [...MAIN_KEYS, ...TUNE_KEYS]) {
      const raw = has(standIn, key) ? standIn[key] : field(key) ? (data.get(key) ?? '') : DEFAULTS[key];
      values[key] = NUMERIC.includes(key) ? withDecimalPoint(key, raw) : raw;
    }
    values.depopBoost = data.has('depopBoost');
    return { values, platforms: data.getAll('platform') };
  }

  const linkParams = () => new URLSearchParams(location.hash.slice(1));

  /**
   * Fills the form from the link, else saved settings, else the defaults.
   * `kept`: controls the visitor changed before the script ran (a browser
   * that paints first lets them start), which keep what they show. Returns
   * what each kept setting would have been, by name.
   */
  function load(kept = []) {
    reveal = true;
    dirty = ''; // whatever was being typed is replaced
    const params = linkParams();
    sharedView = params.has(SHARE_FLAG);
    const saved = sharedView ? {} : storage.read();
    const tune = sharedView ? Object.fromEntries(params) : (saved.values ?? {});
    const loaded = {};
    const fill = (key, value) => (kept.includes(field(key)) ? (loaded[key] = value) : setValue(key, value));
    for (const key of MAIN_KEYS) fill(key, params.has(key) ? params.get(key) : DEFAULTS[key]);
    for (const key of TUNE_KEYS) fill(key, has(tune, key) ? tune[key] : DEFAULTS[key]);
    for (const key of NUMERIC) if (field(key) && field(key) !== document.activeElement) showPoint(field(key)); // (never the one being typed in)
    if (sharedView) {
      setPlatforms(params.get('platforms')?.split(',') ?? ALL_IDS, kept);
    } else {
      // Saved as the marketplaces the user turned OFF, so ones added later show up.
      const hidden = Array.isArray(saved.hidden) ? saved.hidden : [];
      setPlatforms(ALL_IDS.filter((id) => !hidden.includes(id)), kept);
    }
    const m = params.get('mode');
    mode = m && has(MODES, m) ? m : 'profit';
    return loaded;
  }

  // Only what the user changed is stored, so when a default fee rate is
  // updated for a marketplace change, returning visitors get the new rate.
  function persist({ values, platforms }) {
    const tune = {};
    for (const key of TUNE_KEYS) {
      if (String(values[key]) !== String(DEFAULTS[key])) tune[key] = values[key];
    }
    storage.write({ values: tune, hidden: ALL_IDS.filter((id) => !platforms.includes(id)) });
  }

  /**
   * Fragment for the current form. A shared link spells out every value, so
   * it keeps meaning the same thing even after a default fee rate changes.
   * The visitor's own address bar holds just the main numbers (settings come
   * from storage), and stays clean while everything is at its default.
   */
  function fragment({ values, platforms }, shared) {
    const keys = shared ? [...MAIN_KEYS, ...TUNE_KEYS] : MAIN_KEYS;
    const changed = mode !== 'profit' || keys.some((key) => String(values[key]) !== String(DEFAULTS[key]));
    if (!shared && !changed) return '';
    const params = new URLSearchParams();
    if (shared) params.set(SHARE_FLAG, '1');
    params.set('mode', mode);
    for (const key of keys) params.set(key, String(values[key]));
    if (shared) params.set('platforms', platforms.join(','));
    return `#${params.toString()}`;
  }

  // Writes the form as last rendered, so it never holds a half-typed value
  // (see render) and a delayed call never writes an older one.
  let urlRetry = 0;
  function syncUrl() {
    clearTimeout(urlRetry);
    try {
      history.replaceState(null, '', `${location.pathname}${location.search}${fragment(rendered, sharedView)}`);
    } catch {
      urlRetry = setTimeout(syncUrl, 2000); // too many in a row (Safari limits them): again once they've calmed
    }
  }
  const syncUrlSoon = debounce(syncUrl, 250);

  // ---- rendering ----

  const labelOf = (key) => root.querySelector(`label[for="f-${key}"]`)?.firstChild?.textContent.trim() || key;

  const show = (el, on) => el.hidden === on && (el.hidden = !on); // written only when it changes
  const visible = (el) => el.checkVisibility?.() ?? el.getClientRects().length > 0;
  /** The text field `el` is the label, border, sign or hint of (not its box), if any. */
  const besideField = (el) => {
    const input = el.closest?.('.field')?.querySelector('input[type="text"]');
    return input && el !== input ? input : null;
  };
  /**
   * Focus where it was before a draw, if the draw hid or replaced what had
   * it (the list redrawn, the prompt in its place, a field or the shared
   * note hidden), rather than dropped to the page: the same row in the new
   * list, else the verdict for anything in the results column, else the
   * nearest control before it in the form that takes focus. Run once the
   * draw is done, so the verdict focused is the new one (and isn't then
   * read out again). A draw never runs while a press holds it: this may
   * scroll.
   */
  function keepFocus(had) {
    if (!had || had === document.body || (had.isConnected && !had.closest('[hidden]'))) return;
    const row = had.closest('.result')?.dataset.id; // (closest() works in a list since replaced)
    const summary = row && resultsEl.querySelector(`[data-id="${row}"] summary`);
    if (summary && visible(summary)) {
      summary.focus({ preventScroll: true });
      return summary.scrollIntoView({ block: 'nearest' }); // its new place may be off screen
    }
    if (!had.isConnected || had.closest('.calc-output')) return focusVerdict();
    const before = [...root.querySelectorAll('.calc-input :is(a[href], button, input, select, summary)')].filter((c) => c.compareDocumentPosition(had) & Node.DOCUMENT_POSITION_FOLLOWING);
    for (const c of before.reverse()) {
      if (c.tabIndex < 0 || c.disabled || !visible(c)) continue;
      c.focus();
      if (document.activeElement === c) return; // (one inside a closed panel can refuse it)
    }
  }
  /** Whether a field is on show in mode `m` (its box hidden otherwise, once drawn). */
  const onShow = (key, m, input) =>
    !MODES[m].hidden.includes(key) && (key !== 'ebayCustomRate' || PLATFORM_BY_ID.ebay.usesOption('ebayCustomRate', input.opts));
  /**
   * Each numeric field on the page, [{ key, problem, missing, blocks, needed }]:
   * `problem` says what is wrong with its value; `needed` marks a sell price
   * the mode needs, and `missing` one that isn't typed yet (neutral: not an
   * error yet).
   * `blocks`: either one holds the results back, because the compared
   * marketplaces read the field in this mode (inputsUsedBy) and it is on show.
   */
  function check(values, ids, input) {
    const used = new Set(ids.flatMap((id) => inputsUsedBy(PLATFORM_BY_ID[id], mode, input)));
    return NUMERIC.filter((key) => field(key)).map((key) => {
      const needed = key === 'price' && used.has('price');
      const problem = inputProblem(key, values[key], { sellPrice: needed });
      const missing = !problem && needed && String(values.price).trim() === '';
      const blocks = Boolean(problem || missing) && used.has(key) && onShow(key, mode, input);
      return { key, problem, missing, blocks, needed };
    });
  }

  const flagged = new Set(); // fields last judged wrong (an error, or "needed"): their hints say so once drawn
  /** Marks each field with what is wrong; its hint says it. */
  function flag(checks) {
    for (const { key, problem, missing } of checks) {
      const el = field(key);
      if (problem) el.setAttribute('aria-invalid', 'true');
      else el.removeAttribute('aria-invalid');
      el.closest('.input-wrap')?.classList.toggle('is-invalid', Boolean(problem));
      const h = hintFor(key);
      if (!h) continue;
      // A hint says what's true of its field as last judged (a value still
      // being typed isn't: see render). Its words are only replaced when that
      // changes, so words selected in it (to copy an error, say) stay
      // selected while it does not.
      const text = problem || (missing ? PRICE_NEEDED : h.dataset.default);
      if (h.textContent !== text) h.textContent = text;
      h.classList.toggle('hint-error', Boolean(problem));
    }
  }

  const openIds = () => [...resultsEl.querySelectorAll('details[open]')].map((d) => d.closest('.result').dataset.id);

  /**
   * While the numbers can't be worked out, the verdict asks for what's
   * missing, in a neutral tone, and the results (and the link to share them)
   * go: rows for other numbers would mislead. The list is hidden, not
   * emptied, so breakdowns left open are open again when it comes back.
   */
  function showPending(html) {
    verdictEl.className = 'verdict verdict-wait';
    verdictEl.innerHTML = `<span>${html}</span>`;
    show(resultsEl, false);
    show(shareBtn, false);
  }

  function showVerdict({ tone, verdict }) {
    verdictEl.className = `verdict verdict-${tone}`;
    verdictEl.innerHTML = verdict;
  }
  /** The list, its rows open as they were. */
  function showList(list) {
    const open = openIds();
    resultsEl.innerHTML = list;
    for (const id of open) resultsEl.querySelector(`[data-id="${id}"] details`)?.setAttribute('open', '');
  }

  /** What to ask for instead of results, as [html, field to fix], or null when they can be worked out. */
  function pendingFor(ids, blocking) {
    if (ids.length === 0) return ['<strong>No marketplaces selected.</strong> Pick at least one under “Fine-tune fees”.', form.querySelector('input[name="platform"]')];
    const bad = blocking.filter((b) => b.problem);
    const named = (b) => `“${esc(labelOf(b.key))}”`;
    if (bad.length === 1) return [`<strong>Check ${named(bad[0])}.</strong> ${esc(bad[0].problem)}`, field(bad[0].key)];
    if (bad.length) return [`<strong>Check ${bad.length} fields.</strong> ${bad.map((b) => `${named(b)}: ${esc(b.problem)}`).join(' ')}`, field(bad[0].key)];
    if (blocking.length) return ['<strong>Enter a sell price</strong> to see results.', field('price')]; // only a price not typed yet
    return null;
  }

  // ---- presses ----
  // A click lands where it was pressed only if nothing moves in between, and
  // words a press selected (to copy, say) stay selected only if they stay.
  // So render works out the numbers, judges and saves at once, but what it
  // draws (flags and hints, the mode's fields, the results) waits while a
  // press that could see it is down, and so do moves of the view (Go's jump
  // to the verdict, a tab an arrow focused scrolling into view). Drawn, the
  // results are repainted only if they changed (see paint), so words
  // selected in them stay until they're no longer true.
  // A finger's or pen's press holds them all: until it lifts, focus stays
  // where it was (unless it's a long press, which takes it), and keys typed
  // with the other hand (a digit, Next, Go) reach the page. A mouse's holds
  // them off the form side, on a hint, or once a drag reaches either: a
  // render changes nothing else on the form side (a test checks), and a key
  // ends a mouse's press (below). Renders a press's own click makes (a tab,
  // a checkbox) come once it's over, and draw at once.
  //
  // A press (any button, a finger, a pen; each finger its own) is over at
  // the click it makes, 250ms after a release that makes none (a long
  // press's, a right click's), when it's cancelled, or when a release the
  // page never heard of shows: its pointer moving with no button down before
  // any release (a hovering mouse) or pressing again; for a finger or pen
  // (which send a stream of moves while down), 3s without a word from it;
  // for a mouse, a key, a scroll with no button down or another pointer's
  // press (it's rarely held down while typing, scrolling or touching the
  // screen: its release went unheard, a menu took it, and the user has
  // moved on). A mouse held still is a slow
  // click, and keeps its press. A context menu changes nothing: browsers
  // send one for any long press, menu or none, and one that's open sits
  // above the page, so nothing drawn under it can be pressed by mistake.
  // Only the user's own presses and clicks count (not a script's, an
  // extension's say).
  const presses = new Map(); // pointerId: the press under way, { id, type, since, target, beside, holds, released, then: what waits for its end, end(), movingFocus }
  let lastReleased = null; // the press under way when its pointer was last released (see clicks)
  let latest = null; // the last press begun (a mousedown is its doing)
  let drawDue = null; // the last thing render drew while presses held it
  // A move of the view a press held (Go's jump to the verdict, a tab an
  // arrow focused scrolling into view): { move, from: where focus was,
  // acts: the count then }. It goes once no press holds it, only if the
  // user has done nothing since (see `acts`, counted below: a pan, say,
  // is them scrolling) and focus is still where it was.
  let moveDue = null;
  let acts = 0; // what the user has done
  /** Moves the view now, or once no press holds it (only the last asked for). */
  function later(move) {
    if (holding()) moveDue = { move, from: document.activeElement, acts };
    else move();
  }
  const holding = () => [...presses.values()].some((p) => p.holds);
  const holdsAt = (el) => !el.closest('.calc-input') || Boolean(el.closest('.hint'));
  const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'OS', 'Fn', 'FnLock', 'Hyper', 'Super', 'Symbol', 'SymbolLock', 'CapsLock', 'NumLock', 'ScrollLock']); // pressed, they do nothing
  function flush() {
    if (holding()) return;
    const [draw, due] = [drawDue, moveDue];
    drawDue = moveDue = null;
    draw?.();
    if (due && due.acts === acts && document.activeElement === due.from) due.move();
  }
  addEventListener('pointerdown', (e) => {
    if (!e.isTrusted) return;
    // Its pointer pressing again (one mouse, one pen), or any press after a
    // mouse's: their releases went unheard.
    for (const p of presses.values()) if (p.id === e.pointerId || p.type === 'mouse' || (p.type === e.pointerType && p.type !== 'touch')) p.end();
    const silent = e.pointerType !== 'mouse'; // no hover to show a missed release
    // beside: the text field it began on the label, border or hint of (see clicks).
    const press = { id: e.pointerId, type: e.pointerType, since: performance.now(), target: e.target, beside: besideField(e.target), holds: silent || holdsAt(e.target), released: false, then: [] };
    presses.set(press.id, press);
    latest = press;
    const stop = new AbortController();
    const on = (type, fn) => addEventListener(type, (ev) => ev.isTrusted && fn(ev), { capture: true, passive: true, signal: stop.signal });
    let timer = 0;
    const wait = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => press.end(), ms);
    };
    press.end = () => {
      if (stop.signal.aborted) return; // over already
      stop.abort();
      clearTimeout(timer);
      if (presses.get(press.id) === press) presses.delete(press.id);
      if (lastReleased === press) lastReleased = null;
      const fns = press.then.splice(0);
      setTimeout(() => {
        fns.forEach((f) => f());
        flush();
      }); // after the click's own handlers
    };
    if (silent) wait(3000);
    on('pointermove', (m) => {
      if (m.pointerId !== press.id || press.released) return;
      if (!m.buttons) return press.end(); // its release went unheard
      if (silent) wait(3000);
      else if (!press.holds && holdsAt(m.target)) press.holds = true; // a drag reaching what renders change
    });
    on('pointerup', (u) => {
      if (u.pointerId !== press.id) return;
      press.released = true;
      wait(250); // for its click
    });
    on('pointercancel', (c) => {
      if (c.pointerId !== press.id) return;
      press.end();
    });
    if (silent) return; // a mouse's is over at a key, or a scroll with no button down (see above)
    on('keydown', (k) => !k.repeat && !MODIFIERS.has(k.key) && press.end());
    // With a button held, a scroll may be taking a selection on. (Where a
    // browser reports no buttons on scrolls, Safari's perhaps, any ends it.)
    on('wheel', (w) => !w.buttons && press.end());
  }, true);
  // A press is over at its own click (not a keyboard's, which counts no
  // clicks). Not every browser names the pointer that clicked as it named
  // its press (and a label passes its click on to its field, named by
  // none): a click whose pointer has no press under way is that of the
  // press last released, if that's still under way (a click comes right
  // after its release; a pointer whose press was over first has none). A
  // tap acts on something unless its press began on the label, border or
  // hint of the field a held Go was pressed in (one into the box is
  // editing on, one elsewhere a choice): judged by where it began.
  addEventListener('pointerup', (e) => e.isTrusted && (lastReleased = presses.get(e.pointerId) ?? null), { capture: true, passive: true });
  addEventListener('click', (c) => {
    if (!c.isTrusted || !c.detail) return;
    const press = presses.get(c.pointerId) ?? lastReleased;
    if (!press) return;
    if (!(moveDue && press.beside === moveDue.from)) acted(c);
    press.end();
  }, true);
  // The rest the user does (not a script, an extension's say): a press, a
  // cancelled one (the browser took the gesture, a pan or a pinch), a key
  // that isn't a modifier (typing, moving the caret), a scroll, an input
  // (a paste).
  const acted = (e) => e.isTrusted && acts++;
  for (const type of ['pointerdown', 'pointercancel', 'wheel', 'input']) addEventListener(type, acted, { capture: true, passive: true });
  addEventListener('keydown', (k) => MODIFIERS.has(k.key) || acted(k), { capture: true, passive: true });
  // Focus moves in a press's mousedown (a finger's tap sends one at its
  // release), or, held long, a finger or pen takes it with none (to what
  // it's on, or to nothing): a focusout then is that press's doing. One to
  // elsewhere is a key's (Next, typed with the other hand), as is one during
  // a tap; one to nothing while a finger has been held long (a keyboard's
  // Done) is taken as the long press's: judged once it's over or, the finger
  // beside the field and selecting nothing, focus brought back (see comeBack).
  addEventListener('mousedown', (e) => {
    if (!e.isTrusted) return;
    const press = latest;
    if (!presses.has(press?.id)) return;
    press.movingFocus = true;
    setTimeout(() => (press.movingFocus = false));
  }, true);
  // ms since the page heard it go down (not since the screen did: a press
  // heard late, behind a long task, isn't long for it): under any browser's
  // wait before a long press (Android's shortest is 300ms).
  const LONG_PRESS = 200;
  /** The press moving focus now to `to` (null: to nothing), if any. */
  function pressMoving(to) {
    if (latest?.movingFocus) return latest;
    const now = performance.now();
    // Still down (a finger lifted isn't taking anything), and not a
    // mouse's (which moves focus only as it goes down).
    const longPress = (p) => p.type !== 'mouse' && !p.released && now - p.since >= LONG_PRESS && (!to || to.contains(p.target));
    return [...presses.values()].reverse().find(longPress) ?? null; // the latest
  }
  /** Runs `fn` once `press` is over, or a task from now if there's none. */
  const afterPress = (press, fn) => (press ? press.then.push(fn) : setTimeout(fn));

  /**
   * `save` marks the user's own edits: stored (outside a shared link) and
   * mirrored to the URL. `typing` names the text field a keystroke changed;
   * without it, a render judges every field. Mid-typing a field can be
   * briefly empty or on its way to a number ("" before "45", "1,2" before
   * "1,234"), so a field's first error waits: until its value is usable
   * nothing changes (no flag, no prompt in place of the results, nothing
   * saved), and it stays `dirty`, judged when the user leaves the field,
   * presses Enter or uses another control (a tab, a checkbox), which pass
   * `save` for it. A usable value shows its results at once, and a field
   * already flagged is judged at every keystroke, so what it and the prompt
   * say stays true (another error, "needed", or nothing wrong); only a value
   * on its way to a number ("1," before "1,5", "0." before "0.75") waits
   * even then. The list is redrawn only when the result changed; what a
   * render draws waits while a press holds it (see presses).
   */
  function render({ save = false, typing = '', standIn = {} } = {}) {
    renderSoon.cancel(); // this render reads everything a queued one would
    const state = readForm(standIn);
    const input = normalizeInputs(state.values);
    // A marketplace's own fee page always shows it, even if the visitor hid it.
    const ids = focus && !state.platforms.includes(focus) ? [...state.platforms, focus] : state.platforms;
    const checks = check(state.values, ids, input);
    const typed = checks.find((c) => c.key === typing);
    const waits = typed && (typed.problem || typed.missing) && (!flagged.has(typing) || onItsWay(typing, state.values[typing], { sellPrice: typed.needed }));
    if (typed && (waits || stillTyping(typing, field(typing).value))) {
      // Nothing changes until its value is usable. The first render has
      // nothing on screen to keep (the field typed into before the script
      // ran): its value as loaded stands in, and it's still to be judged.
      if (rendered || !has(loadedEarly, typing)) return;
      render({ save, standIn: { [typing]: loadedEarly[typing] } });
      dirty = typing;
      return;
    }
    dirty = '';
    rendered = state;
    for (const c of checks) {
      if (c.problem || c.missing) flagged.add(c.key);
      else flagged.delete(c.key);
    }
    const blocking = checks.filter((c) => c.blocks);
    const pending = pendingFor(ids, blocking);
    pendingField = pending?.[1] ?? null;
    shown = pending ? { prompt: pending[0] } : { mode, input, ids, link: fragment(state, true) }; // the link shares it, as typed
    const [m, next, shared] = [mode, shown, sharedView];
    const draw = () => {
      const had = document.activeElement;
      if (m !== drawnMode) {
        for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.mode === m));
        panel.setAttribute('aria-labelledby', `tab-${m}`);
        hint.textContent = MODES[m].hint;
        hintFor('target').dataset.default = MODES[m].targetHint;
        drawnMode = m;
      }
      for (const name of [...MAIN_KEYS, 'ebayCustomRate']) show(fieldBox(name), onShow(name, m, input));
      show(sharedNote, shared);
      // Reset clears saved settings, so it is only offered on your own view;
      // a shared result has "Use my settings" instead.
      show(resetBtn, !shared);
      flag(checks);
      // Bad values a link brought in open the Fine-tune panel they're in, so
      // they're seen. After that, opening and closing it is up to the user.
      if (reveal) for (const b of blocking) if (b.problem) field(b.key).closest('details:not([open])')?.setAttribute('open', '');
      reveal = false;
      paint(next);
      keepFocus(had);
    };
    if (holding()) drawDue = draw;
    else {
      drawDue = null;
      draw();
    }
    if (save) {
      if (!sharedView) persist(state);
      syncUrlSoon();
    }
  }

  function paint(next) {
    // A part already on screen isn't drawn again: that would only reset a
    // selection or a reading position in it. Worked out from the same
    // numbers (however they were written), nothing is; otherwise the
    // verdict and the list are each compared as drawn, so what one doesn't
    // show (a hidden marketplace's option, a minimum only the verdict
    // names) leaves it be.
    const from = next.prompt ?? JSON.stringify([next.mode, next.input, next.ids]);
    if (from === paintedFrom) return;
    paintedFrom = from;
    const was = painted ?? builtOutput(focus);
    if (next.prompt) {
      showPending(next.prompt);
      painted = { list: was.list }; // the list stays, hidden
    } else {
      const out = renderOutput(next.mode, next.input, next.ids, { focus });
      if (out.verdict !== was.verdict) showVerdict(out); // (its tone goes with its words)
      show(resultsEl, true); // before the list is fitted: hidden, it measures nothing
      if (out.list !== was.list) showList(out.list);
      fitResults(); // as now shown: a new list, or the same at load or back from a prompt at a new width
      show(shareBtn, shareSupported);
      painted = { verdict: out.verdict, list: out.list };
    }
    announce();
  }
  const renderSoon = debounce((key) => render({ save: true, typing: key }), 60);
  // Leaving (or hidden, where a phone may drop the page) before a keystroke
  // is worked out or the address bar written: Back and reload still find it.
  const leaving = () => {
    renderSoon.flush();
    syncUrlSoon.flush();
  };
  addEventListener('pagehide', leaving);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && leaving());

  // Figures sit beside the names unless a name no longer fits beside its
  // figure (a big amount, large text): then every figure moves under its name,
  // so the list stays even. (Until this runs, and without it, a list narrow
  // enough is stacked by its width alone: see styles.css.)
  function fitResults() {
    fittedAt = fitKey();
    resultsEl.classList.add('fitted'); // measured as it is, not as guessed
    resultsEl.classList.remove('stacked');
    const squeezed = [...resultsEl.querySelectorAll('.pname')].some((name) => name.scrollWidth > name.clientWidth + 1);
    resultsEl.classList.toggle('stacked', squeezed);
  }
  // Refit, before the frame paints, when the column's width changes (a
  // phone turned: watched on the verdict, which spans it) or the text's size
  // or spacing does (watched on a hidden word, whose width is its text's
  // alone): compared with what the list was last fitted at, so the
  // verdict's height (its own words rewrapping) changes nothing, and a
  // change before the first frame is caught. Neither depends on the list's
  // fit, so fitting from here can't resize what's watched (a
  // "ResizeObserver loop").
  const probe = document.createElement('span');
  probe.className = 'fit-probe';
  probe.setAttribute('aria-hidden', 'true');
  probe.textContent = 'Marketplace';
  resultsEl.after(probe);
  const fitKey = () => `${verdictEl.clientWidth} ${probe.offsetWidth}`;
  let fittedAt = '';
  const refit = new ResizeObserver(() => resultsEl.clientWidth && fitKey() !== fittedAt && fitResults());
  refit.observe(verdictEl);
  refit.observe(probe);

  // Screen readers hear the verdict once the user pauses, not after every
  // keystroke, and only when it changed. Nothing is announced on page load.
  const verdictText = () => verdictEl.textContent.replace(/\s+/g, ' ').trim();
  let spoken = '';
  const announce = debounce(() => {
    const text = verdictText();
    if (text !== spoken) verdictLive.textContent = spoken = text;
  }, 1000);
  // Focus reads the verdict out, so the live region doesn't say it again.
  function focusVerdict(scroll = { block: 'nearest' }) {
    verdictEl.focus({ preventScroll: true });
    verdictEl.scrollIntoView(scroll);
    spoken = verdictText();
  }

  // ---- modes (tabs) ----

  function setMode(next, { moveFocus = false, save = false, typing = '' } = {}) {
    mode = next;
    // The tablist's one tab stop is focus's, not drawing: it moves at once.
    for (const tab of tabs) tab.tabIndex = tab.dataset.mode === mode ? 0 : -1;
    render({ save, typing }); // which draws the tabs (when no press holds it), and the mode's fields and hints
    if (moveFocus) {
      // Focus too moves at once: that moves nothing under a press. The
      // scroll that brings the tab into view, the least one (clear of the
      // sticky header, whose room the page keeps), waits for one; it's made
      // even for a tab focused already (Home on the first), which focus()
      // alone wouldn't scroll.
      const tab = tabFor(mode);
      tab.focus({ preventScroll: true });
      later(() => tab.scrollIntoView({ block: 'nearest' }));
    }
  }

  // The user's own switch: it takes in (and saves) anything they left typed.
  // The address bar follows at once, or soon while a held arrow key repeats.
  function selectMode(next, { repeat = false, ...opts } = {}) {
    setMode(next, { ...opts, save: dirty !== '' });
    if (repeat) return syncUrlSoon();
    syncUrlSoon.cancel(); // the render's queued write is this one
    syncUrl();
  }

  // At large text sizes the tabs stack: a vertical tablist, moved with
  // Up/Down (side by side, Up/Down keep scrolling the page).
  const tablist = tabs[0].parentElement;
  const stacked = () => tabs[1].getBoundingClientRect().top > tabs[0].getBoundingClientRect().top + 1;
  new ResizeObserver(() => tablist.setAttribute('aria-orientation', stacked() ? 'vertical' : 'horizontal')).observe(tablist);

  for (const tab of tabs) {
    tab.addEventListener('click', () => selectMode(tab.dataset.mode));
    tab.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return; // the browser's (Alt+arrows go Back and Forward)
      const i = tabs.indexOf(tab);
      const step = stacked() ? { ArrowDown: i + 1, ArrowUp: i - 1 } : { ArrowRight: i + 1, ArrowLeft: i - 1 };
      const to = { ...step, Home: 0, End: tabs.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      selectMode(tabs[(to + tabs.length) % tabs.length].dataset.mode, { moveFocus: true, repeat: e.repeat });
    });
  }

  // ---- events ----

  // Text fields render as you type; selects and checkboxes on change.
  form.addEventListener('input', (e) => {
    if (e.target.type !== 'text') return;
    dirty = e.target.name;
    renderSoon(e.target.name);
  });
  form.addEventListener('change', (e) => {
    if (e.target.type !== 'text') render({ save: true });
  });

  // A field left half-typed is judged once focus has moved on, and after
  // the press that took it (see presses). Losing focus to another window or
  // tab isn't leaving: the field stays the active element, and is judged
  // when the user leaves it.
  form.addEventListener('focusout', (e) => {
    const el = e.target;
    if (el.type !== 'text') return;
    const press = pressMoving(e.relatedTarget);
    if (press?.beside === el) comeBack(press, el);
    afterPress(press, () => {
      if (document.activeElement === el) return;
      showPoint(el); // the same value to the form (see readForm): nothing to redraw
      if (dirty === el.name) render({ save: true });
    });
  });
  // Pressing anywhere on the field being typed in (its label, its $ or %,
  // its border, the gaps, its hint), with any button or finger, keeps focus
  // in it, so it isn't judged as left, unless the press may be selecting
  // words there: a mouse's main button on the hint, or a long press (which
  // takes focus with no mousedown to stop it). (A pen on a tablet taps like
  // a finger: moving focus would bounce its keyboard. A Ctrl-click on a Mac
  // is a right click.)
  form.addEventListener('mousedown', (e) => {
    if (!e.isTrusted) return;
    const input = besideField(e.target);
    if (!input || input !== document.activeElement) return;
    const mainClick = e.button === 0 && !(e.ctrlKey && MAC);
    const selecting = e.target.closest('.hint') && mainClick && latest?.type === 'mouse'; // (a finger's tap sends a mousedown too)
    if (!selecting) e.preventDefault();
  });
  /**
   * A press beside the field `input` that took focus from it: once it's
   * over, focus comes back if it selected nothing (an empty press isn't
   * leaving), before the field is judged. If it selected something, the
   * field is judged, as on any leaving, and if that swaps those words for
   * true ones (see flag), nothing is selected, and focus comes back too.
   */
  function comeBack(press, input) {
    const caret = caretOf(input);
    const giveBack = () => {
      input.focus({ preventScroll: true });
      input.setSelectionRange(...caret);
    };
    const leftForNothing = () => document.activeElement === document.body && getSelection().isCollapsed;
    // First of what waits for the press, while the words are as it left them
    // (a keystroke's render may be waiting too).
    press.then.unshift(() => {
      if (leftForNothing()) return giveBack();
      setTimeout(() => leftForNothing() && giveBack());
    });
  }

  // On narrow screens the results sit below the form: "See results" (and
  // Enter / Go on a phone keyboard) jumps to the verdict. On wide screens the
  // results are already beside the form, so Enter just refreshes them.
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (document.activeElement?.type === 'text' && form.contains(document.activeElement)) showPoint(document.activeElement);
    render({ save: true });
    // Then to what needs fixing (opening Fine-tune if it's in there), not
    // away from it, or to the verdict: once no press would see the page move.
    const jump = () => {
      if (pendingField) {
        pendingField.closest('details:not([open])')?.setAttribute('open', '');
        return pendingField.focus();
      }
      if (seeResults.offsetParent === null) return;
      const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
      focusVerdict({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
    };
    later(jump);
  });

  resetBtn.addEventListener('click', () => {
    if (sharedView) return; // offered on your own view only (hidden on a shared one once drawn)
    storage.clear();
    for (const key of [...MAIN_KEYS, ...TUNE_KEYS]) setValue(key, DEFAULTS[key]);
    setPlatforms(ALL_IDS);
    render(); // not a save: it takes in (and drops) whatever was typed
    syncUrl();
  });

  const SHARE_LABEL = shareBtn.textContent;
  let shareReset;
  // Shows `message` on the button for a moment and has it read out (screen
  // readers don't announce a button's label changing; a status region is).
  function sayOnShare(message, status = message) {
    clearTimeout(shareReset); // one timer, so a second click never has its message cut short by the first
    shareBtn.textContent = message;
    shareStatus.textContent = status;
    shareReset = setTimeout(() => {
      shareBtn.textContent = SHARE_LABEL;
      shareStatus.textContent = '';
    }, 2500);
  }
  if (shareSupported) {
    shareBtn.addEventListener('click', async () => {
      // A field left half-typed is judged first, so the link is never for
      // numbers no longer in the form.
      if (dirty) render({ save: true });
      if (shown.prompt) return; // nothing to share: the prompt has taken the results' place (and focus)
      const url = `${location.origin}${location.pathname}${shown.link}`;
      let message = 'Link copied';
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        // Clipboard missing or refused (permissions, unfocused page): try the share sheet.
        try {
          if (!canShare) throw new Error('no share sheet');
          await navigator.share({ title: document.title, url });
          message = SHARE_LABEL;
        } catch (err) {
          message = err?.name === 'AbortError' ? SHARE_LABEL : 'Copy failed. Use the address bar.';
        }
      }
      sayOnShare(message, message === SHARE_LABEL ? '' : message);
    });
  }

  // Changed before the script ran (where a browser paints first): kept, as
  // the visitor's own edits, and saved; the field still being typed in
  // waits as any keystroke does (see render).
  const changedEarly = [...form.querySelectorAll('input, select')].filter((el) =>
    el.type === 'checkbox' ? el.checked !== el.defaultChecked : el.tagName === 'SELECT' ? [...el.options].some((o) => o.selected !== o.defaultSelected) : el.value !== el.defaultValue,
  );
  loadedEarly = load(changedEarly);
  const typingEarly = changedEarly.includes(document.activeElement) && document.activeElement.type === 'text' ? document.activeElement.name : '';
  setMode(mode, { save: changedEarly.length > 0, typing: typingEarly });
  spoken = verdictText(); // the starting verdict is already on screen: not news
  // A pasted link, or Back/Forward between results, only changes the
  // fragment (no reload), so load that state. Plain anchors like the skip
  // link (#main) have already done their jump, so put the current result
  // back in the address bar (replaceState never fires hashchange or scrolls).
  window.addEventListener('hashchange', () => {
    const params = linkParams();
    const empty = location.hash.length <= 1; // e.g. Back to a plain "/"
    if (!empty && !LINK_KEYS.some((k) => params.has(k))) {
      syncUrl();
      return;
    }
    load();
    setMode(mode);
  });
}

for (const root of document.querySelectorAll('[data-calc]')) setup(root);

