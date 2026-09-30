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
import { DEFAULTS, normalizeInputs, rank, rankedRows, inputsUsedBy, inputProblem, stillTyping, withDecimalPoint, PRICE_NEEDED, has } from '../engine/calc.mjs';
import { renderResults, renderVerdict, esc, MODES } from '../engine/render.mjs';
import { PLATFORMS, PLATFORM_BY_ID } from '../engine/fees.mjs';

const STORE_KEY = 'threadvet:settings:v2';
const SHARE_FLAG = 's';
const MAIN_KEYS = ['price', 'cost', 'ship', 'label', 'target'];
const TUNE_KEYS = ['taxRate', 'other', ...PLATFORMS.flatMap((p) => p.options ?? [])]; // each marketplace declares its own
const NUMERIC = [...MAIN_KEYS, ...TUNE_KEYS].filter((key) => typeof DEFAULTS[key] === 'number');
const LINK_KEYS = [SHARE_FLAG, 'mode', ...MAIN_KEYS];
const ALL_IDS = PLATFORMS.map((p) => p.id);

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
  const call = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  call.cancel = () => clearTimeout(t);
  return call;
}

function setup(root) {
  const form = root.querySelector('form');
  const panel = root.querySelector('[role="tabpanel"]');
  const tabs = [...root.querySelectorAll('[role="tab"]')];
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
  let reveal = false; // open Fine-tune for bad values a link brought in (set by load)
  let rendered = null; // the form as last judged: what the address bar holds
  let painted = null; // the output on screen: { prompt } or { mode, input, ids, link } (see paint)
  let dirty = ''; // the text field typed into since the last judged render
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

  function setPlatforms(ids) {
    for (const box of form.querySelectorAll('input[name="platform"]')) box.checked = ids.includes(box.value);
  }

  // A comma read as the decimal point, shown as one where a value is taken
  // in (left, Enter, a link): "2,50" becomes "2.50", so a slip meant as 250
  // can't pass unseen. Never while the field is still being typed in.
  function showPoint(el) {
    const text = withDecimalPoint(el.name, el.value);
    if (text === el.value) return;
    const { selectionStart: from, selectionEnd: to, selectionDirection: way } = el;
    el.value = text; // the same length: one comma became a point
    if (document.activeElement === el) el.setSelectionRange(from, to, way); // the caret (or selection) stays as it was
  }

  function readForm() {
    const data = new FormData(form);
    const values = {};
    // A setting with no field on the page (say, a new option declared before its
    // field is added) keeps its default rather than reading as empty (0%). A
    // comma read as the decimal point is a point here, so a link, saved
    // settings and the result don't depend on which one was typed.
    for (const key of [...MAIN_KEYS, ...TUNE_KEYS]) {
      const raw = field(key) ? (data.get(key) ?? '') : DEFAULTS[key];
      values[key] = NUMERIC.includes(key) ? withDecimalPoint(key, raw) : raw;
    }
    values.depopBoost = data.has('depopBoost');
    return { values, platforms: data.getAll('platform') };
  }

  const linkParams = () => new URLSearchParams(location.hash.slice(1));

  function load() {
    reveal = true;
    dirty = ''; // whatever was being typed is replaced
    const params = linkParams();
    sharedView = params.has(SHARE_FLAG);
    const saved = sharedView ? {} : storage.read();
    const tune = sharedView ? Object.fromEntries(params) : (saved.values ?? {});
    for (const key of MAIN_KEYS) setValue(key, params.has(key) ? params.get(key) : DEFAULTS[key]);
    for (const key of TUNE_KEYS) setValue(key, has(tune, key) ? tune[key] : DEFAULTS[key]);
    for (const key of NUMERIC) if (field(key)) showPoint(field(key));
    if (sharedView) {
      setPlatforms(params.get('platforms')?.split(',') ?? ALL_IDS);
    } else {
      // Saved as the marketplaces the user turned OFF, so ones added later show up.
      const hidden = Array.isArray(saved.hidden) ? saved.hidden : [];
      setPlatforms(ALL_IDS.filter((id) => !hidden.includes(id)));
    }
    const m = params.get('mode');
    mode = m && has(MODES, m) ? m : 'profit';
    sharedNote.hidden = !sharedView;
    // Reset clears saved settings, so it is only offered on your own view;
    // a shared result has "Use my settings" instead.
    resetBtn.hidden = sharedView;
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

  /**
   * Each numeric field on the page, [{ key, problem, missing, blocks }]:
   * `problem` says what is wrong with its value; `missing` marks a sell price
   * the mode needs but that isn't typed yet (neutral: not an error yet).
   * `blocks`: either one holds the results back, because the compared
   * marketplaces read the field in this mode (inputsUsedBy) and it is on show.
   */
  function check(values, ids, input) {
    const used = new Set(ids.flatMap((id) => inputsUsedBy(PLATFORM_BY_ID[id], mode, input)));
    return NUMERIC.filter((key) => field(key)).map((key) => {
      const needed = key === 'price' && used.has('price');
      const problem = inputProblem(key, values[key], { sellPrice: needed });
      const missing = !problem && needed && String(values.price).trim() === '';
      const blocks = Boolean(problem || missing) && used.has(key) && !field(key).closest('[hidden]');
      return { key, problem, missing, blocks };
    });
  }

  /** Marks each field with what is wrong; its hint says it. */
  function flag(checks) {
    for (const { key, problem, missing } of checks) {
      const el = field(key);
      if (problem) el.setAttribute('aria-invalid', 'true');
      else el.removeAttribute('aria-invalid');
      el.closest('.input-wrap')?.classList.toggle('is-invalid', Boolean(problem));
      const h = hintFor(key);
      if (h) {
        const text = problem || (missing ? PRICE_NEEDED : h.dataset.default);
        if (h.textContent !== text) h.textContent = text; // unchanged, a selection in it stays
        h.classList.toggle('hint-error', Boolean(problem));
      }
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
    const lost = resultsEl.contains(document.activeElement) || document.activeElement === shareBtn;
    resultsEl.hidden = true;
    shareBtn.hidden = true;
    if (lost) focusVerdict(); // not dropped to the top of the page
  }

  /** Rows for a result that can be worked out, and the verdict over them. */
  function showResults({ mode: m, input, ids }) {
    const open = openIds();
    const inList = resultsEl.contains(document.activeElement);
    const row = inList && document.activeElement.closest('.result')?.dataset.id;
    const rows = rankedRows(m, rank(m, input, ids), input.target);
    const verdict = renderVerdict(m, rows, input);
    verdictEl.className = `verdict verdict-${verdict.tone}`;
    verdictEl.innerHTML = verdict.html;
    resultsEl.innerHTML = renderResults(m, rows, { focus });
    resultsEl.hidden = false;
    shareBtn.hidden = !shareSupported;
    for (const id of open) resultsEl.querySelector(`[data-id="${id}"] details`)?.setAttribute('open', '');
    fitResults();
    // Focus that was in the list stays on its row (or goes to the verdict, if the row went).
    if (!inList) return;
    const summary = row && resultsEl.querySelector(`[data-id="${row}"] summary`);
    if (!summary) return focusVerdict();
    summary.focus({ preventScroll: true });
    summary.scrollIntoView({ block: 'nearest' }); // its new place may be off screen
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
  // A click lands where it was pressed only if nothing moves in between. Two
  // things could move the output under a press, and wait for it: judging a
  // field the press took focus from (the prompt may take the list's place),
  // and a keystroke's render still due when the press began. Anything else
  // that renders (a tab, a checkbox) does so from the click itself.
  //
  // A press (the main button, a finger, a pen) is over at the click it makes
  // (once its handlers ran), 250ms after a release that makes none, when
  // it's cancelled, or when a release the page never heard of shows: its
  // pointer moving with no button down (a mouse or pen hovering) or, for a
  // finger, which can't hover, 3s without a word from it. A mouse held still
  // is a slow click, and keeps its press.
  const inputSide = root.querySelector('.calc-input'); // tabs and form: nothing renders under them
  let down = null; // the press under way: { id, at, then: what waits for it, end() }
  addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; // a right or middle press makes no click
    const waiting = down?.end(false) ?? []; // a new press: what waited for the last waits for this one
    const press = (down = { id: e.pointerId, at: e.timeStamp, then: waiting });
    const stop = new AbortController();
    const on = (type, fn) => addEventListener(type, fn, { capture: true, signal: stop.signal });
    let timer = 0;
    const wait = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => press.end(), ms);
    };
    press.end = (run = true) => {
      stop.abort();
      clearTimeout(timer);
      if (down === press) down = null;
      const fns = press.then.splice(0);
      if (run) setTimeout(() => fns.forEach((f) => f())); // after the click's own handlers
      return fns;
    };
    const silent = e.pointerType === 'touch'; // no hover to show a missed release
    if (silent) wait(3000);
    on('pointermove', (m) => {
      if (m.pointerId !== press.id) return;
      if (!m.buttons) press.end(); // its release went unheard
      else if (silent) wait(3000);
    });
    on('pointerup', (u) => {
      if (u.pointerId !== press.id) return;
      press.at = u.timeStamp;
      wait(250); // for its click
    });
    on('pointercancel', (c) => c.pointerId === press.id && press.end());
    on('click', (c) => c.detail && press.end()); // a keyboard's click (no clicks counted) isn't this press's
    if (!dirty || inputSide.contains(e.target)) return;
    renderSoon.cancel(); // the keystroke's render, due mid-press
    const key = dirty;
    press.then.push(() => dirty === key && render({ save: true, typing: key }));
  }, true);
  /**
   * Runs `fn` once the press that just moved focus (at its press or its
   * release: a finger moves it then) is over, or a task from now otherwise.
   */
  function afterPress(fn, { timeStamp }) {
    if (down && timeStamp - down.at < 100) down.then.push(fn);
    else setTimeout(fn);
  }

  /**
   * `save` marks the user's own edits: stored (outside a shared link) and
   * mirrored to the URL. `typing` names the text field a keystroke changed;
   * without it, a render judges every field. Mid-typing a field can be
   * briefly empty or on its way to a number ("" before "45", "1,2" before
   * "1,234"), so until it is usable nothing changes: no flag, no prompt in
   * place of the results, nothing saved. It stays `dirty` and is judged
   * when the user leaves the field, presses Enter or uses another control
   * (a tab, a checkbox), which pass `save` for it. A usable value shows its
   * results at once. The list is redrawn only when the result changed; a
   * press can hold back only what it caused (see presses).
   */
  function render({ save = false, typing = '' } = {}) {
    renderSoon.cancel(); // this render reads everything a queued one would
    const state = readForm();
    const input = normalizeInputs(state.values);
    fieldBox('ebayCustomRate').hidden = !PLATFORM_BY_ID.ebay.usesOption('ebayCustomRate', input.opts);
    // A marketplace's own fee page always shows it, even if the visitor hid it.
    const ids = focus && !state.platforms.includes(focus) ? [...state.platforms, focus] : state.platforms;
    const checks = check(state.values, ids, input);
    const typed = checks.find((c) => c.key === typing);
    if (typed && (typed.problem || typed.missing || stillTyping(typed.key, field(typed.key).value))) return;
    dirty = '';
    rendered = state;
    flag(checks);
    const blocking = checks.filter((c) => c.blocks);
    // Bad values a link brought in open the Fine-tune panel they're in, so
    // they're seen. After that, opening and closing it is up to the user.
    if (reveal) for (const b of blocking) if (b.problem) field(b.key).closest('details:not([open])')?.setAttribute('open', '');
    reveal = false;

    const pending = pendingFor(ids, blocking);
    pendingField = pending?.[1] ?? null;
    paint(pending ? { prompt: pending[0] } : { mode, input, ids, link: fragment(state, true) }); // the link: everything the result depends on
    if (save) {
      if (!sharedView) persist(state);
      syncUrlSoon();
    }
  }

  function paint(next) {
    // Already on screen, a repaint would only reset a selection or a reading position.
    const same = painted && (next.prompt ? next.prompt === painted.prompt : next.link === painted.link);
    if (!same) {
      if (next.prompt) showPending(next.prompt);
      else showResults(next);
      announce();
    }
    painted = next; // once it's on screen
  }
  const renderSoon = debounce((key) => render({ save: true, typing: key }), 60);

  // Figures sit beside the names unless a name no longer fits beside its
  // figure (a big amount, large text): then every figure moves under its name,
  // so the list stays even. (Without JavaScript a CSS container query does a
  // rougher version of this.)
  let fittedWidth = 0;
  function fitResults() {
    fittedWidth = resultsEl.clientWidth;
    resultsEl.classList.remove('stacked');
    const squeezed = [...resultsEl.querySelectorAll('.pname')].some((name) => name.scrollWidth > name.clientWidth + 1);
    resultsEl.classList.toggle('stacked', squeezed);
  }
  // Refit when the list's width changes (not when it is hidden, or shown
  // again at the width render just fitted). Next frame, not inside the
  // callback: toggling .stacked changes the list's height, and changing an
  // observed element's size from its own callback raises "ResizeObserver
  // loop" errors.
  new ResizeObserver(() => {
    const width = resultsEl.clientWidth;
    if (width && width !== fittedWidth) {
      fittedWidth = width;
      requestAnimationFrame(fitResults);
    }
  }).observe(resultsEl);

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

  function setMode(next, { moveFocus = false, save = false } = {}) {
    mode = next;
    for (const tab of tabs) {
      const on = tab.dataset.mode === mode;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on && moveFocus) tab.focus();
    }
    panel.setAttribute('aria-labelledby', `tab-${mode}`);
    hint.textContent = MODES[mode].hint;
    hintFor('target').dataset.default = MODES[mode].targetHint;
    for (const name of MAIN_KEYS) fieldBox(name).hidden = MODES[mode].hidden.includes(name);
    render({ save });
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
  // the click of a press that took it (see presses). Losing focus to another
  // window or tab isn't leaving: the field stays the active element, and is
  // judged when the user leaves it.
  form.addEventListener('focusout', (e) => {
    const el = e.target;
    if (el.type !== 'text') return;
    afterPress(() => {
      if (document.activeElement === el) return;
      showPoint(el); // the same value to the form (see readForm): nothing to redraw
      if (dirty === el.name) render({ save: true });
    }, e);
  });
  // Pressing anywhere on the field being typed in (its label, its $ or %,
  // its border, the gaps and the room around its hint), with any button,
  // keeps focus in it, so it isn't judged as left. The hint's words are
  // text to read and select: a press on them leaves the field.
  const onWords = (el, x, y) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return [...range.getClientRects()].some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
  };
  form.addEventListener('mousedown', (e) => {
    const words = e.target.closest('.hint')?.querySelector('[data-live]');
    if (words && onWords(words, e.clientX, e.clientY)) return;
    const input = e.target.closest('.field')?.querySelector('input[type="text"]');
    if (input && input === document.activeElement && e.target !== input) e.preventDefault();
  });

  // On narrow screens the results sit below the form: "See results" (and
  // Enter / Go on a phone keyboard) jumps to the verdict. On wide screens the
  // results are already beside the form, so Enter just refreshes them.
  seeResults.hidden = false;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (document.activeElement?.type === 'text' && form.contains(document.activeElement)) showPoint(document.activeElement);
    render({ save: true });
    // Nothing to show yet: go to what needs fixing (opening Fine-tune if it's
    // in there), not away from it.
    if (pendingField) {
      pendingField.closest('details:not([open])')?.setAttribute('open', '');
      return pendingField.focus();
    }
    if (seeResults.offsetParent === null) return;
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    focusVerdict({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  });

  resetBtn.addEventListener('click', () => {
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
      if (!painted || painted.prompt) return; // nothing to share: the prompt has taken the results' place (and focus)
      const url = `${location.origin}${location.pathname}${painted.link}`;
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

  load();
  setMode(mode);
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

