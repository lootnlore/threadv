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
import { DEFAULTS, LIMITS, normalizeInputs, rank, rankedRows, parseNumber, has } from '../engine/calc.mjs';
import { renderResults, renderVerdict, MODES } from '../engine/render.mjs';
import { PLATFORMS, usdText, andList } from '../engine/fees.mjs';

const STORE_KEY = 'threadvet:settings:v2';
const SHARE_FLAG = 's';
const MAIN_KEYS = ['price', 'cost', 'ship', 'label', 'target'];
const TUNE_KEYS = ['taxRate', 'other', 'ebayCategory', 'ebayCustomRate', 'ebayAdRate', 'etsyOffsite', 'whatnotRate', 'tiktokRate', 'depopBoost'];
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
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

/** Error message for a numeric field's raw text, or '' when it is fine. */
function problemWith(key, raw) {
  const text = String(raw).trim();
  if (text === '') return '';
  const n = parseNumber(text);
  const max = LIMITS[key] ?? LIMITS.money;
  const isMoney = !(key in LIMITS);
  if (Number.isFinite(n) && n >= 0 && n <= max) return '';
  return isMoney ? `Enter an amount from $0 to ${usdText(max)}.` : `Enter a percentage from 0 to ${max}.`;
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
  const hintFor = (name) => root.querySelector(`#h-${name}`);
  for (const key of NUMERIC) {
    const h = hintFor(key);
    if (h) h.dataset.default = h.textContent;
  }
  let mode = 'profit';
  let sharedView = false;

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

  function readForm() {
    const data = new FormData(form);
    const values = {};
    for (const key of [...MAIN_KEYS, ...TUNE_KEYS]) values[key] = data.get(key) ?? '';
    values.depopBoost = data.has('depopBoost');
    return { values, platforms: data.getAll('platform') };
  }

  const linkParams = () => new URLSearchParams(location.hash.slice(1));

  function load() {
    const params = linkParams();
    sharedView = params.has(SHARE_FLAG);
    const saved = sharedView ? {} : storage.read();
    const tune = sharedView ? Object.fromEntries(params) : (saved.values ?? {});
    for (const key of MAIN_KEYS) setValue(key, params.has(key) ? params.get(key) : DEFAULTS[key]);
    for (const key of TUNE_KEYS) setValue(key, has(tune, key) ? tune[key] : DEFAULTS[key]);
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

  // Reads the form when it runs, so a delayed call can never write stale values.
  function syncUrl() {
    history.replaceState(null, '', `${location.pathname}${location.search}${fragment(readForm(), sharedView)}`);
  }
  const syncUrlSoon = debounce(syncUrl, 250);

  // ---- rendering ----

  const labelOf = (key) => root.querySelector(`label[for="f-${key}"]`)?.firstChild?.textContent.trim() || key;
  /** The marketplace a fee field belongs to (tiktokRate: tiktok), if any. */
  const ownerOf = (key) => PLATFORMS.find((p) => key.startsWith(p.id))?.id;

  /**
   * Flags each numeric field; returns the flagged ones that affect the results
   * now: on show in this mode, and not the rate of a marketplace left out.
   */
  function validate(values, ids) {
    const bad = [];
    for (const key of NUMERIC) {
      const el = field(key);
      if (!el) continue;
      const problem = problemWith(key, values[key]);
      const owner = ownerOf(key);
      if (problem && !el.closest('[hidden]') && (!owner || ids.includes(owner))) bad.push(key);
      if (problem) el.setAttribute('aria-invalid', 'true');
      else el.removeAttribute('aria-invalid');
      el.closest('.input-wrap')?.classList.toggle('is-invalid', Boolean(problem));
      const h = hintFor(key);
      if (h) {
        h.textContent = problem || h.dataset.default;
        h.classList.toggle('hint-error', Boolean(problem));
      }
    }
    return bad;
  }

  let renderedMode = null; // the mode the rows on screen were worked out for (null: the page's own example)
  let pendingField = null; // the field to fix before results can show
  let badBefore = new Set();

  function setStale(stale) {
    resultsEl.classList.toggle('is-stale', stale);
    resultsEl.inert = stale;
  }

  /**
   * While the numbers can't be trusted (a flagged field, or no sell price where
   * the mode needs one) the verdict asks for them, in a neutral tone, instead
   * of deciding. The last results stay, dimmed and out of reach (inert), if
   * they were worked out for this mode; otherwise (another mode, or the page's
   * example) they would mislead, so they go.
   */
  function showPending(html, fix) {
    verdictEl.className = 'verdict verdict-wait';
    verdictEl.innerHTML = `<span>${html}</span>`;
    pendingField = fix;
    if (renderedMode === mode) setStale(true);
    else {
      resultsEl.innerHTML = '';
      renderedMode = null;
      setStale(false);
    }
  }

  /** `save` marks the user's own edits: stored (outside a shared link) and mirrored to the URL. */
  function render({ save = false } = {}) {
    const state = readForm();
    fieldBox('ebayCustomRate').hidden = state.values.ebayCategory !== 'custom';
    // A marketplace's own fee page always shows it, even if the visitor hid it.
    const ids = focus && !state.platforms.includes(focus) ? [...state.platforms, focus] : state.platforms;
    const bad = validate(state.values, ids);
    // A field that has just gone bad inside the closed Fine-tune panel (a shared
    // link's junk, say) opens it, once: closing it again is up to the user.
    for (const key of bad) if (!badBefore.has(key)) field(key).closest('details:not([open])')?.setAttribute('open', '');
    badBefore = new Set(bad);

    const open = new Set([...resultsEl.querySelectorAll('details[open]')].map((d) => d.closest('.result').dataset.id));
    const input = normalizeInputs(state.values);
    // The sale price as the engine sees it (to the cent): "0.004" is $0.
    const needsPrice = !MODES[mode].hidden.includes('price') && input.price === 0;
    pendingField = null;

    if (ids.length === 0) {
      verdictEl.className = 'verdict verdict-bad';
      verdictEl.innerHTML = '<span><strong>No marketplaces selected.</strong> Pick at least one under “Fine-tune fees”.</span>';
      resultsEl.innerHTML = '';
      renderedMode = null;
      setStale(false);
    } else if (bad.length) {
      const names = andList(bad.map((key) => `“${labelOf(key)}”`));
      showPending(`<strong>Check ${names}.</strong> Results update once ${bad.length > 1 ? 'they hold' : 'it holds'} a valid number.`, bad[0]);
    } else if (needsPrice) {
      showPending('<strong>Enter a sell price above $0</strong> to see results.', 'price');
    } else {
      setStale(false);
      renderedMode = mode;
      const rows = rankedRows(mode, rank(mode, input, ids), input.target);
      const verdict = renderVerdict(mode, rows, input);
      verdictEl.className = `verdict verdict-${verdict.tone}`;
      verdictEl.innerHTML = verdict.html;
      resultsEl.innerHTML = renderResults(mode, rows, { focus });
      for (const id of open) resultsEl.querySelector(`[data-id="${id}"] details`)?.setAttribute('open', '');
      fitResults();
    }
    if (save) {
      if (!sharedView) persist(state);
      syncUrlSoon();
    }
    announce();
  }
  const renderSoon = debounce(() => render({ save: true }), 60);

  // Figures sit beside the names unless a name no longer fits beside its
  // figure (a big amount, large text): then every figure moves under its name,
  // so the list stays even. (Without JavaScript a CSS container query does a
  // rougher version of this.)
  function fitResults() {
    resultsEl.classList.remove('stacked');
    const squeezed = [...resultsEl.querySelectorAll('.pname')].some((name) => name.scrollWidth > name.clientWidth + 1);
    resultsEl.classList.toggle('stacked', squeezed);
  }
  // Refit when the list's width changes. Next frame, not inside the callback:
  // toggling .stacked changes the list's height, and changing an observed
  // element's size from its own callback raises "ResizeObserver loop" errors.
  let fittedWidth = 0;
  new ResizeObserver(([entry]) => {
    const width = Math.round(entry.contentRect.width);
    if (width !== fittedWidth) {
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

  // ---- modes (tabs) ----

  function setMode(next, { moveFocus = false } = {}) {
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
    render();
  }

  function selectMode(next, opts) {
    setMode(next, opts);
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
      selectMode(tabs[(to + tabs.length) % tabs.length].dataset.mode, { moveFocus: true });
    });
  }

  // ---- events ----

  // Text fields render as you type; selects and checkboxes on change.
  form.addEventListener('input', (e) => {
    if (e.target.type === 'text') renderSoon();
  });
  form.addEventListener('change', (e) => {
    if (e.target.type !== 'text') render({ save: true });
  });

  // On narrow screens the results sit below the form: "See results" (and
  // Enter / Go on a phone keyboard) jumps to the verdict. On wide screens the
  // results are already beside the form, so Enter just refreshes them.
  seeResults.hidden = false;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    render({ save: true });
    // Nothing to show yet: go to the field to fix, not away from it.
    if (pendingField) return field(pendingField).focus();
    if (seeResults.offsetParent === null) return;
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    verdictEl.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
    verdictEl.focus({ preventScroll: true });
  });

  resetBtn.addEventListener('click', () => {
    storage.clear();
    for (const key of [...MAIN_KEYS, ...TUNE_KEYS]) setValue(key, DEFAULTS[key]);
    setPlatforms(ALL_IDS);
    render();
    syncUrl();
  });

  const canShare = typeof navigator.share === 'function';
  const SHARE_LABEL = shareBtn.textContent;
  let shareReset;
  if (navigator.clipboard || canShare) {
    shareBtn.hidden = false;
    shareBtn.addEventListener('click', async () => {
      const url = `${location.origin}${location.pathname}${fragment(readForm(), true)}`;
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
      // One timer, so a second click never has its message cut short by the first.
      clearTimeout(shareReset);
      shareBtn.textContent = message;
      // Screen readers don't announce a button's label changing; a status region is read out.
      shareStatus.textContent = message === SHARE_LABEL ? '' : message;
      shareReset = setTimeout(() => {
        shareBtn.textContent = SHARE_LABEL;
        shareStatus.textContent = '';
      }, 2500);
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

