// Browser tests for the calculator page: sharing, saved settings, validation,
// no-JS rendering and offline support. Needs playwright-core and Chromium:
//
//   npm i --no-save playwright-core && npm run test:e2e
//   (CHROMIUM_PATH=/path/to/chrome if Playwright's browser isn't installed)
//
// The site is built into a temporary folder (your dist/ is left alone) and a
// small built-in server serves it over http://localhost (a secure context, so
// the service worker runs). It can be switched to "down" or "slow" to test
// offline behaviour.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticHandler } from '../../scripts/serve.mjs';
import { FEES_VERIFIED, PLATFORMS } from '../../src/engine/fees.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FEE_PAGES = PLATFORMS.map((p) => `/fees/${p.id}/`);
let DIST;
const build = (env = {}) =>
  execFileSync(process.execPath, ['scripts/build.mjs', '--out', DIST, '--quiet'], { cwd: ROOT, env: { ...process.env, ...env } });

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  test('e2e (skipped: run `npm i --no-save playwright-core` first)', { skip: true }, () => {});
}

/**
 * Runs in the page: words under `root` broken across lines although they would
 * have fit. A break is fine only when the word is wider than the room the
 * layout could give it: the nearest box that isn't itself sized by a flex or
 * grid parent (so a squeezed flex/grid column doesn't excuse the split).
 * Soft hyphens, emails and links are allowed to break.
 */
function avoidableSplits(root) {
  const found = [];
  // The word's unbroken width, measured in a copy placed inside the same
  // element so it inherits every font property. An element no stylesheet
  // targets, with every property reset (inherited ones then inherit), so a
  // rule like `.x span { width: 10px }` can't reshape it.
  const naturalWidth = (el, text) => {
    const probe = document.createElement('x-probe');
    probe.style.cssText = 'all:unset;position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;text-indent:0';
    probe.textContent = text;
    el.append(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width;
  };
  const sizedByParent = (el) => /flex|grid/.test(getComputedStyle(el.parentElement).display);
  const walker = document.createTreeWalker(document.querySelector(root), NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el.getClientRects().length || el.closest('.visually-hidden, select, script, style, noscript, .site-header .brand')) continue;
    for (const word of node.textContent.matchAll(/[^\s\u00ad-]+/g)) {
      if (/[@/]/.test(word[0]) || node.textContent[word.index - 1] === '\u00ad') continue;
      const range = document.createRange();
      range.setStart(node, word.index);
      range.setEnd(node, word.index + word[0].length);
      if (new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size < 2) continue;
      // Walk up to that box, keeping the padding and borders of the boxes in
      // between (a card's own padding is room the word never had).
      let box = el;
      let inset = 0;
      const sides = (st) => ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce((sum, k) => sum + parseFloat(st[k]), 0);
      while (box.parentElement && box !== document.body && (getComputedStyle(box).display.startsWith('inline') || sizedByParent(box))) {
        if (!getComputedStyle(box).display.startsWith('inline')) inset += sides(getComputedStyle(box));
        box = box.parentElement;
      }
      const boxStyle = getComputedStyle(box);
      const room = box.clientWidth - parseFloat(boxStyle.paddingLeft) - parseFloat(boxStyle.paddingRight) - inset;
      if (naturalWidth(el, word[0]) <= room) found.push(`split word "${word[0]}"`);
    }
  }
  return [...new Set(found)];
}

/**
 * Runs in the page: how far it scrolls sideways (in px). Measured against
 * the page's own laid-out width, not clientWidth: headless hides
 * scrollbars yet keeps a gutter's room (styles.css), and clientWidth
 * doesn't count it, so up to its width of overflow would go unseen.
 */
function sideways() {
  return Math.max(0, Math.round(document.documentElement.scrollWidth - document.documentElement.getBoundingClientRect().width));
}

/**
 * Runs in the page: the note focused in place of the hidden `hidden` (see
 * keepFocus in app.js), as [its words, whether it sits right where that is,
 * whether it's in view], or what has focus instead.
 */
function focusNote(hidden) {
  const at = document.activeElement;
  if (!at.matches('.focus-note')) return [`focus on <${at.tagName.toLowerCase()} class="${at.className}">`];
  const box = at.getBoundingClientRect();
  return [at.textContent, at.nextElementSibling === document.querySelector(hidden), box.bottom > 0 && box.top < innerHeight];
}

let server;
let base;
let browser;
let serverMode = 'normal';

// The preview server's handler, plus switches to simulate a dead or very slow connection.
let handle;
async function serve(req, res) {
  if (serverMode === 'down') return req.socket.destroy();
  const isPage = !extname(new URL(req.url, 'http://localhost').pathname) || req.url.endsWith('.html');
  if (serverMode === 'slow' && isPage) await new Promise((r) => setTimeout(r, 8000));
  if (res.destroyed) return; // the browser gave up waiting
  return handle(req, res);
}

if (chromium) {
  before(async () => {
    DIST = mkdtempSync(join(tmpdir(), 'threadvet-e2e-'));
    build();
    handle = createStaticHandler(DIST);
    server = createServer(serve);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${server.address().port}`;
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  });

  after(async () => {
    await browser?.close();
    server?.closeAllConnections();
    server?.close();
    if (DIST) rmSync(DIST, { recursive: true, force: true });
  });

  // A phone's window (the default) is a phone's: its scrollbars overlay
  // the page, so the gutter kept for desktop scrollbars (styles.css) takes
  // no room, as on a real one.
  const open = async (path = '/', options = {}) => {
    const viewport = options.viewport ?? { width: 390, height: 844 };
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 800, ...options });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    if (path) await page.goto(base + path, { waitUntil: 'networkidle' });
    return { context, page, errors };
  };
  const verdict = async (page) => (await page.locator('[data-verdict]').innerText()).replace(/\s+/g, ' ');
  // A reader's browser font size setting, applied as a real default (Chrome
  // DevTools protocol) so em media queries move with it, as they would for them.
  const setTextSize = async (page, scale) => {
    if (scale === 1) return;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Page.setFontSizes', { fontSizes: { standard: Math.round(16 * scale), fixed: Math.round(13 * scale) } });
  };
  const saved = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('threadvet:settings:v2')));
  const settle = (page) => page.waitForTimeout(350);
  // A field left half-typed is judged a task after focus leaves it: this
  // waits exactly that long (a timer queued after the calculator's runs after it).
  const tick = (page) => page.evaluate(() => new Promise((r) => setTimeout(r)));
  // Counts focus leaving what `selector` matches from now on: the function
  // returned stops counting and says how often it did.
  const countLeaves = async (page, selector) => {
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      let left = 0;
      const onLeave = () => left++;
      el.addEventListener('focusout', onLeave);
      window.stopCounting = () => {
        el.removeEventListener('focusout', onLeave);
        return left;
      };
    }, selector);
    return () => page.evaluate(() => window.stopCounting());
  };
  // Keystrokes sent over the DevTools protocol, to send with a press in one
  // go (Promise.all): they reach the page in order, well inside the 60ms
  // before a keystroke's render.
  const keyEvents = (cdp, text) =>
    [...text].flatMap((ch) => {
      const key = ch === '.' ? { key: '.', code: 'Period', windowsVirtualKeyCode: 190 } : { key: ch, code: `Digit${ch}`, windowsVirtualKeyCode: 48 + Number(ch) };
      return [cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, ...key }), cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })];
    });
  // Notes how long after the last keystroke the next press began: within
  // 60ms, its render was still due.
  const notePress = (page) =>
    page.evaluate(() => {
      const note = (window.noted = {});
      const typed = () => (note.typed = performance.now());
      addEventListener('input', typed, true);
      addEventListener('pointerdown', () => {
        note.gap = performance.now() - note.typed;
        removeEventListener('input', typed, true);
      }, { capture: true, once: true });
    });
  const pressGap = (page) => page.evaluate(() => window.noted.gap);
  // Runs `attempt` (which sets its scene up, presses right after a
  // keystroke with notePress, and resolves to what it saw) until the press
  // began while the keystroke's render was still due, within the 60ms it
  // waits: a busy machine can be slower than that to send them. Three tries.
  const whileDue = async (page, attempt) => {
    for (let tries = 1; ; tries++) {
      const seen = await attempt();
      if ((await pressGap(page)) < 60) return seen;
      if (tries === 3) assert.fail('in three tries, no press began while its keystroke\'s render was due');
    }
  };
  const inAddressBar = (page, key) => page.evaluate((k) => new URLSearchParams(location.hash.slice(1)).get(k), key);
  const focusAndFlag = (page, selector) =>
    page.evaluate((sel) => [document.activeElement.id, document.querySelector(sel).getAttribute('aria-invalid')], selector);
  // A mouse press held `ms` (a person's click is ~90ms) on a box measured
  // beforehand, or on a locator measured now: focus leaves a field at the
  // press, the click comes at the release.
  const pressAt = async (page, box, ms = 90) => {
    await page.mouse.move(box.x + Math.min(20, box.width / 2), box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(ms);
    await page.mouse.up();
    await tick(page);
  };
  const slowClick = async (page, locator, ms) => {
    await locator.scrollIntoViewIfNeeded();
    await pressAt(page, await locator.boundingBox(), ms);
  };
  // A real long press at `at`: Chromium's mouse sent as a finger, held past
  // the long-press time (until the page hears the context menu event it
  // makes); `whileDown` runs then, and the finger lifts once it's done.
  // Resolves once the page has heard the lift. (Neither DevTools call
  // answers while touch is emulated, so neither is awaited; detaching the
  // sessions ends the emulation, whatever happens.)
  const realLongPress = async (page, at, whileDown = async () => {}) => {
    await page.evaluate(() => {
      const heard = (window.longPress = { id: undefined, held: false, lifted: false, done: new AbortController() });
      const opts = { capture: true, signal: heard.done.signal };
      addEventListener('pointerdown', (e) => (heard.id ??= e.pointerId), opts);
      addEventListener('contextmenu', (e) => e.pointerId === heard.id && (heard.held = true), opts);
      addEventListener('pointerup', (e) => e.pointerId === heard.id && (heard.lifted = true), opts);
    });
    const sessions = [];
    const session = async () => {
      sessions.push(await page.context().newCDPSession(page));
      return sessions.at(-1);
    };
    try {
      const [press, lift] = [await session(), await session()];
      await press.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
      press.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 }).catch(() => {});
      await page.waitForFunction(() => window.longPress.held, null, { timeout: 3000 });
      await whileDown();
      lift.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 }).catch(() => {});
      await page.waitForFunction(() => window.longPress.lifted);
    } finally {
      await Promise.all(sessions.map((session) => session.detach().catch(() => {})));
      await page.evaluate(() => window.longPress.done.abort()).catch(() => {});
    }
  };
  // Makes the page's events look as another browser sends them: `as`
  // (source text) maps an event and its real `prop` (of `proto`'s
  // prototype) to what the page reads. Resolves to what undoes every such
  // change, to call in a finally. (A string, not a function, crosses into
  // the page.)
  const dress = async (page, proto, prop, as) => {
    await page.evaluate(`(() => {
      const real = Object.getOwnPropertyDescriptor(${proto}.prototype, '${prop}');
      const as = ${as};
      Object.defineProperty(${proto}.prototype, '${prop}', { configurable: true, get() { return as(this, real.get.call(this)); } });
      (window.undress ??= []).push(() => Object.defineProperty(${proto}.prototype, '${prop}', real));
    })()`);
    return () => page.evaluate(() => {
      while (window.undress?.length) window.undress.pop()();
    });
  };

  test('results are pre-rendered without JavaScript', async () => {
    const { context, page } = await open('/', { javaScriptEnabled: false });
    assert.equal(await page.locator('.result').count(), 9);
    assert.equal(await page.locator('[role="tabpanel"]').count(), 0, 'no tab panel announced without the tabs that run it');
    assert.match(await verdict(page), /Worth it\./);
    assert.ok(await page.locator('[data-share]').isHidden());
    assert.ok(await page.locator('.see-results').isHidden());
    assert.ok(await page.locator('p', { hasText: 'Turn on JavaScript to use your own numbers' }).isVisible());
    // Enter must not submit the form: that would send the typed numbers to the server.
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));
    await page.fill('#f-price', '123');
    await page.locator('#f-price').press('Enter');
    await page.waitForTimeout(300);
    assert.equal(new URL(page.url()).search, '');
    assert.deepEqual(requests.filter((u) => u.includes('price=')), []);
    await context.close();
  });

  test('typing updates results live and keeps numbers out of requests', async () => {
    const { context, page, errors } = await open();
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));
    const live = page.locator('[data-verdict-live]');
    await page.waitForTimeout(1200);
    assert.equal(await live.textContent(), '', 'nothing is announced on page load');
    await page.fill('#f-price', '12');
    await settle(page);
    assert.match(await verdict(page), /^Pass\./);
    assert.equal(await live.textContent(), '', 'not announced while typing');
    await page.waitForTimeout(1000);
    assert.match(await live.textContent(), /^Pass\./, 'announced once typing pauses');
    assert.match(new URL(page.url()).hash, /[#&]price=12(&|$)/);
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.inputValue('#f-price'), '12', 'reload restores the numbers from the fragment');
    assert.ok(!requests.some((u) => u.split('#')[0].includes('price=')), 'typed numbers never reach the server');
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('the verdict and the list are each repainted only when what they show changes', async () => {
    // Loaded with nothing of its own, the page's built output is already
    // right: the first paint replaces nothing in it.
    const { context, page, errors } = await open(null);
    await page.addInitScript(() => {
      window.replaced = 0;
      new MutationObserver((changes) => {
        for (const c of changes) if (c.removedNodes.length && c.target.closest?.('[data-verdict], [data-results]')) window.replaced++;
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto(`${base}/`, { waitUntil: 'networkidle' });
    await settle(page);
    assert.equal(await page.evaluate(() => window.replaced), 0, 'nothing replaced at load');
    const mark = () =>
      page.evaluate(() => {
        document.querySelector('[data-verdict] > span').dataset.kept = '';
        document.querySelector('.result').dataset.kept = '';
      });
    const kept = () => page.evaluate(() => ['[data-verdict] [data-kept]', '.result[data-kept]'].map((sel) => Boolean(document.querySelector(sel))));
    const keptAfter = async (change) => {
      await mark();
      await change();
      await settle(page);
      return kept();
    };
    await page.locator('.tune > summary').click();
    await page.uncheck('input[name="platform"][value="ebay"]');
    await settle(page);
    // A hidden marketplace's option, and a price written another way: nothing.
    const hiddenOption = await keptAfter(() => page.fill('#f-ebayAdRate', '5'));
    const sameNumber = await keptAfter(async () => {
      await page.fill('#f-price', '40.00');
      await page.locator('#f-price').press('Tab');
    });
    // eBay's ad rate, eBay shown but not the best: only the list.
    await page.check('input[name="platform"][value="ebay"]');
    await settle(page);
    const listOnly = await keptAfter(() => page.fill('#f-ebayAdRate', '10'));
    // A new minimum at a price that clears none: only the verdict names it.
    await page.fill('#f-price', '15');
    await settle(page);
    const verdictOnly = await keptAfter(() => page.fill('#f-target', '11'));
    const both = await keptAfter(() => page.fill('#f-price', '41'));
    // A prompt in the verdict's place hides the list; the same result back
    // shows it as it was, under its own verdict again.
    const verdictAt41 = await verdict(page);
    const throughPrompt = await keptAfter(async () => {
      for (const price of ['', '41']) {
        await page.fill('#f-price', price);
        await page.locator('#f-price').press('Tab');
        await settle(page);
      }
    });
    assert.deepEqual(
      [hiddenOption, sameNumber, listOnly, verdictOnly, both, throughPrompt],
      [[true, true], [true, true], [true, false], [false, true], [false, false], [false, true]],
      'each kept unless what it shows changed',
    );
    assert.equal(await verdict(page), verdictAt41, 'the verdict back after the prompt');
    assert.deepEqual(errors, []);
    await context.close();
  });

  test("the first frame is the visitor's own result, and what's changed before the script runs is kept", async () => {
    // Opens `path` as a browser that paints before the script runs would
    // (one without blocking="render"), the app held back until release()
    // is called: resolves once the page has painted.
    const openPaintingFirst = async (path, { init, ...options } = {}) => {
      const opened = await open(null, options);
      await opened.page.route(`${base}${path.split('#')[0]}`, async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()).replace(' blocking="render"', '') });
      });
      let release;
      const held = new Promise((resolve) => (release = resolve));
      await opened.page.route(/\/assets\/app\.[0-9a-f]+\.js$/, async (route) => {
        await held;
        await route.continue();
      });
      if (init) await opened.page.addInitScript(init);
      await opened.page.goto(`${base}${path}`, { waitUntil: 'commit' });
      await opened.page.waitForFunction(() => performance.getEntriesByName('first-contentful-paint').length > 0);
      return { ...opened, release };
    };
    // Layout shifts while it loads (none the visitor caused), summed: a
    // link's own result, settings and fields are there from the first frame.
    const countShifts = () => {
      window.shifted = 0;
      new PerformanceObserver((list) => {
        for (const shift of list.getEntries()) if (!shift.hadRecentInput) window.shifted += shift.value;
      }).observe({ type: 'layout-shift', buffered: true });
    };
    const shiftsLoading = async (path, viewport, { paintsFirst = false } = {}) => {
      let opened;
      if (paintsFirst) {
        opened = await openPaintingFirst(path, { viewport, init: countShifts });
        opened.release();
      } else {
        opened = await open(null, { viewport });
        await opened.page.addInitScript(countShifts);
        await opened.page.goto(`${base}${path}`, { waitUntil: 'commit' });
      }
      await opened.page.waitForLoadState('networkidle');
      await settle(opened.page);
      const shifted = await opened.page.evaluate(() => window.shifted);
      assert.deepEqual(opened.errors, []);
      await opened.context.close();
      return shifted;
    };
    for (const [path, width, height] of [
      ['/#s=1&mode=profit&price=4000&cost=100&platforms=ebay,depop', 1280, 800],
      ['/#mode=maxbuy&price=60&target=10', 390, 844],
      ['/', 768, 1024],
      ['/fees/facebook/', 820, 1180],
    ]) {
      assert.equal(await shiftsLoading(path, { width, height }), 0, `${path} at ${width}x${height}: nothing shifts as it loads`);
    }
    // Where a browser paints first, the built page still moves nothing in
    // as the script runs (its buttons' room is kept until they work).
    for (const [path, width, height] of [['/', 768, 1024], ['/', 1024, 1366], ['/fees/facebook/', 820, 1180]]) {
      assert.equal(await shiftsLoading(path, { width, height }, { paintsFirst: true }), 0, `${path} at ${width}x${height}, painted before the script: nothing shifts`);
    }
    // The controls that need the script, each as seen (laid out and not
    // hidden): Fine-tune opened first, as a visitor would, for its Reset.
    const buttonsSeen = (page) =>
      page.evaluate(() => {
        document.querySelector('.tune').open = true;
        return ['.modes', '.see-results', '[data-share]', '[data-reset]'].map((sel) => document.querySelector(sel).checkVisibility({ visibilityProperty: true }));
      });
    // Typed before the script runs: kept, and taken in as the visitor's
    // own; its buttons unseen until they work.
    const typed = await openPaintingFirst('/');
    for (const [key, value] of [['price', '125'], ['cost', '30']]) {
      await typed.page.focus(`#f-${key}`);
      await typed.page.keyboard.press('Control+A');
      await typed.page.keyboard.type(value);
    }
    const before = await buttonsSeen(typed.page);
    typed.release();
    await typed.page.waitForFunction(() => new URLSearchParams(location.hash.slice(1)).get('cost') === '30', null, { timeout: 5000 });
    const linked = await open('/#price=125&cost=30');
    assert.deepEqual(
      [before, await buttonsSeen(typed.page), await typed.page.inputValue('#f-price'), await typed.page.inputValue('#f-cost'), await inAddressBar(typed.page, 'price'), await verdict(typed.page)],
      [[false, false, false, false], [true, true, true, true], '125', '30', '125', await verdict(linked.page)],
      'both kept, saved and worked out; the buttons seen once they work',
    );
    assert.deepEqual(typed.errors, []);
    await linked.context.close();
    await typed.context.close();
    // A field left before the script runs shows its comma read as a point,
    // as on any leaving; the one still being typed in (here the price,
    // needed, emptied) waits, its value as loaded standing in: no prompt,
    // nothing flagged or saved for it. Boxes and lists changed meanwhile
    // are kept too. (Set as the visitor would: the page runs nothing yet.)
    const early = await openPaintingFirst('/');
    await early.page.focus('#f-cost');
    await early.page.keyboard.press('Control+A');
    await early.page.keyboard.type('2,50');
    await early.page.focus('#f-price');
    await early.page.keyboard.press('Control+A');
    await early.page.keyboard.press('Backspace');
    await early.page.evaluate(() => {
      document.querySelector('input[name="platform"][value="ebay"]').checked = false;
      document.querySelector('#f-ebayCategory').value = 'handbags';
    });
    early.release();
    await early.page.waitForFunction(() => new URLSearchParams(location.hash.slice(1)).get('cost') === '2.50', null, { timeout: 5000 });
    await settle(early.page);
    assert.deepEqual(
      [
        await early.page.inputValue('#f-cost'),
        await early.page.inputValue('#f-price'),
        await early.page.getAttribute('#f-price', 'aria-invalid'),
        (await verdict(early.page)).startsWith('Enter'),
        await inAddressBar(early.page, 'price'),
        await early.page.isChecked('input[name="platform"][value="ebay"]'),
        await early.page.inputValue('#f-ebayCategory'),
        await early.page.locator('.result').count(),
      ],
      ['2.50', '', null, false, '40', false, 'handbags', 8],
      'left: read with a point; still typed: waiting as loaded; boxes and lists kept',
    );
    assert.deepEqual(early.errors, []);
    await early.context.close();
    // Still being typed when the script runs, '1,' waits: judged as the
    // default where the link's value is no good (unreadable, too small or
    // missing), and not kept at all where the link's mode hides the field.
    for (const [path, expected, how] of [
      ['/#price=abc', ['1,', null, false, null], "a link's unreadable price: the default stands in (the defaults' clean address), nothing flagged"],
      ['/#price=0', ['1,', null, false, null], "a link's price of 0: the default stands in"],
      ['/#price=', ['1,', null, false, null], "a link's empty price: the default stands in, no prompt"],
      ['/#mode=price&cost=8', ['40', null, false, null], 'a price the List price mode hides: as loaded, nothing changed (the link as it was)'],
    ]) {
      const waiting = await openPaintingFirst(path);
      await waiting.page.focus('#f-price');
      await waiting.page.keyboard.press('Control+A');
      await waiting.page.keyboard.type('1,');
      waiting.release();
      await waiting.page.waitForFunction(() => 'ready' in document.querySelector('[data-calc]').dataset, null, { timeout: 5000 });
      await settle(waiting.page);
      assert.deepEqual(
        [await waiting.page.inputValue('#f-price'), await waiting.page.getAttribute('#f-price', 'aria-invalid'), /^(Check|Enter)/.test(await verdict(waiting.page)), await inAddressBar(waiting.page, 'price')],
        expected,
        how,
      );
      assert.deepEqual(waiting.errors, []);
      await waiting.context.close();
    }
    // If the app never runs (a script blocker, a failed load), its buttons
    // never show: nothing that does nothing.
    const blocked = await open(null);
    await blocked.page.route(/\/assets\/app\.[0-9a-f]+\.js$/, (route) => route.abort());
    await blocked.page.goto(`${base}/`, { waitUntil: 'load' });
    assert.deepEqual(await buttonsSeen(blocked.page), [false, false, false, false], 'no app: no tabs or buttons that would do nothing');
    await blocked.context.close();
    // A link loaded while a field has focus is read as any link is: a comma
    // shown as the point it's read as.
    const pasted = await open('/');
    await pasted.page.focus('#f-cost');
    await pasted.page.evaluate(() => (location.hash = '#price=40&cost=2,50'));
    await pasted.page.waitForFunction(() => document.querySelector('#f-cost').value === '2.50', null, { timeout: 3000 });
    assert.deepEqual(pasted.errors, []);
    await pasted.context.close();
    // A control in the form hidden while it has focus (its mode or a
    // setting changed under it, by a link at load or later): a note in its
    // place says why and takes focus, in view, where the keys typed on
    // (digits, End, Home, arrows, Space) change nothing: not another field,
    // the mode or a box. Tab and Shift+Tab carry on from there. The note
    // stays while the control is hidden (gone sooner, it would move the
    // form under what's focused next), and goes when it's shown again,
    // handing focus back if it still has it.
    const notes = (page) => page.evaluate(() => [...document.querySelectorAll('.focus-note')].map((n) => n.textContent));
    // Where Tab and Shift+Tab go from the focused note, and whether it's a
    // tab stop once left (it isn't: it's no control).
    const tabsFrom = async (page) => {
      const at = () => page.evaluate(() => (({ id, name, value, textContent }) => (id ? `#${id}` : name ? `${name}=${value}` : textContent.trim()))(document.activeElement));
      await page.keyboard.press('Tab');
      const next = await at();
      await page.focus('.focus-note');
      await page.keyboard.press('Shift+Tab');
      return [next, await at(), await page.evaluate(() => document.querySelector('.focus-note').tabIndex)];
    };
    const typeOn = async (page) => {
      for (const key of ['7', 'End', 'Home', 'ArrowRight', 'ArrowLeft', 'Space', '5']) await page.keyboard.press(key);
      await settle(page);
      return page.evaluate(() => [document.querySelector('[role="tab"][aria-selected="true"]').dataset.mode, document.querySelector('#f-price').value, location.hash]);
    };
    const COST_NOTE = ['You paid: not used in Max buy mode.', true, true];
    // Max buy hides the cost.
    const hiddenAtLoad = await openPaintingFirst('/#mode=maxbuy&price=50');
    await hiddenAtLoad.page.focus('#f-cost');
    await hiddenAtLoad.page.keyboard.press('Control+A');
    await hiddenAtLoad.page.keyboard.type('3,');
    hiddenAtLoad.release();
    await hiddenAtLoad.page.waitForFunction(() => 'ready' in document.querySelector('[data-calc]').dataset, null, { timeout: 5000 });
    await settle(hiddenAtLoad.page);
    assert.deepEqual(await hiddenAtLoad.page.evaluate(focusNote, '[data-field="cost"]'), COST_NOTE, "at load: a note in the cost's place, in view");
    assert.deepEqual(await typeOn(hiddenAtLoad.page), ['maxbuy', '50', '#mode=maxbuy&price=50'], 'at load: the keys typed on change nothing');
    await hiddenAtLoad.page.keyboard.press('Shift+Tab');
    await settle(hiddenAtLoad.page);
    assert.deepEqual([await hiddenAtLoad.page.evaluate(() => document.activeElement.id), await notes(hiddenAtLoad.page)], ['f-price', [COST_NOTE[0]]], 'Shift+Tab: the field before the cost; the note stays');
    assert.deepEqual(hiddenAtLoad.errors, []);
    await hiddenAtLoad.context.close();
    const hiddenLater = await open('/');
    const to = async (mode) => {
      await hiddenLater.page.evaluate((m) => (location.hash = `#mode=${m}&price=50`), mode);
      await hiddenLater.page.waitForFunction((m) => document.querySelector('[data-field="cost"]').hidden === (m === 'maxbuy'), mode, { timeout: 3000 });
      await settle(hiddenLater.page);
    };
    // (Measured from the first field: the modes' hints above differ in length.)
    const placed = () =>
      hiddenLater.page.evaluate(() => {
        const at = (key) => document.querySelector(`[data-field="${key}"]`).getBoundingClientRect();
        return ['ship', 'label', 'target'].map((key) => [at(key).left - at('price').left, at(key).top - at('price').top]);
      });
    const fieldsAt = await placed();
    await hiddenLater.page.focus('#f-cost');
    await to('maxbuy');
    assert.deepEqual(await hiddenLater.page.evaluate(focusNote, '[data-field="cost"]'), COST_NOTE, 'by a link later: the same');
    assert.deepEqual(await placed(), fieldsAt, "the note in the cost's own place: the fields after it stay put");
    const [chosen, price, hash] = await typeOn(hiddenLater.page);
    assert.deepEqual([chosen, price, new URLSearchParams(hash.slice(1)).get('mode')], ['maxbuy', '50', 'maxbuy'], 'by a link later: the keys typed on change nothing');
    // Drawn again, the cost still hidden: the note stands, focus on it.
    await hiddenLater.page.evaluate(() => (location.hash = '#mode=maxbuy&price=60'));
    await hiddenLater.page.waitForFunction(() => document.querySelector('#f-price').value === '60', null, { timeout: 3000 });
    await settle(hiddenLater.page);
    assert.deepEqual((await hiddenLater.page.evaluate(focusNote, '[data-field="cost"]')).slice(0, 2), COST_NOTE.slice(0, 2), 'drawn again, the cost still hidden: the note stands');
    await to('profit');
    assert.deepEqual([await hiddenLater.page.evaluate(() => document.activeElement.id), await notes(hiddenLater.page)], ['f-cost', []], 'the cost shown again: focus back on it, and the note goes');
    await to('maxbuy');
    await hiddenLater.page.keyboard.press('Tab');
    await settle(hiddenLater.page);
    assert.deepEqual([await hiddenLater.page.evaluate(() => document.activeElement.id), await notes(hiddenLater.page)], ['f-ship', [COST_NOTE[0]]], 'Tab: the field after the cost; the note stays');
    await hiddenLater.page.keyboard.type('1');
    await settle(hiddenLater.page);
    assert.deepEqual(await notes(hiddenLater.page), [COST_NOTE[0]], 'typed into that field (drawn again): the note stays, so nothing moves under it');
    await to('profit');
    assert.deepEqual([await hiddenLater.page.evaluate(() => document.activeElement.id), await notes(hiddenLater.page)], ['f-ship', []], 'the cost shown again: the note goes, focus left where it is');
    // List price hides the sale price, the form's first field.
    await hiddenLater.page.focus('#f-price');
    await hiddenLater.page.evaluate(() => (location.hash = '#mode=price&cost=10'));
    await hiddenLater.page.waitForFunction(() => document.querySelector('[data-field="price"]').hidden, null, { timeout: 3000 });
    await settle(hiddenLater.page);
    assert.deepEqual(await hiddenLater.page.evaluate(focusNote, '[data-field="price"]'), ['Sell price: not used in List price mode.', true, true], 'the sale price hidden: its note');
    assert.deepEqual(await tabsFrom(hiddenLater.page), ['#f-cost', '#tab-price', -1], "from the sale price's note: Tab to the cost, Shift+Tab to the tab");
    assert.deepEqual(hiddenLater.errors, []);
    await hiddenLater.context.close();
    // Settings' controls the same way: eBay's rate field (a link changing
    // its category from custom), and Reset (a shared link, which has no
    // Reset): the view where the visitor was, and a Space changes no box.
    // (Reset's note is the last thing focusable in Fine-tune: Tab goes on
    // past it, not back to Fine-tune's first field.)
    for (const [how, prepare, hidden, says, tabs] of [
      ["eBay's rate field", async (page) => {
        await page.selectOption('#f-ebayCategory', 'custom');
        await page.focus('#f-ebayCustomRate');
      }, '[data-field="ebayCustomRate"]', 'eBay category rate: not used with this eBay category.', ['#f-ebayAdRate', '#f-ebayCategory', -1]],
      ['Reset', (page) => page.focus('[data-reset]'), '[data-reset]', 'Reset: not offered on a shared result.', ['See results', `platform=${PLATFORMS.at(-1).id}`, -1]],
    ]) {
      const settings = await open('/');
      await settings.page.locator('.tune > summary').click();
      await prepare(settings.page);
      await settings.page.locator(':focus').scrollIntoViewIfNeeded();
      const scrolledTo = await settings.page.evaluate(() => scrollY);
      await settings.page.evaluate(() => (location.hash = '#s=1&mode=profit&price=40&cost=8&ebayCategory=most'));
      await settings.page.waitForFunction((sel) => document.querySelector(sel).closest('[hidden]'), hidden, { timeout: 3000 });
      await settle(settings.page);
      const noted = await settings.page.evaluate(focusNote, hidden);
      const viewAfter = await settings.page.evaluate(() => scrollY);
      await settings.page.keyboard.press('Space'); // (it may scroll the page, as on any text)
      await settle(settings.page);
      assert.deepEqual(
        [noted, viewAfter, await settings.page.locator('.result').count()],
        [[says, true, true], scrolledTo, 9],
        `${how} hidden by a link: a note in its place, the view unmoved; a Space changes no box`,
      );
      await settings.page.focus('.focus-note');
      assert.deepEqual(await tabsFrom(settings.page), tabs, `${how}'s note: Tab and Shift+Tab carry on from its place`);
      assert.deepEqual(settings.errors, []);
      await settings.context.close();
    }
  });

  test('saved settings survive reloads and are never touched by shared links', async () => {
    const { context, page } = await open('/', { permissions: ['clipboard-read', 'clipboard-write'] });
    await page.locator('.tune > summary').click();
    await page.fill('#f-taxRate', '0');
    await page.locator('input[name=platform][value=etsy]').uncheck();
    await settle(page);
    assert.equal((await saved(page)).values.taxRate, '0');
    assert.deepEqual((await saved(page)).hidden, ['etsy'], 'only the marketplaces turned off are stored');
    assert.ok(!('whatnotRate' in (await saved(page)).values), 'untouched defaults are not stored');

    // Reloading your own page (state in the fragment) must keep saving edits.
    await page.getByRole('tab', { name: 'Max buy' }).click();
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.tune > summary').click();
    await page.fill('#f-taxRate', '5');
    await settle(page);
    assert.equal((await saved(page)).values.taxRate, '5');
    assert.ok(await page.locator('[data-shared-note]').isHidden());

    // "Copy link" reproduces the exact result for someone else...
    await page.getByRole('button', { name: 'Copy link to this result' }).click();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(link, /#s=1&/);
    assert.equal(await page.getByRole('status').filter({ hasText: 'Link copied' }).count(), 1, 'the result is announced');
    for (const key of ['taxRate=5', 'whatnotRate=8', 'tiktokRate=8', 'platforms=']) assert.ok(link.includes(key), `link spells out ${key}`);
    const mine = await verdict(page);
    const friend = await open(null);
    await friend.page.goto(link, { waitUntil: 'networkidle' });
    assert.equal(await verdict(friend.page), mine);
    assert.equal(await friend.page.locator('.result').count(), 8);
    assert.ok(await friend.page.locator('[data-shared-note]').isVisible());
    // ...and their edits never write to their own saved settings.
    await friend.page.fill('#f-price', '99');
    await settle(friend.page);
    assert.equal(await saved(friend.page), null);
    await friend.context.close();

    // Opening someone else's link in my browser leaves my settings alone.
    await page.goto(`${base}/#s=1&taxRate=9`, { waitUntil: 'networkidle' });
    assert.equal(await page.inputValue('#f-taxRate'), '9');
    assert.equal((await saved(page)).values.taxRate, '5');
    await context.close();
  });

  test('Back from a shared link returns to your own view', async () => {
    const { context, page } = await open();
    await page.goto(`${base}/#s=1&taxRate=9`);
    assert.ok(await page.locator('[data-shared-note]').isVisible());
    await page.goBack();
    await page.waitForTimeout(150);
    assert.equal(new URL(page.url()).hash, '');
    assert.ok(await page.locator('[data-shared-note]').isHidden());
    assert.equal(await page.inputValue('#f-taxRate'), '7.5');
    await context.close();
  });

  test("a marketplace's fee page always shows it, even when hidden in settings", async () => {
    const { context, page } = await open();
    await page.locator('.tune > summary').click();
    await page.locator('input[name=platform][value=grailed]').uncheck();
    await settle(page);
    await page.goto(`${base}/fees/grailed/`, { waitUntil: 'networkidle' });
    await settle(page);
    assert.equal(await page.locator('.result').first().getAttribute('data-id'), 'grailed');
    await context.close();
  });

  test('a shared link with an unknown option falls back to the default', async () => {
    const { context, page } = await open('/#s=1&ebayCategory=bogus&etsyOffsite=nope');
    assert.equal(await page.inputValue('#f-ebayCategory'), 'most');
    assert.equal(await page.inputValue('#f-etsyOffsite'), 'none');
    await context.close();
  });

  test('out-of-range and junk input is flagged once left, not silently changed', async () => {
    const { context, page } = await open();
    await page.fill('#f-cost', '-5');
    await page.locator('#f-cost').press('Tab');
    await tick(page);
    assert.equal(await page.locator('#f-cost').getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('#h-cost').innerText(), 'Enter $0 to $100,000.');
    await page.fill('#f-cost', '8,50'); // a decimal comma (all some keypads have) is read as one...
    await page.locator('#f-cost').press('Tab');
    await tick(page);
    assert.equal(await page.inputValue('#f-cost'), '8.50', '...and shown as a point once left');
    assert.equal(await page.locator('#f-cost').getAttribute('aria-invalid'), null);
    assert.equal(await page.locator('#h-cost').innerText(), 'Item cost');
    assert.match(await verdict(page), /Poshmark: \$23\.50 profit/, '$40 − $8 fee − $8.50 cost');
    await page.locator('.tune > summary').click();
    await page.fill('#f-tiktokRate', 'abc');
    await page.locator('#f-tiktokRate').press('Tab');
    await tick(page);
    assert.equal(await page.locator('#f-tiktokRate').getAttribute('aria-invalid'), 'true');
    await context.close();

    // Flagging a field as it's left moves nothing below it, even where the
    // message is longer than the hint it replaces (320px wide), so a click
    // aimed just below lands.
    const narrow = await open('/', { viewport: { width: 320, height: 700 } });
    const tune = narrow.page.locator('.tune > summary');
    const top = () => tune.evaluate((el) => el.getBoundingClientRect().top + scrollY);
    const before = await top();
    await narrow.page.fill('#f-target', '1..');
    await narrow.page.locator('#f-target').press('Tab');
    await tick(narrow.page);
    assert.equal(await narrow.page.locator('#f-target').getAttribute('aria-invalid'), 'true');
    assert.equal(await top(), before, 'nothing below the flagged field moved');
    await narrow.page.fill('#f-target', '10');
    await settle(narrow.page);
    await narrow.page.fill('#f-target', '1..');
    await tune.click({ position: { x: 24, y: 3 } });
    assert.equal(await narrow.page.locator('.tune').getAttribute('open'), '', 'the click opened Fine-tune');
    await narrow.context.close();
  });

  test('no verdict from numbers the form rejects or leaves out', async () => {
    const { context, page } = await open('/', { permissions: ['clipboard-read', 'clipboard-write'] });
    const state = () =>
      page.evaluate(() => {
        const list = document.querySelector('[data-results]');
        return { tone: document.querySelector('[data-verdict]').className, rows: list.hidden ? 0 : list.children.length, share: !document.querySelector('[data-share]').hidden };
      });
    const ebayOpen = () => page.locator('.result[data-id="ebay"] details').getAttribute('open');
    // A value is judged when the user leaves its field (Tab, here).
    const leave = async (id) => {
      await page.locator(id).press('Tab');
      await tick(page);
    };
    // Typed and left without touching the page, for fields out of sight.
    const enter = async (id, value) => {
      await page.evaluate(([sel, v]) => {
        const el = document.querySelector(sel);
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      }, [id, value]);
      await tick(page);
    };
    await page.locator('.result[data-id="ebay"] summary').click(); // a breakdown the user opened
    const live = await state();
    // Retyping a field (a moment empty, or half-typed) changes nothing until
    // the user leaves it: no flag, no prompt, nothing saved or put in a link.
    await page.evaluate(() => {
      window.cleared = 0;
      const list = document.querySelector('[data-results]');
      new MutationObserver(() => (window.cleared += list.children.length === 0 || list.hidden)).observe(list, { childList: true, attributes: true });
    });
    for (const [id, halfway, done] of [['#f-price', '', '45'], ['#f-price', '$', '$12,500'], ['#f-cost', '-', '8']]) {
      await page.fill(id, halfway);
      await page.waitForTimeout(400); // past the render and address-bar delays
      assert.equal(await page.locator(id).getAttribute('aria-invalid'), null, `"${halfway}" isn't flagged while typing`);
      assert.notEqual(await inAddressBar(page, id.slice(3)), halfway, `"${halfway}" isn't put in the address bar`);
      await page.fill(id, done);
      await settle(page);
    }
    assert.equal(await page.evaluate(() => window.cleared), 0, 'no flash of an empty list while typing');
    assert.match(await verdict(page), /^Worth it\./);
    // Share clicked with a field half-typed judges the field first: no link
    // for numbers no longer in the form. The prompt takes the results'
    // place, and focus moves from the button it hides to the prompt.
    await page.evaluate(() => navigator.clipboard.writeText('untouched'));
    await page.fill('#f-price', '4..');
    await page.getByRole('button', { name: 'Copy link to this result' }).click();
    await tick(page);
    assert.equal(await verdict(page), 'Check “Sell price”. Write it like 1,234.50.');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'untouched');
    assert.equal(await page.locator('[data-share-status]').textContent(), '');
    assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-verdict')), true);
    // Leaving a field for another window or tab isn't leaving it: the value
    // is judged when the user really leaves (focus stays on it meanwhile).
    await page.fill('#f-price', '40');
    await settle(page);
    await page.fill('#f-price', '12..');
    await page.locator('#f-price').dispatchEvent('focusout'); // what a window losing focus sends
    await tick(page);
    await settle(page);
    assert.equal(await page.locator('#f-price').getAttribute('aria-invalid'), null, 'not judged while away');
    assert.match(await verdict(page), /^Worth it\./);
    await leave('#f-price');
    assert.equal(await page.locator('#f-price').getAttribute('aria-invalid'), 'true');
    await page.fill('#f-price', '40');
    await settle(page);
    // Leaving a field whose value already shows (nothing left to judge)
    // redraws nothing, so a click on a row lands.
    await page.fill('#f-price', '45');
    await settle(page);
    await page.locator('.result[data-id="mercari"] summary').click();
    assert.equal(await page.locator('.result[data-id="mercari"] details').getAttribute('open'), '');
    assert.equal(await page.evaluate(() => document.activeElement.closest('.result')?.dataset.id), 'mercari');
    await page.locator('.result[data-id="mercari"] summary').click();
    // What is left in the field is what's judged, even when it's the value
    // the field had before (no change event): typed 4, then deleted.
    await page.fill('#f-price', '');
    await leave('#f-price');
    await page.locator('#f-price').click();
    await page.keyboard.type('4');
    await settle(page);
    assert.match(await verdict(page), /^Pass\./);
    await page.keyboard.press('Backspace');
    await leave('#f-price');
    assert.equal(await verdict(page), 'Enter a sell price to see results.');
    await settle(page);
    assert.notEqual(await inAddressBar(page, 'price'), '4');
    await page.fill('#f-price', '40');
    await settle(page);
    // Left that way, the field is flagged and a neutral prompt replaces the
    // results (no rows for numbers that were never entered), and is read out.
    const cases = [
      ['#f-cost', '-5', 'Check “You paid”. Enter $0 to $100,000.', 'true'],
      ['#f-price', 'abc', 'Check “Sell price”. Write it like 1,234.50.', 'true'],
      ['#f-price', '0,500', 'Check “Sell price”. Write it like 1,234.50.', 'true', 'a comma that could be either'],
      ['#f-price', '0.004', 'Check “Sell price”. Enter at least $0.01.', 'true'],
      ['#f-price', '', 'Enter a sell price to see results.', null, 'not typed yet: a prompt, not an error'],
    ];
    for (const [id, value, want, invalid, why] of cases) {
      await page.fill(id, value);
      await leave(id);
      assert.equal(await page.locator(id).getAttribute('aria-invalid'), invalid);
      if (!invalid) assert.equal(await page.locator('#h-price').innerText(), 'Needed to see results.');
      assert.equal(await verdict(page), want, why ?? `${id} = "${value}"`);
      assert.deepEqual(await state(), { tone: 'verdict verdict-wait', rows: 0, share: false });
      await page.waitForFunction((text) => document.querySelector('[data-verdict-live]').textContent === text, want);
      await page.fill('#f-price', '40');
      await page.fill('#f-cost', '8');
      await settle(page);
      assert.match(await verdict(page), /^Worth it\./);
      assert.deepEqual(await state(), live);
      assert.equal(await ebayOpen(), '', 'the open breakdown comes back open');
    }
    // A missing price next to a bad field: only the error is listed.
    await page.fill('#f-price', '');
    await page.fill('#f-cost', 'abc');
    await leave('#f-cost');
    assert.equal(await verdict(page), 'Check “You paid”. Write it like 1,234.50.');
    await page.fill('#f-price', '40');
    await page.fill('#f-cost', '8');
    // Enter goes to what needs fixing, not to the verdict (phones scroll there)...
    await page.fill('#f-price', '');
    await page.locator('#f-cost').press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'f-price');
    await page.fill('#f-price', '40');
    // ...even inside the Fine-tune panel after the user closed it: left
    // half-typed by closing the panel, the field is judged but the panel
    // stays as the user left it.
    await page.locator('.tune > summary').click();
    await page.fill('#f-tiktokRate', 'x');
    await page.locator('.tune > summary').click();
    await tick(page);
    assert.equal(await page.locator('#f-tiktokRate').getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('.tune').getAttribute('open'), null, 'closed by the user, it stays closed');
    await page.fill('#f-price', '41');
    await settle(page);
    assert.equal(await page.locator('.tune').getAttribute('open'), null, 'closed by the user, it stays closed while they type');
    await page.locator('#f-price').press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'f-tiktokRate', 'Enter opens it and goes to the field');
    // Several bad fields: each named with its reason.
    await page.fill('#f-cost', 'abc');
    await leave('#f-cost');
    assert.match(await verdict(page), /^Check 2 fields\. “You paid”: Write it like 1,234\.50\. “TikTok Shop fee”: Write it like 7\.5\.$/);
    // A bad value no compared marketplace reads doesn't hold results back...
    await page.fill('#f-cost', '8');
    await page.locator('input[name="platform"][value="tiktok"]').uncheck();
    assert.match(await verdict(page), /^Worth it\./, 'a bad TikTok rate with TikTok unticked');
    await page.locator('input[name="platform"][value="tiktok"]').check();
    await enter('#f-tiktokRate', '6');
    for (const box of await page.locator('input[name="platform"]').all()) if ((await box.getAttribute('value')) !== 'poshmark') await box.uncheck();
    await page.fill('#f-label', 'junk');
    await leave('#f-label');
    assert.match(await verdict(page), /^Worth it\. Best on Poshmark/, 'Poshmark buyers pay the label, so a bad label cost is ignored');
    await page.fill('#f-label', '7');
    // No marketplace picked: a prompt without the old rows, and Enter goes to the first box.
    await page.locator('input[name="platform"][value="poshmark"]').uncheck();
    assert.match(await verdict(page), /^No marketplaces selected\./);
    assert.equal((await state()).rows, 0);
    await page.locator('#f-price').press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('name')), 'platform');
    for (const box of await page.locator('input[name="platform"]').all()) await box.check();
    // ...nor does a field the mode doesn't use (cost in Max buy, price in List price).
    await page.fill('#f-cost', 'abc');
    await page.getByRole('tab', { name: 'Max buy' }).click();
    assert.match(await verdict(page), /^Pay up to /, 'Max buy ignores the cost');
    // Rows for another mode are never kept: List price reads the bad cost.
    await page.getByRole('tab', { name: 'List price' }).click();
    assert.equal(await verdict(page), 'Check “You paid”. Write it like 1,234.50.');
    assert.equal((await state()).rows, 0);
    await page.fill('#f-cost', '8');
    await enter('#f-price', 'junk'); // hidden in this mode, as if left from before
    assert.match(await verdict(page), /^List at /, 'List price ignores the sell price');
    await context.close();

    // A link that can't be worked out shows no rows (not the page's own example,
    // nor the previous link's), and a new link's bad Fine-tune field opens the panel again.
    const link = await open('/#mode=maxbuy&price=');
    assert.equal(await verdict(link.page), 'Enter a sell price to see results.');
    assert.equal(await link.page.locator('[data-results]').isHidden(), true);
    // Focus on a row stays on that row when the results are redrawn (Back,
    // or a pasted link)...
    await link.page.goto(`${base}/`, { waitUntil: 'networkidle' });
    const first = await verdict(link.page);
    await link.page.evaluate(() => {
      document.querySelector('.result[data-id="poshmark"] summary').focus(); // top of the list
      location.hash = '#price=200';
    });
    await settle(link.page);
    assert.notEqual(await verdict(link.page), first, 'redrawn for the new numbers');
    const kept = await link.page.evaluate(() => {
      const el = document.activeElement;
      const row = el.closest('.result');
      const box = el.getBoundingClientRect();
      return { row: row?.dataset.id, movedDown: [...row.parentElement.children].indexOf(row) > 2, inView: box.top >= -1 && box.bottom <= innerHeight + 1 };
    });
    assert.deepEqual(kept, { row: 'poshmark', movedDown: true, inView: true }, 'focus kept on its row, in view');
    // ...and focus in the results (or on their share button) when they go
    // moves to the prompt, in view, not to the top of the page. Focus reads
    // the prompt out, so the live region doesn't repeat it.
    for (const inside of ['.result:last-child summary', '[data-share]']) {
      await link.page.goto(`${base}/`, { waitUntil: 'networkidle' });
      await link.page.evaluate((sel) => {
        document.querySelector(sel).focus(); // scrolls down to it
        location.hash = '#s=1&mode=profit&price=';
      }, inside);
      await settle(link.page);
      assert.equal(await verdict(link.page), 'Enter a sell price to see results.');
      assert.equal(await link.page.locator('[data-results]').isHidden(), true);
      const focused = await link.page.evaluate(() => {
        const el = document.activeElement;
        const box = el.getBoundingClientRect();
        return { verdict: el.hasAttribute('data-verdict'), inView: box.top >= -1 && box.bottom <= innerHeight + 1 };
      });
      assert.deepEqual(focused, { verdict: true, inView: true }, `focus from ${inside}`);
    }
    await link.page.waitForTimeout(1200); // past the live region's delay
    assert.notEqual(await link.page.locator('[data-verdict-live]').textContent(), 'Enter a sell price to see results.', 'said once, on focus');
    await link.page.goto(`${base}/#s=1&tiktokRate=abc`);
    await settle(link.page);
    assert.equal(await link.page.locator('.tune').getAttribute('open'), '');
    await link.page.locator('.tune > summary').click();
    await link.page.evaluate(() => (location.hash = '#s=1&tiktokRate=xyz&price=50'));
    await settle(link.page);
    assert.equal(await link.page.locator('.tune').getAttribute('open'), '', 'reopened for the new link');
    await link.context.close();
  });

  test('nothing on the page moves unless the user just did something', async () => {
    // A layout shift more than half a second after the user's last key or
    // click is one they didn't cause (Chrome's Cumulative Layout Shift). Wide,
    // so the results sit beside the form, in view.
    const { context, page, errors } = await open('/', { viewport: { width: 1280, height: 900 } });
    await page.evaluate(() => {
      window.shifts = [];
      new PerformanceObserver((list) => window.shifts.push(...list.getEntries().filter((e) => !e.hadRecentInput).map((e) => e.value))).observe({ type: 'layout-shift' });
    });
    const idle = () => page.waitForTimeout(1500); // longer than any delay in the calculator
    const retype = async (id, text) => {
      await page.locator(id).click();
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      await idle(); // a field left empty mid-edit
      await page.keyboard.type(text, { delay: 40 });
      await idle();
    };
    await retype('#f-price', '45');
    await retype('#f-price', '12..');
    await page.keyboard.press('Tab'); // left half-typed: the prompt
    await idle();
    assert.equal(await verdict(page), 'Check “Sell price”. Write it like 1,234.50.');
    await retype('#f-price', '40');
    await page.keyboard.press('Tab');
    await idle();
    assert.match(await verdict(page), /^Worth it\./);
    // A long press that starts right after a keystroke, before the result
    // has caught up, isn't redrawn under: the click opens the row it began
    // on, and then the result catches up.
    const row = page.locator('.result[data-id="mercari"]');
    await row.scrollIntoViewIfNeeded();
    const box = await row.locator('summary').boundingBox();
    const before = await verdict(page);
    await page.focus('#f-price');
    await page.keyboard.press('End');
    await page.keyboard.type('0');
    await pressAt(page, box, 1300); // a slow, deliberate press
    assert.equal(await row.locator('details').getAttribute('open'), '', 'the press opened the row');
    await settle(page);
    assert.notEqual(await verdict(page), before, 'then the result for 400 shows');
    assert.equal(await inAddressBar(page, 'price'), '400');
    await idle();
    assert.deepEqual(await page.evaluate(() => window.shifts), [], 'layout shifts the user did not cause');
    assert.deepEqual(errors, []);
    await context.close();
  });

  test('a tap or click lands where it was aimed, and nothing is judged or saved that was not left', async () => {
    // A tap right after a keystroke: the list isn't redrawn under the finger
    // (touch moves focus only after the finger lifts). Tall, so the field and
    // the first row are both on screen.
    const touch = await open('/', { viewport: { width: 390, height: 1500 }, hasTouch: true, isMobile: true });
    const tp = touch.page;
    const cdp = await touch.context.newCDPSession(tp);
    const { first, midTap } = await whileDue(tp, async () => {
      await tp.fill('#f-price', '40');
      await settle(tp);
      await tp.evaluate(() => {
        for (const d of document.querySelectorAll('.result details[open]')) d.open = false;
        scrollTo(0, 0);
      });
      const row = await tp.getAttribute('.result:first-child', 'data-id');
      const box = await tp.locator(`.result[data-id="${row}"] summary`).boundingBox();
      await tp.focus('#f-price');
      await tp.keyboard.press('End');
      const point = { x: box.x + 30, y: box.y + box.height / 2 };
      await notePress(tp);
      await Promise.all([...keyEvents(cdp, '0'), cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })]); // 40 becomes 400: the order changes
      await tp.waitForTimeout(120); // longer than the result takes to catch up while typing
      await tp.keyboard.type('0'); // and typed with the other thumb, mid-press: 4000
      await tp.waitForTimeout(120);
      const seen = await tp.getAttribute('.result:first-child', 'data-id');
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await settle(tp);
      return { first: row, midTap: seen };
    });
    assert.equal(midTap, first, 'nothing moved under the finger');
    assert.deepEqual(await tp.$$eval('.result details[open]', (d) => d.map((el) => el.closest('.result').dataset.id)), [first], 'the tapped row opened');
    assert.notEqual(await tp.getAttribute('.result:first-child', 'data-id'), first, 'and the list then re-ranked for 4000');
    // A tap on the hint of the field being typed in keeps focus throughout
    // (a finger can't be starting to select it).
    await tp.fill('#f-price', '12..');
    let leaves = await countLeaves(tp, '#f-price');
    const hintBox = await tp.locator('#h-price').boundingBox();
    const tap = { x: hintBox.x + 10, y: hintBox.y + hintBox.height / 2 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [tap] });
    await tp.waitForTimeout(60);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settle(tp);
    assert.deepEqual([await leaves(), ...(await focusAndFlag(tp, '#f-price'))], [0, 'f-price', null]);
    // Keys typed with the other thumb while a finger is down wait for it too:
    // Next leaving a half-typed field, Go jumping to the verdict. So does a
    // keystroke while a second finger is down on the form, beside the first.
    const tapFirstRow = async () => {
      await tp.fill('#f-price', '40');
      await settle(tp);
      await tp.evaluate(() => {
        for (const d of document.querySelectorAll('.result details[open]')) d.open = false;
        scrollTo(0, 0);
      });
      const row = await tp.getAttribute('.result:first-child', 'data-id');
      const at = await tp.locator('.result:first-child summary').boundingBox();
      const finger = { x: at.x + 30, y: at.y + at.height / 2 };
      assert.equal(await tp.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('.result')?.dataset.id, [finger.x, finger.y]), row, 'the finger on the row');
      return { row, finger };
    };
    const openRows = () => tp.$$eval('.result details[open]', (d) => d.map((el) => el.closest('.result').dataset.id));
    const firstRow = () => tp.getAttribute('.result:first-child', 'data-id');
    const selectedTab = () => tp.locator('[role="tab"][aria-selected="true"]').textContent();
    const focusedText = () => tp.evaluate(() => document.activeElement.id || document.activeElement.textContent.trim().slice(0, 40));
    // A finger that pans the page: the browser takes it (a cancel), so no tap.
    const pan = async (from) => {
      for (let dy = 20; dy <= 160; dy += 20) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x, y: from.y - dy }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await settle(tp);
    };
    let aim = await tapFirstRow();
    await tp.fill('#f-price', '12..');
    await settle(tp);
    const listed = await verdict(tp);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [aim.finger] });
    await tp.waitForTimeout(400); // resting long enough to be a long press: focus going elsewhere still isn't its doing
    await tp.keyboard.press('Tab'); // Next
    await tick(tp); // (it's judged a task after focus leaves it: before a person's next key)
    await tp.keyboard.type('1,'); // and on into the next field, half-typed
    await tp.waitForTimeout(400); // past the address bar's wait
    const afterNext = [await verdict(tp), await inAddressBar(tp, 'price')];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settle(tp);
    assert.deepEqual(
      [afterNext, await openRows(), await verdict(tp), await tp.getAttribute('#f-price', 'aria-invalid')],
      [[listed, '12..'], [aim.row], 'Check “Sell price”. Write it like 1,234.50.', 'true'],
      'Next: judged (and saved) at once, shown once the finger lifted',
    );
    await tp.fill('#f-cost', '0');
    let afterGo;
    aim = await whileDue(tp, async () => {
      const goAim = await tapFirstRow();
      await tp.focus('#f-price');
      await tp.keyboard.press('End');
      await notePress(tp);
      await Promise.all([...keyEvents(cdp, '0'), cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [goAim.finger] })]);
      await tp.keyboard.press('Enter'); // Go
      await tp.waitForTimeout(150);
      afterGo = [await firstRow(), await tp.evaluate(() => scrollY)];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await settle(tp);
      return goAim;
    });
    assert.deepEqual([afterGo, await openRows()], [[aim.row, 0], [aim.row]], 'Go: nothing re-ranked or scrolled under the finger');
    assert.equal(await tp.evaluate(() => document.activeElement.closest('.result')?.dataset.id), aim.row, 'its tap took focus to the row (which it follows): Go dropped, not jumping away');
    aim = await tapFirstRow();
    await tp.focus('#f-price');
    await tp.keyboard.press('End');
    const formSpot = await tp.locator('[data-hint]').boundingBox(); // the mode's hint: nothing there changes
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...aim.finger, id: 0 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...aim.finger, id: 0 }, { x: formSpot.x + 10, y: formSpot.y + 5, id: 1 }] });
    await tp.keyboard.type('0');
    await tp.waitForTimeout(150);
    const twoDown = await firstRow();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settle(tp);
    assert.deepEqual([twoDown, (await firstRow()) !== aim.row], [aim.row, true], 'held for the first finger, then re-ranked for 400');
    // The second finger lifting first leaves the first one's hold.
    aim = await tapFirstRow();
    await tp.focus('#f-price');
    await tp.keyboard.press('End');
    const secondFinger = { x: formSpot.x + 10, y: formSpot.y + 5, id: 1 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...aim.finger, id: 0 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...aim.finger, id: 0 }, secondFinger] });
    await tp.keyboard.type('0');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [secondFinger] }); // the second lifts (the one named)
    await tp.waitForTimeout(400);
    const oneLeft = await firstRow();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settle(tp);
    assert.deepEqual([oneLeft, (await firstRow()) !== aim.row], [aim.row, true], 'held until the first finger lifted too');
    // Go waits even for a finger on the form side (its jump moves the
    // whole page), and goes once it lifts if focus is still in the field
    // (a tap on the field's own label keeps it there)...
    aim = await tapFirstRow();
    await tp.focus('#f-price');
    const label = await tp.locator('label[for="f-price"]').boundingBox();
    const onForm = { x: label.x + 10, y: label.y + label.height / 2 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [onForm] });
    await tp.keyboard.press('Enter');
    await tp.waitForTimeout(150);
    const goOnForm = await tp.evaluate(() => scrollY);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settle(tp);
    assert.deepEqual([goOnForm, (await tp.evaluate(() => scrollY)) > 0], [0, true], 'Go: not under the finger, then to the verdict');
    // A modifier on its own (CapsLock, say) isn't doing anything: Go still goes.
    await tapFirstRow();
    await tp.focus('#f-price');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [onForm] });
    await tp.keyboard.press('Enter');
    await tp.keyboard.press('CapsLock');
    await tp.keyboard.press('CapsLock');
    // Nor is a script's event (an extension's, say) something the user did.
    await tp.evaluate(() => {
      const box = document.querySelector('#f-price');
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settle(tp);
    assert.ok((await tp.evaluate(() => scrollY)) > 0, 'CapsLock, a script: Go went');
    // A long press holds as any finger does, its context menu (sent for
    // any long press, menu or none) changing nothing: a digit and Go typed
    // while it rests re-rank and jump only once it lifts, and then soon
    // (250ms on: it makes no click), not seconds later.
    aim = await tapFirstRow();
    let duringLong;
    await realLongPress(tp, aim.finger, async () => {
      await tp.focus('#f-price'); // back from the row (a long press takes focus, as a tap does at its lift)
      await tp.keyboard.press('End');
      await tp.keyboard.type('0'); // 400: the list re-ranks once drawn
      await tp.keyboard.press('Enter'); // Go
      await tp.waitForTimeout(150);
      duringLong = [await firstRow(), await tp.evaluate(() => scrollY)];
    });
    await tp.waitForFunction((row) => document.querySelector('.result:first-child').dataset.id !== row, aim.row, { timeout: 1000 });
    await settle(tp);
    assert.deepEqual(
      [duringLong, await tp.evaluate(() => [scrollY > 0, document.activeElement.matches('[data-verdict]')])],
      [[aim.row, 0], [true, true]],
      'a long press: nothing re-ranked or scrolled while it rested; then both, Go jumping to the verdict',
    );
    // A long press selecting words in the list, which takes focus from a
    // field left half-typed ("40," is 40. once the press is over): the same
    // numbers, so the list isn't repainted, and the words stay selected.
    aim = await tapFirstRow();
    await tp.evaluate(() => (document.querySelector('.result:first-child').dataset.kept = ''));
    await tp.focus('#f-price');
    await tp.keyboard.press('End');
    await tp.keyboard.type(',');
    let pressedWords;
    await realLongPress(tp, aim.finger, async () => (pressedWords = await tp.evaluate(() => String(getSelection()))));
    await tp.waitForTimeout(600);
    assert.deepEqual(
      [pressedWords !== '', await tp.inputValue('#f-price'), await tp.evaluate(() => [String(getSelection()), document.querySelector('.result:first-child').hasAttribute('data-kept')])],
      [true, '40.', [pressedWords, true]],
      'the field judged once it lifted; nothing repainted, the words still selected',
    );
    // A long press beside the field being typed in takes focus from it too
    // (with no mousedown to keep it), with nothing judged or saved while it
    // rests. Selecting nothing (the empty end of the label), focus comes
    // back once it lifts, unjudged. Selecting words (the label's), it left
    // the field, judged once it lifts. Selecting the hint's, that judgement
    // swaps them for the flag, so nothing is selected, and focus comes back.
    for (const [spot, at, after] of [
      ['the empty end of its label', (b) => ({ x: b.x + b.width - 4, y: b.y + b.height / 2 }), ['f-price', null, '40']],
      ["its label's words", (b) => ({ x: b.x + 8, y: b.y + b.height / 2 }), ['', 'true', '12..']],
      ["its hint's words", null, ['f-price', 'true', '12..']],
    ]) {
      await tapFirstRow(); // 40, in the address bar
      await tp.fill('#f-price', '12..');
      const box = await tp.locator(at ? 'label[for="f-price"]' : '#h-price').boundingBox();
      let resting;
      await realLongPress(tp, at ? at(box) : { x: box.x + 10, y: box.y + box.height / 2 }, async () => {
        await tp.waitForTimeout(400); // past the address bar's wait
        resting = [await tp.evaluate(() => document.activeElement.id), await inAddressBar(tp, 'price')];
      });
      await tp.waitForTimeout(700); // the press over 250ms on, then the address bar's wait
      assert.deepEqual(
        [resting, [...(await focusAndFlag(tp, '#f-price')), await inAddressBar(tp, 'price')]],
        [['', '40'], after],
        `a long press on ${spot}`,
      );
    }
    // Only a press held long takes focus with no mousedown: focus lost to
    // nothing during a tap beside the field (a keyboard's Done, here a blur
    // as it goes down) is the key's doing, judged and saved at once, and
    // stays lost. So too for a tap the page hears late, behind a long task:
    // how long a press is held counts from when the page heard it go down.
    let onHint;
    for (const late of [false, true]) {
      await tapFirstRow();
      await tp.fill('#f-price', '12..');
      const hintNow = await tp.locator('#h-price').boundingBox();
      onHint = { x: hintNow.x + 10, y: hintNow.y + hintNow.height / 2 };
      await tp.evaluate((busy) => {
        addEventListener('pointerdown', () => document.activeElement.blur(), { capture: true, once: true });
        if (busy) setTimeout(() => {
          const until = performance.now() + 400;
          while (performance.now() < until); // the tap arrives meanwhile
        });
      }, late);
      let savedMidTap;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [onHint] });
      try {
        await tp.waitForTimeout(400); // past the address bar's wait
        savedMidTap = await inAddressBar(tp, 'price');
      } finally {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      }
      await settle(tp);
      assert.deepEqual([savedMidTap, ...(await focusAndFlag(tp, '#f-price'))], ['12..', '', 'true'], `blurred during a tap${late ? ' heard late' : ''}: judged at once, focus not brought back`);
    }
    // With two fingers held long, it's the latest's: one resting on the
    // list, then one on the hint as focus goes (as a long press takes it:
    // here a blur), which then lifts without selecting anything: focus
    // comes back at once, unjudged, and the first finger still holds what
    // it's on (400 typed then re-ranks only once it lifts).
    aim = await tapFirstRow();
    await tp.fill('#f-price', '12..');
    const onList = { ...aim.finger, id: 0 };
    const beside = { ...onHint, id: 1 };
    let bothDown;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [onList] });
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [onList, beside] });
      await tp.waitForTimeout(400); // both held long
      await tp.evaluate(() => document.activeElement.blur());
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [beside] }); // the second lifts (the one named)
      await tp.waitForTimeout(400);
      bothDown = await focusAndFlag(tp, '#f-price');
      await tp.keyboard.press('Control+A');
      await tp.keyboard.type('400');
      await tp.waitForTimeout(150);
      bothDown.push(await firstRow());
    } finally {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    await settle(tp);
    assert.deepEqual([bothDown, (await firstRow()) !== aim.row], [['f-price', null, aim.row], true], 'the second finger lifted: focus back, the field unjudged, the first still holding');
    // A click naming no pointer (Safari before it sent pointer events) is
    // taken as the tap of the press under way, and the click a label passes
    // on to its field (Firefox counts it as a second click) as the same tap:
    // a tap on the label still keeps Go.
    for (const [quirk, proto, prop, as] of [
      ['no pointer named', 'PointerEvent', 'pointerId', "(e, v) => (e.type === 'click' ? undefined : v)"],
      ["the label's click passed on, counted", 'UIEvent', 'detail', "(e, v) => (e.type === 'click' && v === 0 && e.target?.id === 'f-price' ? 1 : v)"],
    ]) {
      await tapFirstRow();
      await tp.focus('#f-price');
      const undress = await dress(tp, proto, prop, as);
      try {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [onForm] });
        await tp.keyboard.press('Enter');
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await settle(tp);
      } finally {
        await undress();
      }
      assert.ok((await tp.evaluate(() => scrollY)) > 0, `${quirk}: Go went`);
    }
    // Naming no pointer, or one that pressed nothing (a browser numbering
    // its clicks its own way), a tap on a row is still a choice (Go
    // dropped), and still over at its click: what it held is drawn at once,
    // not 250ms on.
    const clicksName = (id) => dress(tp, 'PointerEvent', 'pointerId', `(e, v) => (e.type === 'click' ? ${id} : v)`);
    for (const [how, id] of [['no pointer named', undefined], ['a pointer named that pressed nothing', 1]]) {
      aim = await tapFirstRow();
      await tp.focus('#f-price');
      await tp.keyboard.press('End');
      const undress = await clicksName(id);
      let drawnAtClick;
      try {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [aim.finger] });
        await tp.keyboard.type('0'); // 400: the list re-ranks once drawn
        await tp.keyboard.press('Enter');
        await tp.waitForTimeout(150);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await tp.waitForTimeout(100);
        drawnAtClick = (await firstRow()) !== aim.row;
        await settle(tp);
      } finally {
        await undress();
      }
      assert.deepEqual([drawnAtClick, await tp.evaluate(() => document.activeElement.matches('[data-verdict]'))], [true, false], `${how}: over at its click, and a choice`);
    }
    // ...unless another press begins first: the user has moved on.
    aim = await tapFirstRow();
    await tp.focus('#f-price');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...aim.finger, id: 0 }] });
    await tp.keyboard.press('Enter');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...aim.finger, id: 0 }, secondFinger] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settle(tp);
    assert.deepEqual(await tp.evaluate(() => [scrollY, document.activeElement.matches('[data-verdict]')]), [0, false], 'Go dropped');
    // ...or the browser takes the finger to scroll the page.
    aim = await tapFirstRow();
    await tp.focus('#f-price');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [aim.finger] });
    await tp.keyboard.press('Enter');
    await pan(aim.finger);
    assert.deepEqual(await tp.evaluate(() => [document.activeElement.id, document.activeElement.matches('[data-verdict]')]), ['f-price', false], 'a pan: Go dropped');
    // ...or the finger's tap lands outside the field without moving focus
    // (Safari doesn't focus a row's summary on a tap: here its mousedown
    // is kept from doing so): it chose the row.
    aim = await tapFirstRow();
    await tp.focus('#f-price');
    await tp.evaluate(() => document.querySelector('.result summary').addEventListener('mousedown', (e) => e.preventDefault(), { once: true }));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [aim.finger] });
    await tp.keyboard.press('Enter');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settle(tp);
    assert.deepEqual([await focusedText(), await openRows()], ['f-price', [aim.row]], 'a tap on a row, focus unmoved: the row opened, Go dropped');
    await tp.evaluate(() => {
      for (const d of document.querySelectorAll('.result details[open]')) d.open = false;
    });
    // A finger rests on the first row while a digit is typed (40 becomes
    // 400: the list re-ranks once drawn) and `during` runs, then lifts:
    // [the list stayed put while it rested, and re-ranked once it lifted].
    const heldThrough = async (during) => {
      const rest = await tapFirstRow();
      await tp.focus('#f-price');
      await tp.keyboard.press('End');
      let resting;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [rest.finger] });
      try {
        await tp.keyboard.type('0');
        await during();
        await tp.waitForTimeout(150);
        resting = await firstRow();
      } finally {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      }
      await settle(tp);
      return [resting === rest.row, (await firstRow()) !== rest.row];
    };
    // A mouse's click (a laptop's trackpad) doesn't end a finger's press,
    // nor does its right click, or a key ending the mouse's press after it.
    assert.deepEqual(await heldThrough(() => tp.mouse.click(formSpot.x + 10, formSpot.y + 5)), [true, true], "held through the mouse's click (on the mode's hint: it does nothing)");
    const rightClick = async () => {
      await tp.mouse.click(onForm.x, onForm.y, { button: 'right' }); // on the field's label: focus stays in it
      await tp.keyboard.type('0');
    };
    assert.deepEqual(await heldThrough(rightClick), [true, true], "held through the mouse's right click, and the key after it");
    // Nor does the click of a mouse whose press a key already ended...
    const endedClick = async (dragged = false) => {
      await tp.mouse.move(formSpot.x + 10, formSpot.y + 5);
      await tp.mouse.down();
      await tp.keyboard.press('Escape'); // ends the mouse's press (a key does)
      if (dragged) {
        const h1Box = await tp.locator('h1').boundingBox();
        await tp.mouse.move(h1Box.x + 10, h1Box.y + 10, { steps: 4 }); // its click lands on what holds both
      }
      await tp.mouse.up(); // its click, from a pointer whose press is over
    };
    assert.deepEqual(await heldThrough(endedClick), [true, true], 'held through it too');
    // ...likewise where clicks name no pointer: it began on the mode's hint,
    // not where the finger is. Nor, naming no pointer, does a mouse's click
    // on another row (inside what the finger is on): it's the mouse's.
    const clickOnSecondRow = async () => {
      const second = await tp.locator('.result:nth-child(2) summary').boundingBox();
      await tp.mouse.click(second.x + 30, second.y + second.height / 2);
    };
    for (const [how, during] of [['a click dragged on, its press ended', () => endedClick(true)], ["a mouse's click on another row", clickOnSecondRow]]) {
      const undress = await clicksName(undefined);
      try {
        assert.deepEqual(await heldThrough(during), [true, true], `${how}, no pointer named: the finger's hold kept`);
      } finally {
        await undress();
      }
    }
    // What's judged during a hold is what was last judged, not what's
    // drawn: a fixed price emptied again waits, as it would with no finger
    // (here on the field's own label, which keeps focus in it).
    await tapFirstRow();
    await tp.fill('#f-price', '12..');
    await tp.locator('#f-price').press('Tab');
    await settle(tp);
    assert.equal(await tp.getAttribute('#f-price', 'aria-invalid'), 'true', 'flagged before the hold');
    await tp.focus('#f-price');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [onForm] });
    await tp.keyboard.press('Control+A');
    await tp.keyboard.type('4');
    await tp.waitForTimeout(150);
    await tp.keyboard.press('Backspace');
    await tp.waitForTimeout(150);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settle(tp);
    assert.deepEqual(
      [await tp.getAttribute('#f-price', 'aria-invalid'), (await verdict(tp)).startsWith('Enter a sell price'), await inAddressBar(tp, 'price')],
      [null, false, '4'],
      'emptied after a fix: not judged until left',
    );
    // Keys acting on other controls wait too: Space on a marketplace's box,
    // an arrow on the mode tabs.
    for (const [control, key] of [['input[name="platform"][value="poshmark"]', 'Space'], ['[role="tab"][aria-selected="true"]', 'ArrowRight']]) {
      aim = await tapFirstRow();
      await tp.locator(control).evaluate((el) => el.closest('details')?.setAttribute('open', '')); // where it can take focus
      const before = await verdict(tp);
      await tp.focus(control); // which may scroll it into view: the row is measured after
      await tp.locator('.result:first-child summary').scrollIntoViewIfNeeded();
      const rowNow = await tp.locator('.result:first-child summary').boundingBox();
      aim.finger = { x: rowNow.x + 30, y: rowNow.y + rowNow.height / 2 };
      assert.equal(await tp.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('.result')?.dataset.id, [aim.finger.x, aim.finger.y]), aim.row, `${key}: the finger on the row`);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [aim.finger] });
      await tp.keyboard.press(key);
      await tp.waitForTimeout(150);
      const costShown = () => tp.locator('#f-cost').isVisible();
      const midPress = [await firstRow(), await verdict(tp), await selectedTab(), await costShown()];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await settle(tp);
      assert.deepEqual(midPress, [aim.row, before, 'Profit', true], `${key}: nothing redrawn under the finger, the tabs and fields included`);
      assert.notEqual(await verdict(tp), before, `${key}: then it was`);
      // The arrow moved focus to the new tab at once (moving focus moves
      // nothing under a finger); the finger's tap then took it to the row.
      if (key === 'ArrowRight') {
        const focused = await tp.evaluate(() => document.activeElement.closest('.result')?.dataset.id ?? document.activeElement.outerHTML.slice(0, 60));
        assert.deepEqual([await selectedTab(), await costShown(), focused], ['Max buy', false, aim.row]);
      }
      if (key === 'Space') await tp.check(control);
      else await tp.getByRole('tab', { name: 'Profit' }).click();
      await tp.locator(control).evaluate((el) => el.closest('details')?.removeAttribute('open'));
    }
    // During a hold, focus follows the arrows at once, and Enter on the
    // focused tab picks that tab: twice right is List price, right then
    // Enter is Max buy, as with no finger down. (A pan ends the press: no
    // tap, so nothing else takes focus.)
    for (const [keys, mode] of [[['ArrowRight', 'ArrowRight'], 'List price'], [['ArrowRight', 'Enter'], 'Max buy']]) {
      aim = await tapFirstRow();
      await tp.focus('[role="tab"][aria-selected="true"]');
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [aim.finger] });
      for (const key of keys) await tp.keyboard.press(key);
      const focusedMidPress = await focusedText();
      await pan(aim.finger);
      assert.deepEqual([focusedMidPress, await selectedTab(), await focusedText()], [`tab-${mode === 'List price' ? 'price' : 'maxbuy'}`, mode, `tab-${mode === 'List price' ? 'price' : 'maxbuy'}`], keys.join(' then '));
      await tp.getByRole('tab', { name: 'Profit' }).click();
    }
    // A field the new mode hides, still drawn and typed into during the
    // hold: once it's hidden, focus goes to a note in its place, not
    // dropped to the page, nor into another field (which keys typed on
    // would change).
    aim = await tapFirstRow();
    await tp.focus('[role="tab"][aria-selected="true"]');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [aim.finger] });
    await tp.keyboard.press('ArrowRight'); // Max buy, which works out what you can pay
    for (let i = 0; i < 6 && (await tp.evaluate(() => document.activeElement.id)) !== 'f-cost'; i++) await tp.keyboard.press('Tab');
    await tp.keyboard.type('5');
    await pan(aim.finger);
    assert.deepEqual([await selectedTab(), await tp.evaluate(focusNote, '[data-field="cost"]')], ['Max buy', ['You paid: not used in Max buy mode.', true, true]], 'focus kept, on a note where the field was');
    await tp.getByRole('tab', { name: 'Profit' }).click();
    // Go is dropped by a tap into the field itself (placing the caret is
    // editing on), and by typing on or moving the caret after it.
    for (const after of ['a tap into the field', 'typing on', 'moving the caret']) {
      await tapFirstRow();
      await tp.focus('#f-price');
      const box = await tp.locator(after === 'a tap into the field' ? '#f-price' : 'label[for="f-price"]').boundingBox();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 10, y: box.y + box.height / 2 }] });
      await tp.keyboard.press('Enter');
      if (after === 'typing on') await tp.keyboard.type('5');
      if (after === 'moving the caret') await tp.keyboard.press('ArrowLeft');
      await tp.waitForTimeout(150);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await settle(tp);
      assert.deepEqual(await tp.evaluate(() => [document.activeElement.id, scrollY]), ['f-price', 0], `${after}: Go dropped`);
    }
    // Reset is for your own view only. A shared link loaded during a hold
    // leaves it drawn until the finger lifts, but it does nothing: saved
    // settings stay. Once it's hidden, focus on it goes to a note in its
    // place, not to the page.
    await tp.evaluate(() => document.querySelector('.tune').setAttribute('open', ''));
    await tp.fill('#f-taxRate', '9'); // a saved setting
    await tp.locator('#f-taxRate').press('Tab');
    await settle(tp);
    await tp.evaluate(() => document.querySelector('.tune').removeAttribute('open'));
    const savedBefore = await tp.evaluate(() => localStorage.getItem('threadvet:settings:v2'));
    aim = await tapFirstRow();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [aim.finger] });
    await tp.evaluate(() => (location.hash = 's=1&price=50'));
    await tp.waitForTimeout(100);
    await tp.evaluate(() => document.querySelector('.tune').setAttribute('open', ''));
    await tp.focus('[data-reset]');
    await tp.keyboard.press('Enter');
    await pan(aim.finger);
    assert.deepEqual(
      [await tp.evaluate(() => localStorage.getItem('threadvet:settings:v2')), await tp.isVisible('[data-reset]'), (await tp.evaluate(focusNote, '[data-reset]'))[1]],
      [savedBefore, false, true],
      'Reset did nothing on a shared link; hidden once drawn, its focus went to a note in its place',
    );
    // Likewise focus on the shared note's link when the note goes (back on your own view).
    await tp.focus('[data-shared-note] a');
    await tp.evaluate(() => (location.hash = ''));
    await settle(tp);
    assert.deepEqual(await tp.evaluate(() => [document.querySelector('[data-shared-note]').hidden, document.activeElement.matches('[data-verdict]')]), [true, true], "the note's link: focus to the verdict it sat over");
    // A link brought in with a bad value opens Fine-tune to show it, even
    // if a later keystroke is drawn first. Its "shared result" note waits
    // for the finger too: it would push the rows down under it.
    await tp.evaluate(() => {
      for (const d of document.querySelectorAll('.calc-input details[open]')) d.open = false;
    });
    aim = await tapFirstRow();
    const rowBefore = (await tp.locator('.result:first-child summary').boundingBox()).y;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [aim.finger] });
    await tp.evaluate(() => (location.hash = 's=1&tiktokRate=abc&price=50'));
    await tp.waitForTimeout(100);
    const rowMidPress = (await tp.locator('.result:first-child summary').boundingBox()).y;
    await tp.focus('#f-price');
    await tp.keyboard.type('5');
    await tp.waitForTimeout(150);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settle(tp);
    assert.equal(rowMidPress, rowBefore, 'the row stayed under the finger');
    assert.deepEqual(
      [await openRows(), await tp.isVisible('[data-shared-note]'), await tp.getAttribute('.tune', 'open'), await tp.getAttribute('#f-tiktokRate', 'aria-invalid')],
      [[aim.row], true, '', 'true'],
      'the tapped row opened; then the note, and Fine-tune with its bad value',
    );
    await touch.context.close();

    const { context, page } = await open('/', { viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
    // A release the page never hears (a menu or a popup took it): the
    // pointerup and click named in window.unheard are dropped before the
    // calculator sees them.
    await page.addInitScript(() => {
      window.unheard = new Set();
      for (const type of ['pointerup', 'click']) addEventListener(type, (e) => window.unheard.delete(type) && e.stopImmediatePropagation(), true);
    });
    await page.reload({ waitUntil: 'networkidle' });
    const devtools = await context.newCDPSession(page);
    const h1At = async () => {
      await page.locator('h1').scrollIntoViewIfNeeded();
      const b = await page.locator('h1').boundingBox();
      return { x: b.x + 20, y: b.y + b.height / 2 };
    };
    // A mouse or pen event on the heading (dx: that far to the right).
    const mouseAt = async (type, { dx = 0, ...extra } = {}) => {
      const at = await h1At();
      await devtools.send('Input.dispatchMouseEvent', { type, x: at.x + dx, y: at.y, clickCount: 1, ...extra });
    };
    // A real press on the heading by a mouse, pen or finger, taking focus
    // from the field (a finger's would at its release): its pointer's id.
    const pressFrom = async (pointerType, button = 'left') => {
      await page.evaluate(() => {
        window.pressedId = undefined;
        addEventListener('pointerdown', (e) => (window.pressedId = e.pointerId), { capture: true, once: true });
      });
      if (pointerType === 'touch') await devtools.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [await h1At()] });
      else await mouseAt('mousePressed', { button, pointerType });
      await page.waitForFunction(() => window.pressedId !== undefined);
      await page.evaluate(() => document.activeElement.blur());
      return page.evaluate(() => window.pressedId);
    };
    // Its release, which the page never hears (so the next press starts clean).
    const liftUnheard = async (pointerType, button = 'left') => {
      await page.evaluate(() => ['pointerup', 'click'].forEach((type) => window.unheard.add(type)));
      if (pointerType === 'touch') await devtools.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      else await mouseAt('mouseReleased', { button, pointerType });
      await page.evaluate(() => window.unheard.clear());
    };
    const shown = () => verdict(page);
    // A press at a person's speed (focus leaves the field at mousedown, the
    // click comes ~90ms later).
    const share = page.getByRole('button', { name: 'Copy link to this result' });
    // Share with the field just typed in: the link is for what it holds
    // (a decimal comma as a point)...
    await page.fill('#f-price', '2,50');
    await slowClick(page, share);
    await page.getByRole('status').filter({ hasText: 'Link copied' }).waitFor();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(new URLSearchParams(new URL(link).hash.slice(1)).get('price'), '2.50');
    assert.equal(await page.inputValue('#f-price'), '2.50', 'shown as a point once left');
    // ...and with it half-typed, nothing is copied: the prompt shows instead.
    await page.evaluate(() => navigator.clipboard.writeText('untouched'));
    await page.fill('#f-price', '12..');
    await slowClick(page, share);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'untouched');
    assert.equal(await shown(), 'Check “Sell price”. Write it like 1,234.50.');
    // A click that changes nothing repaints nothing: a word in the prompt
    // can be double-clicked (selected), not wiped by a repaint.
    await page.locator('[data-verdict] strong').dblclick({ position: { x: 10, y: 9 } }); // on "Check"
    assert.equal(await page.evaluate(() => getSelection().toString().trim()), 'Check', 'the word selected');
    await page.evaluate(() => document.querySelector('#f-cost').dispatchEvent(new Event('input', { bubbles: true }))); // a render with the same prompt
    await settle(page);
    assert.equal(await page.evaluate(() => getSelection().toString().trim()), 'Check', 'still selected after a render that changed nothing');
    // Enter takes a typed value in too: the point shows, the caret where it
    // was (before the comma, or after it, where typing goes on after the point).
    await page.fill('#f-price', '2,50');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    const entered = await page.evaluate(() => {
      const el = document.querySelector('#f-price');
      return { value: el.value, caret: [el.selectionStart, el.selectionEnd], focused: document.activeElement === el };
    });
    assert.deepEqual(entered, { value: '2.50', caret: [1, 1], focused: true });
    await page.fill('#f-price', '2,50');
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Enter');
    assert.deepEqual(
      await page.evaluate(() => {
        const el = document.querySelector('#f-price');
        return [el.value, el.selectionStart, el.selectionEnd, el.selectionDirection];
      }),
      ['2.50', 2, 4, 'backward'],
      'a selection keeps its direction',
    );
    await settle(page);
    assert.equal(await inAddressBar(page, 'price'), '2.50');
    await page.fill('#f-price', '12,');
    await page.keyboard.press('Enter');
    await page.keyboard.type('5');
    assert.equal(await page.inputValue('#f-price'), '12.5', 'the point stays when typing goes on');
    await page.fill('#f-price', '40');
    await settle(page);
    // A click on the field's own label gives it focus straight back: a
    // half-typed value isn't judged, and a usable one shows.
    let before = await shown();
    await page.evaluate(() => scrollTo(0, 0)); // the label clear of the sticky header
    const wrap = page.locator('.field:has(#f-price) .input-wrap');
    for (const [part, press] of [
      ['its label', () => slowClick(page, page.locator('label[for="f-price"]'))],
      ['its $', () => slowClick(page, page.locator('.field:has(#f-price) .affix'))],
      ['its border', async () => pressAt(page, { ...(await wrap.boundingBox()), width: 2 })],
      ['the gap above its box', async () => {
        const box = await wrap.boundingBox();
        await pressAt(page, { x: box.x + 10, y: box.y - 3, width: 20, height: 2 });
      }],
      ['a right press on its label', () => page.locator('label[for="f-price"]').click({ button: 'right' })],
      ['a click on its hint (selecting nothing)', () => slowClick(page, page.locator('#h-price'))],
      ['a right press on its hint', () => page.locator('#h-price').click({ button: 'right' })],
    ]) {
      await page.fill('#f-price', '12..');
      await press();
      await settle(page);
      assert.equal(await page.locator('#f-price').getAttribute('aria-invalid'), null, `${part}: not left, so not judged`);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'f-price');
      assert.equal(await shown(), before);
    }
    // A hint's words can be selected, dragging from past their end as usual.
    // That leaves the field, which is judged as on any leaving, and the hint
    // always says what's true of it: words selected stay selected while that
    // doesn't change them (an error still true, a value that's fine, "1,5"),
    // and go when it does (a different error, an emptied price), focus then
    // coming back to the field.
    const hintLines = (id) =>
      page.locator(`#${id} [data-live]`).evaluate((el) => {
        const r = document.createRange();
        r.selectNodeContents(el);
        const box = el.parentElement.getBoundingClientRect();
        return { lines: [...r.getClientRects()].map((b) => ({ left: b.left, right: b.right, y: b.top + b.height / 2 })), right: box.right };
      });
    const selected = () => page.evaluate(() => getSelection().toString().trim());
    const hintText = () => page.locator('#h-price [data-live]').textContent();
    const dragHint = async () => {
      const [line] = (await hintLines('h-price')).lines;
      assert.equal(await page.evaluate(([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest('#h-price')), [line.right + 6, line.y]), true, 'the drag starts on the hint');
      await page.mouse.move(line.right + 6, line.y);
      await page.mouse.down();
      await page.mouse.move(line.left + 1, line.y, { steps: 5 });
      await page.mouse.up();
      await settle(page);
      return selected();
    };
    const deselect = async () => {
      await page.evaluate(() => getSelection().removeAllRanges());
      await tick(page);
    };
    const raw = await page.context().newCDPSession(page);
    const mouse = (type, at, extra = {}) => raw.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1, ...extra });
    const hover = (at) => mouse('mouseMoved', at, { button: 'none', buttons: 0 });
    const back = () => page.evaluate(() => [document.activeElement.id, getSelection().toString()]);
    const said = () => Promise.all([page.locator('#f-price').getAttribute('aria-invalid'), hintText(), shown()]);
    // Flagged, back in, nothing edited: the error's words can be selected.
    await page.fill('#f-price', '12..');
    await page.locator('#f-price').press('Tab');
    await page.locator('#f-price').click();
    assert.equal(await dragHint(), 'Write it like 1,234.50.', "the error's words selected");
    assert.equal(await page.locator('#f-price').getAttribute('aria-invalid'), 'true');
    await deselect();
    // A flagged field is judged at every keystroke. One whose render is due
    // when a drag over the hint begins is judged after it, and with the same
    // error the words stay selected.
    const typedSaved = await whileDue(page, async () => {
      await page.fill('#f-price', '12..');
      await page.locator('#f-price').press('Tab');
      await deselect();
      await page.locator('#f-price').click();
      await page.keyboard.press('End');
      await page.keyboard.type('.');
      await settle(page);
      const saved = await inAddressBar(page, 'price');
      const [line] = (await hintLines('h-price')).lines;
      await notePress(page);
      await Promise.all([...keyEvents(raw, '.'), mouse('mousePressed', { x: line.right + 6, y: line.y })]);
      for (let x = line.right + 6; x > line.left + 1; x -= 20) await mouse('mouseMoved', { x, y: line.y }, { buttons: 1 });
      await mouse('mouseMoved', { x: line.left + 1, y: line.y }, { buttons: 1 });
      await mouse('mouseReleased', { x: line.left + 1, y: line.y });
      await settle(page);
      return saved;
    });
    assert.equal(typedSaved, '12...', 'judged (and saved) as typed');
    assert.deepEqual([await selected(), await inAddressBar(page, 'price')], ['Write it like 1,234.50.', '12....'], 'judged after it, its words still selected');
    await deselect();
    // An unflagged field's first error waits until it's left: words selected
    // in its hint meanwhile give way to it, and focus comes back.
    await page.fill('#f-price', '40');
    await settle(page);
    before = await shown();
    await page.fill('#f-price', '99999999');
    await settle(page);
    assert.deepEqual(await said(), [null, 'What it will sell for', before], 'not judged while typed');
    await dragHint();
    assert.equal(await hintText(), 'Enter $0 to $100,000.', 'judged when left');
    assert.deepEqual(await back(), ['f-price', ''], 'the words selected went, so focus came back');
    await page.fill('#f-price', '40');
    await settle(page);
    await page.fill('#f-price', ''); // emptied
    await dragHint();
    assert.equal(await verdict(page), 'Enter a sell price to see results.', 'judged');
    assert.equal(await hintText(), 'Needed to see results.', 'and its hint says so');
    assert.deepEqual(await back(), ['f-price', '']);
    await page.fill('#f-price', '40');
    await settle(page);
    before = await shown();
    await page.fill('#f-price', '1,5');
    assert.equal(await dragHint(), 'What it will sell for', "the hint's words selected");
    assert.equal(await page.inputValue('#f-price'), '1.5');
    assert.notEqual(await shown(), before, 'judged: the result for $1.50');
    assert.equal(await inAddressBar(page, 'price'), '1.5');
    await deselect();
    await page.fill('#f-price', '40');
    await settle(page);
    // A double-click on a hint word while its field has focus selects the
    // word: the first click (selecting nothing) gives focus back, the second
    // leaves again and selects.
    await page.locator('#f-price').click();
    const [wordAt] = (await hintLines('h-price')).lines;
    await page.mouse.dblclick(wordAt.left + 8, wordAt.y);
    await settle(page);
    assert.equal(await selected(), 'What', 'the word double-clicked');
    await deselect();
    // With a half-typed value the second click leaves the field: it's judged,
    // the word gives way to the error, and focus comes back.
    await page.locator('#f-price').click();
    await page.fill('#f-price', '12..');
    await page.mouse.dblclick(wordAt.left + 8, wordAt.y);
    await settle(page);
    assert.deepEqual([await hintText(), ...(await back())], ['Write it like 1,234.50.', 'f-price', '']);
    // Flagged, what the field and the prompt say stays true as it's typed:
    // another error, "needed", or nothing wrong and the results back. Only a
    // value on its way to a number waits.
    await page.fill('#f-price', '99999999');
    await settle(page);
    assert.deepEqual(await said(), ['true', 'Enter $0 to $100,000.', 'Check “Sell price”. Enter $0 to $100,000.'], 'another error');
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await settle(page);
    const needed = [null, 'Needed to see results.', 'Enter a sell price to see results.'];
    assert.deepEqual(await said(), needed, 'emptied');
    for (const onItsWay of ['1,', '0', '0.', '.']) {
      await page.keyboard.press('Control+A');
      await page.keyboard.type(onItsWay);
      await settle(page);
      assert.deepEqual(await said(), needed, `"${onItsWay}" waits: a digit more could make it a price`);
    }
    await page.keyboard.press('Control+A');
    await page.keyboard.type('4');
    await settle(page);
    assert.deepEqual((await said()).slice(0, 2), [null, 'What it will sell for'], 'usable');
    assert.equal(await page.locator('[data-results]').isVisible(), true, 'the results back');
    // A keystroke's render due when a press on the hint begins waits for it,
    // whichever the button, so the words under it aren't swapped mid-press.
    const fixUnderPress = (button) => whileDue(page, async () => {
      await page.fill('#f-price', '12..');
      await page.locator('#f-price').press('Tab');
      await page.locator('#f-price').click();
      await page.keyboard.press('Control+A');
      const at = { x: wordAt.left + 4, y: wordAt.y };
      await hover(at);
      await notePress(page);
      await Promise.all([...keyEvents(raw, '4'), mouse('mousePressed', at, { button })]); // fixes it: the hint is due back to its own words
      await page.waitForTimeout(150);
      const midPress = await hintText();
      await mouse('mouseReleased', at, { button });
      await settle(page);
      return [midPress, await hintText()];
    });
    for (const button of ['left', 'right']) {
      assert.deepEqual(await fixUnderPress(button), ['Write it like 1,234.50.', 'What it will sell for'], `${button}: due at the press, unchanged under it, then updated`);
    }
    // A right press on a row with a render due: its menu opens on the row
    // aimed at, and the list re-ranks once the press is over (250ms after
    // its release, with no move).
    const { aimed, rowAt, underMenu } = await whileDue(page, async () => {
      await page.fill('#f-price', '40');
      await settle(page);
      await page.keyboard.press('End');
      await page.evaluate(() => scrollTo(0, 0));
      const row = await page.getAttribute('.result:first-child', 'data-id');
      const rowBox = await page.locator('.result:first-child summary').boundingBox();
      const at = { x: rowBox.x + 30, y: rowBox.y + rowBox.height / 2 };
      await page.evaluate(() => addEventListener('contextmenu', (c) => (window.menuOn = c.target.closest('.result')?.dataset.id), { capture: true, once: true }));
      await notePress(page);
      await Promise.all([...keyEvents(raw, '0'), mouse('mousePressed', at, { button: 'right' })]); // 400: the order changes
      await mouse('mouseReleased', at, { button: 'right' });
      await page.waitForTimeout(150);
      const seen = await page.evaluate(() => [window.menuOn, document.querySelector('.result').dataset.id]);
      await settle(page);
      return { aimed: row, rowAt: at, underMenu: seen };
    });
    assert.deepEqual(underMenu, [aimed, aimed], 'the menu on the row aimed at, the list as it was');
    assert.notEqual(await page.getAttribute('.result:first-child', 'data-id'), aimed, 'then re-ranked for 400');
    // A press on what a render doesn't rewrite (here the field itself) holds
    // nothing back: the results keep up with typing while it lasts.
    const [ranked, rankedMidPress] = await whileDue(page, async () => {
      await page.fill('#f-price', '40');
      await settle(page);
      await page.keyboard.press('End');
      const before = await page.getAttribute('.result:first-child', 'data-id');
      const fieldBox = await page.locator('#f-price').boundingBox();
      const inField = { x: fieldBox.x + fieldBox.width - 8, y: fieldBox.y + fieldBox.height / 2 };
      await notePress(page);
      await Promise.all([...keyEvents(raw, '0'), mouse('mousePressed', inField)]);
      await page.waitForTimeout(150);
      const midPress = await page.getAttribute('.result:first-child', 'data-id');
      await mouse('mouseReleased', inField);
      await settle(page);
      return [before, midPress];
    });
    assert.notEqual(rankedMidPress, ranked, 'the list re-ranked for 400 mid-press');
    // A drag that starts on the form side holds once it reaches the results.
    const [rankedBeforeDrag, rankedMidDrag] = await whileDue(page, async () => {
      await page.fill('#f-price', '40');
      await settle(page);
      await page.keyboard.press('End');
      const modeHint = await page.locator('[data-hint]').boundingBox();
      const fromForm = { x: modeHint.x + 5, y: modeHint.y + modeHint.height / 2 };
      const before = await page.getAttribute('.result:first-child', 'data-id');
      await notePress(page);
      await Promise.all([...keyEvents(raw, '0'), mouse('mousePressed', fromForm), mouse('mouseMoved', rowAt, { buttons: 1 })]);
      await page.waitForTimeout(150);
      const midDrag = await page.getAttribute('.result:first-child', 'data-id');
      await mouse('mouseReleased', rowAt);
      await settle(page);
      await page.evaluate(() => getSelection().removeAllRanges());
      return [before, midDrag];
    });
    assert.deepEqual([rankedMidDrag, (await page.getAttribute('.result:first-child', 'data-id')) !== rankedBeforeDrag], [rankedBeforeDrag, true], 'held under the drag, then re-ranked');
    // A right press that takes focus from a half-typed field: judged once
    // the press is over, not as it goes down.
    await page.fill('#f-price', '40');
    await settle(page);
    await page.fill('#f-price', '12..');
    await settle(page);
    before = await shown();
    await mouse('mousePressed', rowAt, { button: 'right' });
    await mouse('mouseReleased', rowAt, { button: 'right' });
    await page.waitForTimeout(150);
    const leftMidPress = [await page.evaluate(() => document.activeElement.id), await shown()];
    await settle(page);
    assert.deepEqual(leftMidPress, ['', before], 'left, but not judged yet');
    assert.equal(await shown(), 'Check “Sell price”. Write it like 1,234.50.', 'judged once the press was over');
    // A press below the calculator holds a keystroke's render too: the
    // results coming back in the prompt's place would move it.
    const heading = page.locator('h2', { hasText: 'Three questions' });
    const [headAt, headMidPress] = await whileDue(page, async () => {
      await page.fill('#f-price', '');
      await page.locator('#f-price').press('Tab');
      await page.locator('#f-price').focus();
      await page.evaluate(() => scrollTo(0, 200));
      const at = await heading.boundingBox();
      const onHeading = { x: at.x + 20, y: at.y + at.height / 2 };
      await notePress(page);
      await Promise.all([...keyEvents(raw, '4'), mouse('mousePressed', onHeading)]);
      await page.waitForTimeout(150);
      const midPress = (await heading.boundingBox()).y;
      await mouse('mouseReleased', onHeading);
      await settle(page);
      return [at, midPress];
    });
    assert.deepEqual([headMidPress, (await heading.boundingBox()).y > headAt.y], [headAt.y, true], 'still under the press, then moved down by the results');
    await page.evaluate(() => scrollTo(0, 0));
    await raw.detach();
    // A Ctrl-drag over the hint selects its words as any drag does, except
    // on a Mac, where a Ctrl-click is a right click: focus stays in the field.
    await page.fill('#f-price', '40');
    await settle(page);
    await page.keyboard.down('Control');
    const ctrlDragged = await dragHint();
    await page.keyboard.up('Control');
    assert.equal(ctrlDragged, 'What it will sell for', 'a Ctrl-drag');
    await deselect();
    const mac = await open(null, { viewport: { width: 1280, height: 900 } });
    await mac.page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }));
    await mac.page.goto(base + '/', { waitUntil: 'networkidle' });
    await mac.page.fill('#f-price', '12..');
    leaves = await countLeaves(mac.page, '#f-price');
    const macWord = await mac.page.locator('#h-price [data-live]').boundingBox();
    await mac.page.keyboard.down('Control');
    await mac.page.mouse.click(macWord.x + 4, macWord.y + macWord.height / 2);
    await mac.page.keyboard.up('Control');
    await settle(mac.page);
    assert.deepEqual([await leaves(), ...(await focusAndFlag(mac.page, '#f-price'))], [0, 'f-price', null], 'a Ctrl-click on a Mac');
    assert.deepEqual(mac.errors, []);
    await mac.context.close();
    await page.bringToFront(); // (a page left behind another stops drawing)
    // On a wide screen with Fine-tune closed (as it starts), focus on the
    // shared note's link goes to the verdict it sat over when the note goes,
    // not to the page.
    await page.evaluate(() => document.querySelector('.tune').removeAttribute('open'));
    await page.evaluate(() => (location.hash = 's=1&price=50'));
    await settle(page);
    await page.focus('[data-shared-note] a');
    const liveBefore = await page.locator('[data-verdict-live]').textContent();
    await page.evaluate(() => (location.hash = ''));
    await page.waitForTimeout(1300); // past the live region's pause
    assert.deepEqual(
      [await page.evaluate(() => document.activeElement.matches('[data-verdict]')), await page.locator('[data-verdict-live]').textContent()],
      [true, liveBefore],
      "1280px: the note's link's focus to the new verdict, which focus reads out (the live region doesn't again)",
    );
    // Leaving the page writes the address bar at once, not 250ms on: Back
    // and reload find what was typed.
    // Its keystroke is worked out first, if it hadn't been yet. A page
    // hidden (a phone switching apps, which may drop it) does the same.
    for (const [value, leave] of [['45', 'pagehide'], ['46', 'hidden']]) {
      await page.fill('#f-price', value); // its render due in 60ms, its address-bar write 250ms after that
      const beforeLeaving = await inAddressBar(page, 'price');
      await page.evaluate((how) => {
        if (how === 'pagehide') return dispatchEvent(new PageTransitionEvent('pagehide'));
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        delete document.visibilityState;
      }, leave);
      assert.deepEqual([beforeLeaving !== value, await inAddressBar(page, 'price')], [true, value], `${leave}: not written yet, then as the page went`);
    }
    // A pen's tap on the hint keeps focus and judges nothing (a pen on a
    // tablet taps like a finger: moving focus would bounce its keyboard).
    await page.fill('#f-price', '12..');
    leaves = await countLeaves(page, '#f-price');
    const [penAt] = (await hintLines('h-price')).lines;
    const penCdp = await page.context().newCDPSession(page);
    for (const type of ['mousePressed', 'mouseReleased']) await penCdp.send('Input.dispatchMouseEvent', { type, x: penAt.left + 5, y: penAt.y, button: 'left', clickCount: 1, pointerType: 'pen' });
    await penCdp.detach();
    await settle(page);
    assert.deepEqual([await leaves(), ...(await focusAndFlag(page, '#f-price'))], [0, 'f-price', null], 'a pen tap on the hint');
    await page.fill('#f-price', '40');
    await settle(page);
    // A click beside a wrapped hint's short line gives focus back too.
    await page.locator('.tune > summary').click();
    await page.fill('#f-taxRate', '12..');
    await page.locator('#h-taxRate').scrollIntoViewIfNeeded();
    const tax = await hintLines('h-taxRate');
    const short = tax.lines.reduce((a, b) => (b.right < a.right ? b : a));
    const wrapped = { lines: tax.lines.length, x: short.right + 4, y: short.y, room: tax.right - short.right };
    assert.ok(wrapped.lines > 1 && wrapped.room > 8, `a wrapped hint with room beside a line: ${JSON.stringify(wrapped)}`);
    await pressAt(page, { x: wrapped.x, y: wrapped.y - 1, width: 2, height: 2 });
    await settle(page);
    assert.deepEqual([await page.evaluate(() => document.activeElement.id), await page.locator('#f-taxRate').getAttribute('aria-invalid')], ['f-taxRate', null]);
    await page.fill('#f-taxRate', '7.5');
    await page.locator('.tune > summary').click();
    await page.fill('#f-price', '40');
    await settle(page);
    await page.keyboard.press('End');
    await page.keyboard.type('0');
    await page.click('label[for="f-price"]');
    await settle(page);
    assert.notEqual(await shown(), before, 'the result for 400');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'f-price');
    // A press whose release the page never heard hands what waited for it
    // (judging the field it took focus from) to the press that follows,
    // which mustn't have the list re-ranked under it.
    await page.fill('#f-price', '40');
    await settle(page);
    // A press that took focus from the field, whose release the page never
    // heard, is over when the same mouse presses again (here without moving
    // in between: a move with no button down would end it too).
    await page.fill('#f-price', '1,5'); // read only when left
    await pressFrom('mouse');
    await liftUnheard('mouse');
    await settle(page);
    const stillDown = await page.inputValue('#f-price');
    const again = await h1At();
    await devtools.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: again.x, y: again.y, button: 'left', clickCount: 1 });
    await devtools.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: again.x, y: again.y, button: 'left', clickCount: 1 });
    await settle(page);
    assert.deepEqual([stillDown, await page.inputValue('#f-price')], ['1,5', '1.5'], 'judged once the same mouse pressed again');
    await page.fill('#f-price', '40');
    await settle(page);
    // A right press holds back a keystroke's render due when it began, like
    // any press off the form, until 250ms after its release (no click comes;
    // a menu open by then sits above the page).
    before = await shown();
    await page.focus('#f-price');
    await page.keyboard.type('1');
    await page.mouse.move(640, 20);
    await page.mouse.down({ button: 'right' });
    await page.waitForTimeout(300);
    const during = await shown();
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(100);
    const released = await shown();
    await settle(page);
    assert.deepEqual([during, released], [before, before], 'held while the button was down, and just past its release');
    assert.notEqual(await shown(), before, 'then shown, the mouse unmoved');
    // Typing "1,234" key by key shows no result for $1.20 or $1.23 on the
    // way (its comma may still separate thousands): $1 stays until $1,234.
    await page.fill('#f-price', '');
    const seen = [];
    for (const key of '1,234') {
      await page.keyboard.type(key);
      await page.waitForTimeout(150);
      seen.push(await shown());
    }
    assert.deepEqual(seen.slice(1, 4), [seen[0], seen[0], seen[0]], `no result for "1," "1,2" or "1,23": ${seen.join(' | ')}`);
    assert.match(seen[4], /\$1,174\.77/, 'the result for $1,234');
    // Tabbing off a button isn't leaving a typed field: nothing is saved.
    await page.locator('.tune > summary').click();
    // Counts saves from now on (installed once).
    const countWrites = () =>
      page.evaluate(() => {
        window.writes = 0;
        if (window.counting) return;
        window.counting = true;
        const write = Storage.prototype.setItem;
        Storage.prototype.setItem = function (...args) {
          window.writes++;
          return write.apply(this, args);
        };
      });
    await countWrites();
    await page.focus('[data-reset]');
    await page.keyboard.press('Tab');
    await tick(page);
    await settle(page);
    assert.equal(await page.evaluate(() => window.writes), 0);
    // Reset after typing into a field clears what's saved, and saves nothing back.
    await page.fill('#f-other', 'abc');
    await page.locator('[data-reset]').click();
    await tick(page);
    await settle(page);
    assert.equal(await saved(page), null, 'nothing saved after Reset');
    // A value read only once its field is left ("1,5": its comma might have
    // separated thousands) re-ranks the list after the click on a row that
    // left it, not under it.
    await page.fill('#f-price', '40');
    await settle(page);
    const second = page.locator('.result:nth-child(2)');
    const secondId = await second.getAttribute('data-id');
    await page.fill('#f-price', '1,5');
    await slowClick(page, second.locator('summary'));
    await settle(page);
    assert.equal(await page.locator(`.result[data-id="${secondId}"] details`).getAttribute('open'), '', 'the row pressed opened');
    assert.equal(await page.inputValue('#f-price'), '1.5', 'and then the field was judged');
    await page.locator(`.result[data-id="${secondId}"] summary`).click();
    // Keys don't end a press: a Shift held for a Shift-click (Windows
    // repeats its keydown), or a key held since before it.
    await page.fill('#f-price', '40');
    await settle(page);
    await page.evaluate(() => {
      document.querySelectorAll('.result details[open]').forEach((d) => (d.open = false)); // rows opened above
      getSelection().removeAllRanges(); // or Shift extends a selection from the last click (and a summary doesn't toggle)
    });
    const third = page.locator('.result:nth-child(3)');
    const id = await third.getAttribute('data-id');
    await page.focus('#f-price');
    await page.keyboard.press('End');
    await third.scrollIntoViewIfNeeded();
    const thirdBox = await third.locator('summary').boundingBox(); // measured after any scrolling
    await page.keyboard.type('0'); // 400: the order changes
    await page.mouse.move(thirdBox.x + 20, thirdBox.y + thirdBox.height / 2);
    await page.mouse.down();
    await page.keyboard.down('Shift');
    await page.evaluate(() => {
      for (const key of ['Shift', 'a']) document.dispatchEvent(new KeyboardEvent('keydown', { key, repeat: true, bubbles: true }));
    });
    await page.waitForTimeout(150);
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await tick(page);
    assert.equal(await page.locator(`.result[data-id="${id}"] details`).getAttribute('open'), '', 'the Shift-click opened its row');
    // Judging a field waits only for the press that took focus from it,
    // and only while that press lasts. (Real presses and what follows them;
    // where Chromium can't send what another browser does, a property
    // getter makes its events look so. Scripts' events change nothing.)
    const judged = () => page.locator('#f-price').getAttribute('aria-invalid').then((v) => v === 'true');
    const halfType = async () => {
      await page.fill('#f-price', '40');
      await settle(page);
      await page.fill('#f-price', '12..');
    };
    const hoverOff = (pointerType = 'mouse') => mouseAt('mouseMoved', { dx: 3, button: 'none', buttons: 0, pointerType });
    const scripted = (make) => page.evaluate(`document.querySelector('h1').dispatchEvent(${make})`);
    // A mouse press whose release the page never heard (a menu took it)
    // doesn't hold a later Tab's judgement...
    await pressFrom('mouse');
    await page.fill('#f-price', '12..');
    await page.locator('#f-price').press('Tab');
    await tick(page);
    assert.equal(await judged(), true, 'a later Tab is judged at once');
    await liftUnheard('mouse');
    // ...and one that took focus waits for its click, not a keyboard's (nor
    // anything a script sends), or ends when the mouse is seen with no
    // button down.
    await halfType();
    await pressFrom('mouse');
    await tick(page);
    assert.equal(await judged(), false, 'waits for the press');
    await scripted("new MouseEvent('click', { detail: 0, bubbles: true })");
    await scripted("new MouseEvent('click', { detail: 1, bubbles: true })");
    await scripted("new PointerEvent('pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 0, bubbles: true })");
    await scripted("new PointerEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', bubbles: true })");
    await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })));
    await tick(page);
    await tick(page);
    assert.equal(await judged(), false, "a keyboard's click, or a script's click, move, cancel or key, isn't the press's");
    await page.waitForTimeout(3200);
    assert.equal(await judged(), false, 'a mouse held still keeps its press (a slow click)');
    await hoverOff();
    await tick(page);
    assert.equal(await judged(), true, 'the mouse moving with no button down ends it');
    await liftUnheard('mouse');
    // A press ends 250ms after a release that makes no click: one whose
    // click went unheard, and a right click's (its menu, if one opens at
    // the release, sits above the page: nothing waits for it).
    for (const button of ['left', 'right']) {
      await halfType();
      await pressFrom('mouse', button);
      await page.evaluate(() => window.unheard.add('click'));
      await mouseAt('mouseReleased', { button });
      await page.evaluate(() => window.unheard.clear());
      await page.waitForTimeout(150);
      const beforeItsWait = await judged();
      await page.waitForTimeout(250);
      assert.deepEqual([beforeItsWait, await judged()], [false, true], `${button}: waits 250ms for a click; none came: over`);
    }
    // Released, a hovering pointer (a pen before its tap's click) doesn't end
    // the press: its click may still come (none does here: over 250ms on).
    await halfType();
    await pressFrom('pen');
    await page.evaluate(() => window.unheard.add('click'));
    await mouseAt('mouseReleased', { button: 'left', pointerType: 'pen' });
    await page.evaluate(() => window.unheard.clear());
    await hoverOff('pen');
    await page.waitForTimeout(50);
    const hovered = await judged();
    await page.waitForTimeout(300);
    assert.deepEqual([hovered, await judged()], [false, true], 'not over at the hover; 250ms after its release');
    // Another button pressed while the left is down (a chord, sent as a
    // move with both down, and the right one's menu) doesn't end its press.
    await halfType();
    await pressFrom('mouse');
    await mouseAt('mousePressed', { button: 'right', buttons: 3 });
    await tick(page);
    await tick(page);
    assert.equal(await judged(), false, "the right button pressed too: the left's press goes on");
    await mouseAt('mouseReleased', { button: 'right', buttons: 1 });
    await hoverOff();
    await liftUnheard('mouse');
    // A mouse's press whose release went unheard (a menu opening as it went
    // down took it) is over at another pointer's press too: a mouse is
    // rarely held down while a finger or pen presses.
    await halfType();
    await pressFrom('mouse', 'right');
    await liftUnheard('mouse', 'right');
    await devtools.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [await h1At()] });
    await devtools.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(300); // (the tap's own press is over at its click, or 250ms on)
    assert.equal(await judged(), true, "a finger's tap: the mouse's press is over");
    // ...or at a scroll with no button down (the menu closed). One with the
    // button held (scrolling a selection on) doesn't end it.
    await halfType();
    await pressFrom('mouse');
    await mouseAt('mouseWheel', { deltaX: 0, deltaY: 40, buttons: 1 });
    await page.waitForTimeout(150); // (wheel events reach the page on their own schedule)
    const scrolledHeld = await judged();
    await liftUnheard('mouse');
    await mouseAt('mouseWheel', { deltaX: 0, deltaY: 40 });
    await page.waitForTimeout(150);
    assert.deepEqual([scrolledHeld, await judged()], [false, true], 'held through a scroll with the button down; over at one with none');
    // Focus lost to nothing (a keyboard's Done, here a blur) is a long
    // press's doing only while it's held: not once the finger has lifted
    // (its click still to come), nor a mouse's, still under way after a
    // release the page never heard (a mouse moves focus only as it goes
    // down). Both began beside the field: judged at once, focus not brought back.
    const besideAt = async (sel) => {
      await page.locator(sel).scrollIntoViewIfNeeded();
      const b = await page.locator(sel).boundingBox();
      return { x: b.x + 10, y: b.y + b.height / 2 };
    };
    for (const pointerType of ['touch', 'mouse']) {
      await halfType();
      const at = await besideAt(pointerType === 'touch' ? '#h-price' : 'label[for="f-price"]');
      await page.evaluate((types) => types.forEach((type) => window.unheard.add(type)), pointerType === 'touch' ? ['click'] : ['pointerup', 'click']);
      if (pointerType === 'touch') {
        await devtools.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
        await page.waitForTimeout(300); // held long
        await devtools.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(50); // its tap's mousedown done, its 250ms wait for a click not
      } else {
        await devtools.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...at });
        await devtools.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...at });
        await page.waitForTimeout(300); // its press long under way
      }
      await page.evaluate(() => {
        window.unheard.clear();
        document.activeElement.blur();
      });
      await page.waitForTimeout(400); // past a lifted finger's wait for its click
      assert.deepEqual(await focusAndFlag(page, '#f-price'), ['', 'true'], `${pointerType}: judged at once, focus not brought back`);
      if (pointerType === 'mouse') await hoverOff();
    }
    // A finger's press ends if the browser takes it (a pan), and a finger's
    // or pen's after 3s without a word from it.
    await halfType();
    const from = await h1At();
    await pressFrom('touch');
    for (let dy = 20; dy <= 120; dy += 20) await devtools.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x, y: from.y + dy }] });
    await tick(page);
    assert.equal(await judged(), true, 'a cancelled press is over');
    await devtools.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    for (const pointerType of ['touch', 'pen']) {
      await halfType();
      await pressFrom(pointerType);
      await page.keyboard.press('KeyA'); // typed with the other hand: no end
      await tick(page);
      await tick(page);
      assert.equal(await judged(), false, `${pointerType}: waits, through a key`);
      await page.waitForFunction(() => document.querySelector('#f-price').getAttribute('aria-invalid') === 'true', null, { timeout: 3500 });
      await liftUnheard(pointerType);
    }
    // A key ends a mouse's press (it's rarely held down while typing, and a
    // key after a release the page never heard means the user moved on),
    // but not a modifier held for a click.
    await halfType();
    await pressFrom('mouse');
    await page.keyboard.press('Shift');
    await tick(page);
    await tick(page);
    assert.equal(await judged(), false, 'Shift: held for a click');
    await page.keyboard.press('KeyA');
    await tick(page);
    await tick(page);
    assert.equal(await judged(), true, 'a key: over');
    await liftUnheard('mouse');
    // A script's pointerdown (an extension's, say) starts no press: nothing
    // is held for it.
    await halfType();
    await page.evaluate(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      document.activeElement.blur();
    });
    await tick(page);
    await tick(page);
    assert.equal(await judged(), true, "a script's pointerdown: no press");
    // A refused address-bar write (Safari limits them) is made again soon after.
    await page.waitForFunction(() => new URLSearchParams(location.hash.slice(1)).get('price') === document.querySelector('#f-price').value); // earlier writes done
    await page.evaluate(() => {
      const write = history.replaceState;
      window.refused = 0;
      history.replaceState = function (...args) {
        if (window.refused++ === 0) throw new DOMException('Too many calls', 'SecurityError');
        return write.apply(this, args);
      };
    });
    await page.fill('#f-price', '987'); // a price no step above has used
    await page.waitForFunction(() => new URLSearchParams(location.hash.slice(1)).get('price') === '987', null, { timeout: 4000 });
    assert.ok(await page.evaluate(() => window.refused >= 2), 'the first write was refused, and a later one made');
    // A plain tab switch saves nothing (another open tab's settings stay)...
    await countWrites();
    await page.getByRole('tab', { name: 'List price' }).click();
    await page.getByRole('tab', { name: 'Profit' }).click();
    await settle(page);
    assert.equal(await page.evaluate(() => window.writes), 0, 'a plain tab switch saves nothing');
    // ...but one that takes in a Fine-tune value left typed saves it: one
    // held while typed, and one whose comma is then written as a point.
    for (const [typed, kept] of [['12..', '12..'], ['1,5', '1.5']]) {
      await page.getByRole('tab', { name: 'Profit' }).click();
      await page.fill('#f-other', typed);
      await page.getByRole('tab', { name: 'Max buy' }).click();
      await tick(page);
      assert.equal(await page.inputValue('#f-other'), kept);
      assert.equal((await saved(page)).values.other, kept, `"${typed}" saved`);
    }
    await context.close();
  });

  test('typing and leaving a field move nothing on the form side, and change only its hints and flags', async () => {
    // A press there (but on a hint) holds nothing back: a keystroke's
    // render or a judgement changes nothing under it. A field's flag only
    // repaints it (its border, what a screen reader is told); a hint's words
    // change in room kept for its longest.
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const { context, page, errors } = await open('/', { viewport });
      await page.locator('.tune > summary').click();
      const boxes = () =>
        page.evaluate(() =>
          [...document.querySelectorAll('.calc-input *')].map((el) => {
            if (!el.getClientRects().length) return 'not shown';
            const r = el.getBoundingClientRect();
            return [r.left + scrollX, r.top + scrollY, r.width, r.height].map(Math.round).join();
          }),
        );
      const start = await boxes();
      await page.evaluate(() => {
        const changed = (window.changed = new Set());
        const only = (r, el, name) => (r.oldValue ?? '').replace(name, '').trim() === el.className.replace(name, '').trim(); // that class and no other
        const flagOnly = (r, el) =>
          (r.attributeName === 'aria-invalid' && el.matches('input')) ||
          (r.attributeName === 'class' && el.matches('.input-wrap') && only(r, el, 'is-invalid')) ||
          (r.attributeName === 'class' && el.matches('.hint [data-live]') && only(r, el, 'hint-error'));
        new MutationObserver((records) => {
          for (const r of records) {
            const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
            if (r.type !== 'attributes' && el.closest('.hint [data-live]')) continue;
            if (r.type === 'attributes' && (el.getAttribute(r.attributeName) === r.oldValue || flagOnly(r, el))) continue;
            changed.add(`${r.type} ${r.attributeName ?? ''} ${el.outerHTML.slice(0, 80)}`);
          }
        }).observe(document.querySelector('.calc-input'), { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true });
      });
      const steps = [['price', '12..'], ['price', '400'], ['price', ''], ['price', '0.'], ['cost', '99999999'], ['cost', '5'], ['ship', '1,5'], ['taxRate', '120'], ['taxRate', '8'], ['price', '40']];
      const moved = [];
      for (const [name, value] of steps) {
        await page.fill(`#f-${name}`, value); // its keystroke's render
        await settle(page);
        if ((await boxes()).join(' ') !== start.join(' ')) moved.push(`${name}=${value} typed`);
        await page.locator(`#f-${name}`).press('Tab'); // and its judgement
        await settle(page);
        if ((await boxes()).join(' ') !== start.join(' ')) moved.push(`${name}=${value} left`);
      }
      assert.deepEqual([moved, await page.evaluate(() => [...window.changed])], [[], []], `${viewport.width}px`);
      assert.deepEqual(errors, []);
      await context.close();
    }
  });

  test('stacked tabs (large text) are a vertical tablist moved with Up/Down; side by side they are not', async () => {
    // One session crossing the switch both ways: text size up, then a wider window.
    const { context, page } = await open('/', { viewport: { width: 320, height: 800 } });
    const tablist = '[role=tablist]';
    const orientation = (value) => page.waitForFunction(([sel, v]) => document.querySelector(sel).getAttribute('aria-orientation') === v, [tablist, value]);
    const press = async (from, key) => {
      await page.getByRole('tab', { name: from }).click();
      await page.keyboard.press(key);
      return page.evaluate(() => document.activeElement.dataset.mode);
    };
    await orientation('horizontal');
    assert.equal(await press('Profit', 'ArrowDown'), 'profit', 'Down does not switch side-by-side tabs');
    assert.equal(await press('Profit', 'ArrowRight'), 'maxbuy');

    await setTextSize(page, 2);
    await orientation('vertical');
    assert.equal(await press('Profit', 'ArrowDown'), 'maxbuy');
    assert.equal(await press('Max buy', 'ArrowUp'), 'profit');
    assert.equal(await press('Profit', 'ArrowRight'), 'profit', 'Right does not switch stacked tabs');
    // The tab focus moves to is scrolled into view (only the first one showing, End).
    await page.getByRole('tab', { name: 'Profit' }).click();
    await page.evaluate(() => scrollTo(0, document.querySelector('#tab-profit').getBoundingClientRect().bottom + scrollY - innerHeight + 4));
    await page.keyboard.press('End');
    assert.deepEqual(
      await page.evaluate(() => {
        const r = document.activeElement.getBoundingClientRect();
        return [document.activeElement.dataset.mode, r.top >= 0 && r.bottom <= innerHeight + 1]; // (the least scroll can leave a fraction of a pixel)
      }),
      ['price', true],
      'End: the last tab, on screen',
    );
    // Likewise when a finger held it, once that's over: here a finger
    // resting still, its press over after 3s without a word from it. (One
    // that pans is the user scrolling: then the page isn't pulled back.)
    const held = await open('/', { viewport: { width: 320, height: 800 }, hasTouch: true });
    await setTextSize(held.page, 2);
    await held.page.waitForFunction(() => document.querySelector('[role=tablist]').getAttribute('aria-orientation') === 'vertical');
    await held.page.getByRole('tab', { name: 'Profit' }).click();
    await held.page.evaluate(() => scrollTo(0, document.querySelector('#tab-profit').getBoundingClientRect().bottom + scrollY - innerHeight + 4));
    const touch = await held.context.newCDPSession(held.page);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 60, y: 300 }] });
    await held.page.keyboard.press('End');
    const heldOff = await held.page.evaluate(() => document.activeElement.getBoundingClientRect().top > innerHeight);
    await held.page.waitForTimeout(3400);
    const onScreen = await held.page.evaluate(() => {
      const r = document.activeElement.getBoundingClientRect();
      return [document.activeElement.dataset.mode, r.top >= 0 && r.bottom <= innerHeight + 1]; // (the least scroll can leave a fraction of a pixel)
    });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    // The tablist keeps one tab stop, moved with the focus even during a
    // hold: Shift+Tab leaves it rather than landing on the old tab.
    await held.page.evaluate(() => scrollTo(0, 0));
    await held.page.getByRole('tab', { name: 'Profit' }).click();
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 60, y: 300 }] });
    await held.page.keyboard.press('ArrowDown');
    await held.page.keyboard.press('Shift+Tab');
    const leftTablist = await held.page.evaluate(() => document.activeElement.getAttribute('role') !== 'tab');
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.equal(leftTablist, true, 'Shift+Tab during a hold: out of the tablist');
    // It follows a click back to the tab drawn, too (the draw changes no
    // mode then): one tab stop, on the tab selected.
    await held.page.getByRole('tab', { name: 'Profit' }).click(); // drawn: Profit
    await held.page.waitForTimeout(100);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 60, y: 300 }] });
    await held.page.getByRole('tab', { name: 'Profit' }).focus();
    await held.page.keyboard.press('ArrowDown'); // Max buy, during the hold
    await held.page.getByRole('tab', { name: 'Profit' }).click(); // back, still during it
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await held.page.waitForTimeout(400);
    assert.deepEqual(
      await held.page.evaluate(() => [...document.querySelectorAll('[role=tab]')].map((t) => [t.dataset.mode, t.tabIndex, t.getAttribute('aria-selected')])),
      [['profit', 0, 'true'], ['maxbuy', -1, 'false'], ['price', -1, 'false']],
      'the tab stop on the tab selected',
    );
    await held.context.close();
    await page.bringToFront(); // (a page left behind another stops drawing)
    assert.deepEqual([heldOff, ...onScreen], [true, 'price', true], 'End during a hold: not scrolled under the finger, on screen once it was over');
    // With a modifier the keys are the browser's (Alt+arrows go Back and Forward).
    assert.equal(await press('Profit', 'Shift+ArrowDown'), 'profit', 'Shift+Down: not a tab move');

    await page.setViewportSize({ width: 900, height: 800 });
    await orientation('horizontal');
    assert.equal(await press('Profit', 'ArrowDown'), 'profit');
    assert.equal(await press('Profit', 'ArrowRight'), 'maxbuy');
    await context.close();
    // A tab focused under the sticky header is brought clear of it.
    const phone = await open('/', { viewport: { width: 390, height: 844 } });
    const behind = await phone.page.evaluate(() => {
      // All of the tabs behind the header (still on screen, so not scrolled to by a plain check).
      const header = document.querySelector('.site-header').getBoundingClientRect().bottom;
      const tab = document.querySelector('#tab-profit');
      scrollTo(0, tab.getBoundingClientRect().bottom + scrollY - header + 4);
      tab.focus({ preventScroll: true });
      const r = tab.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= header;
    });
    assert.equal(behind, true, 'the tabs behind the header');
    await phone.page.keyboard.press('ArrowRight');
    assert.equal(
      await phone.page.evaluate(() => {
        const r = document.activeElement.getBoundingClientRect();
        return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === document.activeElement;
      }),
      true,
      'clear of the header',
    );
    // One already in view isn't scrolled at all.
    const still = await phone.page.evaluate(() => {
      const header = document.querySelector('.site-header').getBoundingClientRect().bottom;
      scrollTo(0, document.querySelector('#tab-profit').getBoundingClientRect().top + scrollY - header - 30);
      document.querySelector('#tab-profit').focus({ preventScroll: true });
      return scrollY;
    });
    await phone.page.keyboard.press('ArrowRight');
    assert.equal(await phone.page.evaluate(() => scrollY), still, 'a tab in view: no jump');
    // Home on the first tab, focused already but behind the header: brought clear too.
    await phone.page.evaluate(() => {
      const header = document.querySelector('.site-header').getBoundingClientRect().bottom;
      const tab = document.querySelector('#tab-profit');
      tab.focus({ preventScroll: true });
      scrollTo(0, tab.getBoundingClientRect().bottom + scrollY - header + 4);
    });
    await phone.page.keyboard.press('Home');
    assert.equal(
      await phone.page.evaluate(() => {
        const r = document.activeElement.getBoundingClientRect();
        return document.activeElement.id === 'tab-profit' && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === document.activeElement;
      }),
      true,
      'Home on the focused first tab: clear of the header',
    );
    await phone.context.close();
  });

  test('keyboard: tabs use arrow keys, the skip link keeps the mode, Enter jumps to results on phones', async () => {
    const { context, page } = await open('/#mode=price');
    await page.getByRole('tab', { name: 'List price' }).focus();
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.mode), 'maxbuy');
    await page.goto(`${base}/#main`);
    await page.waitForTimeout(100);
    assert.equal(await page.locator('[aria-selected=true]').innerText(), 'Max buy');
    assert.match(new URL(page.url()).hash, /^#mode=maxbuy&/, 'the result goes back into the address bar');
    await page.getByRole('tab', { name: 'Profit' }).click();
    await page.locator('#f-price').press('Enter');
    await page.waitForTimeout(600);
    assert.ok(await page.evaluate(() => document.activeElement.hasAttribute('data-verdict')));
    await context.close();
  });

  test('calculator layout holds on small phones and with large text', async () => {
    // Long messages and every mode, on the home page and a fee page (pinned result).
    const states = ['/#mode=maxbuy&price=5', '/#mode=price&target=99999', '/#price=4000&cost=100', '/fees/facebook/#mode=maxbuy&price=5'];
    const sizes = [[320, 1], [320, 1.25], [320, 1.5], [320, 2], [320, 2.5], [330, 1.25], [360, 1.25], [360, 2.5], [390, 1], [390, 1.5], [390, 2], [414, 1], [900, 1.75], [1280, 1], [1280, 1.75]];
    for (const [width, text] of sizes) {
      const { context, page } = await open(null, { viewport: { width, height: 800 } });
      await setTextSize(page, text);
      for (const state of states) {
        await page.goto(base + state, { waitUntil: 'networkidle' });
        // Open everything (setting `open`, since a click would close an already open panel).
        await page.evaluate(() => document.querySelectorAll('.calc details').forEach((d) => (d.open = true)));
        const problems = await page.evaluate(() => {
          const found = [];
          const calc = document.querySelector('.calc');
          const box = calc.getBoundingClientRect();
          // The card hides overflow, so anything too wide would be silently cut off.
          if (calc.scrollWidth > calc.clientWidth + 1) found.push(`card content cut off (${calc.scrollWidth} > ${calc.clientWidth})`);
          const controls = '[role=tab], .input-wrap, select, [data-verdict], .result, .result .pname, .result .figure';
          for (const el of document.querySelectorAll(controls)) {
            const r = el.getBoundingClientRect();
            if (r.width && (r.right > box.right + 0.5 || r.left < box.left - 0.5)) found.push(`outside the card: ${el.className || el.tagName}`);
          }
          // Nor may any text spill out of its own box (e.g. "Marketplace" in a checkbox column)...
          for (const el of calc.querySelectorAll('label, .check, [role=tab], .pname, .figure, .result-sub, dt, dd, summary, legend, .hint')) {
            if (el.clientWidth && el.scrollWidth > el.clientWidth + 1) found.push(`text spills out: ${el.className || el.tagName} "${el.textContent.trim().slice(0, 24)}"`);
          }
          // Messages sit either beside every name or under every name, never a mix.
          const top = (el) => el.getBoundingClientRect().top;
          const msgRows = [...document.querySelectorAll('.result')].filter((r) => r.querySelector('.figure.msg'));
          const beside = (r) => top(r.querySelector('.figure')) < r.querySelector('.pname').getBoundingClientRect().bottom - 1;
          if (new Set(msgRows.map(beside)).size > 1) found.push('mixed message rows');
          // Inputs side by side line up even when one label wraps and the other doesn't.
          const fields = [...document.querySelectorAll('.fields .field')].filter((f) => f.offsetParent);
          for (const a of fields) {
            for (const b of fields) {
              const ia = a.querySelector('.input-wrap, select').getBoundingClientRect();
              const ib = b.querySelector('.input-wrap, select').getBoundingClientRect();
              if (a !== b && Math.abs(top(a) - top(b)) < 2 && Math.abs(ia.top - ib.top) > 1) found.push(`inputs out of line: ${a.dataset.field} / ${b.dataset.field}`);
            }
          }
          return [...new Set(found)];
        });
        // ...nor break a word that would have fit ("Merca/ri").
        problems.push(...(await page.evaluate(avoidableSplits, '.calc')));
        if (await page.evaluate(sideways)) problems.push('page scrolls sideways');
        assert.deepEqual(problems, [], `${width}px, text ${text * 100}%, ${state}`);
      }
      await context.close();
    }
  });

  test('icons sit on their first line, ranking rows change together, and details line up, at any text size', async () => {
    // Pseudo-element icons have no DOM box, so read them through DevTools
    // (one session and one document fetch per page).
    const iconReader = async (page) => {
      const cdp = await page.context().newCDPSession(page);
      const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
      return async (selector, type) => {
        const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector });
        const mids = [];
        for (const nodeId of nodeIds) {
          const { node } = await cdp.send('DOM.describeNode', { nodeId });
          const pseudo = (node.pseudoElements ?? []).find((p) => p.pseudoType === type);
          assert.ok(pseudo, `${selector} has no ::${type} icon`);
          const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: pseudo.backendNodeId });
          mids.push((model.border[1] + model.border[5]) / 2);
        }
        return mids;
      };
    };
    for (const width of [320, 360, 390, 414, 768, 1280]) {
      for (const text of [1, 1.25, 1.5, 2, 2.5]) {
        const { context, page } = await open(null, { viewport: { width, height: 800 } });
        await setTextSize(page, text);
        const where = `${width}px, text ${text * 100}%`;

        await page.goto(`${base}/`, { waitUntil: 'networkidle' });
        await page.locator('.result summary').first().click();
        // Icons are centred on the first line of their text: beside it, or inline
        // in narrow boxes (there only when the first word shares the icon's line).
        const icons = [['.verdict', 'before'], ['.checklist li', 'before'], ['.faq summary', 'after']];
        const iconMids = await iconReader(page);
        for (const [selector, type] of icons) {
          const mids = await iconMids(selector, type);
          const lines = await page.evaluate(
            ([sel, type]) =>
              [...document.querySelectorAll(sel)].map((el) => {
                const icon = getComputedStyle(el, `::${type}`);
                const inline = icon.display.startsWith('inline');
                const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
                let t = walker.nextNode();
                while (!t.textContent.trim()) t = walker.nextNode();
                const range = document.createRange();
                range.setStart(t, t.textContent.search(/\S/));
                range.setEnd(t, t.textContent.search(/\S/) + 1);
                const r = range.getClientRects()[0];
                return { mid: r.top + r.height / 2, top: r.top, bottom: r.bottom, inline };
              }),
            [selector, type],
          );
          lines.forEach((line, i) => {
            if (line.inline && (mids[i] < line.top || mids[i] > line.bottom)) return; // icon alone on its line
            assert.ok(Math.abs(mids[i] - line.mid) <= 1.5, `${where}: ${selector} icon ${(mids[i] - line.mid).toFixed(1)}px off its first line`);
          });
        }
        // The fee breakdown starts where the details line does (and, beside the rank badge, the name).
        const align = await page.evaluate(() => {
          const row = document.querySelector('.result');
          const left = (sel) => row.querySelector(sel).getBoundingClientRect().left;
          return { sub: left('.result-sub'), bd: left('.breakdown dl'), name: left('.pname'), rankShown: row.querySelector('.rank').offsetWidth > 0, wide: document.documentElement.clientWidth / parseFloat(getComputedStyle(document.documentElement).fontSize) > 30 };
        });
        assert.ok(Math.abs(align.bd - align.sub) <= 1, `${where}: breakdown at ${align.bd}, details line at ${align.sub}`);
        if (align.rankShown && align.wide) assert.ok(Math.abs(align.sub - align.name) <= 1, `${where}: details line at ${align.sub}, name at ${align.name}`);
        if (!align.rankShown) assert.ok(Math.abs(align.sub - align.name) <= 1, `${where}: no rank badge, yet the details line is indented`);
        if (width === 1280 && text === 1) {
          // A results list narrow for its text on a wide screen (the narrow
          // rules must not depend on the phone-width ones): no badge, no indent.
          const narrow = await page.evaluate(() => {
            document.querySelector('.results').style.width = '11em';
            const row = document.querySelector('.result');
            const left = (sel) => row.querySelector(sel).getBoundingClientRect().left;
            return { rank: row.querySelector('.rank').offsetWidth, name: left('.pname'), sub: left('.result-sub'), bd: left('.breakdown dl') };
          });
          assert.equal(narrow.rank, 0, `${where}, 11em results list: rank badge hidden`);
          for (const x of [narrow.sub, narrow.bd]) assert.ok(Math.abs(x - narrow.name) <= 1, `${where}, 11em results list: indented ${x - narrow.name}px`);
        }

        // Fee-page ranking: every row has its amount beside the name or every row under it,
        // and a shown rank number shares the name's first line.
        await page.goto(`${base}/fees/facebook/`, { waitUntil: 'networkidle' });
        // Every ranked result shows its rank: the badge, or (badges hidden by very
        // large text) a rank tag or its Best tag, never the badge and a rank tag;
        // the pinned, out-of-order row included.
        const rankShown = async (state) => {
          const shown = await page.evaluate(() =>
            [...document.querySelectorAll('.result')].map((row) => ({
              ranked: row.querySelector('.rank').textContent !== '\u2013',
              badge: row.querySelector('.rank').offsetWidth > 0,
              rankTag: row.querySelector('.tag-rank')?.offsetWidth > 0,
              bestTag: row.querySelector('.tag-best')?.offsetWidth > 0,
            })),
          );
          const ranked = shown.filter((r) => r.ranked);
          assert.ok(ranked.length > 0, `${where}, ${state}: no ranked results to check`);
          for (const row of ranked) {
            assert.ok(row.badge ? !row.rankTag : row.rankTag || row.bestTag, `${where}, ${state}: rank shown ${row.badge ? 'twice' : 'nowhere'}`);
          }
        };
        await rankShown('fee page');
        // Pinned rows aside, the top row without a Best badge (a loss) needs its rank tag too.
        await page.goto(`${base}/fees/facebook/#price=10&cost=50`, { waitUntil: 'networkidle' });
        assert.match(await verdict(page), /^Pass\./, `${where}: the loss state was reached`);
        assert.equal(await page.locator('.result.is-best').count(), 0);
        await rankShown('a loss everywhere');
        await page.goto(`${base}/fees/facebook/`, { waitUntil: 'networkidle' });
        const rows = await page.evaluate(() =>
          [...document.querySelectorAll('.compare li')].map((li) => {
            const name = li.querySelector('a, strong').getClientRects()[0];
            const rank = li.querySelector('.cmp-rank').getBoundingClientRect();
            return { under: li.querySelector('.num').getBoundingClientRect().top >= name.bottom - 1, rankShown: rank.width > 1, rankTop: rank.top, nameTop: name.top };
          }),
        );
        assert.equal(new Set(rows.map((r) => r.under)).size, 1, `${where}: some amounts beside their names, some under`);
        for (const r of rows) if (r.rankShown) assert.ok(Math.abs(r.rankTop - r.nameTop) <= 2, `${where}: a rank number off its name's line`);
        await context.close();
      }
    }
  });

  test('Windows High Contrast keeps every state visible, and focus rings win over states', async () => {
    const styleOf = (page, selector) =>
      page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const st = getComputedStyle(el);
        const outline = st.outlineStyle !== 'none' && parseFloat(st.outlineWidth) > 0 && !/rgba\(.*, 0\)$/.test(st.outlineColor);
        return {
          outline,
          outlineStyle: st.outlineStyle,
          outlineWidth: parseFloat(st.outlineWidth),
          outlineOffset: parseFloat(st.outlineOffset),
          outlineColor: st.outlineColor,
          underline: st.textDecorationLine.includes('underline'),
          border: parseFloat(st.borderTopWidth),
          borderStyle: st.borderTopStyle,
        };
      }, selector);
    const get = async (page, selector) => {
      const st = await styleOf(page, selector);
      assert.ok(st, `no element matches ${selector}`);
      return st;
    };
    // Forced colors drop backgrounds and shadows: each state is drawn with a line
    // that the plain version of the same element doesn't have.
    const { context, page } = await open(null, { viewport: { width: 1280, height: 900 }, forcedColors: 'active' });
    await page.goto(`${base}/fees/facebook/`, { waitUntil: 'networkidle' });
    await page.fill('#f-label', 'abc'); // an invalid field, left
    await page.focus('#f-price');
    await settle(page);
    const invalid = await get(page, '.input-wrap:has(#f-label)');
    assert.ok(invalid.outline && invalid.outlineStyle === 'double', `invalid field: a double line, unlike a focus ring: ${JSON.stringify(invalid)}`);
    await page.fill('#f-label', '7');
    await page.focus('#f-price');
    await settle(page);
    const plainRow = '.result:not(.is-best):not(.is-focus)';
    const states = [
      ['focused field', '.input-wrap:has(#f-price)', '.input-wrap:has(#f-cost)', 'outline'],
      ['selected tab', '[role=tab][aria-selected=true]', '[role=tab][aria-selected=false]', 'underline'],
      ['current page link', '.site-header nav a[aria-current]', '.site-header nav a:not([aria-current])', 'underline'],
      ["this page's row in the fee list", '.compare .is-current', '.compare li:not(.is-current)', 'outline'],
      ['Best tag', '.tag-best', '.pname', 'outline'],
      ["the pinned row's This page tag", '.result.is-focus .tag-page', '.pname', 'outline'],
      ['rank badge', '.rank', '.pname', 'outline'],
    ];
    for (const [state, on, off, line] of states) {
      assert.deepEqual([(await get(page, on))[line], (await get(page, off))[line]], [true, false], state);
    }
    // Row states, shaped so none passes for a focus ring: Best is a thick
    // border; the pinned row has only its tag (no line of its own).
    const plain = await get(page, plainRow);
    const best = await get(page, '.result.is-best');
    assert.ok(best.border >= plain.border + 2 && !best.outline, `Best result: a thick border, no ring: ${JSON.stringify(best)}`);
    const icon = await page.evaluate(() => getComputedStyle(document.querySelector('.verdict'), '::before').outlineStyle);
    assert.equal(icon, 'solid', 'the verdict icon keeps its circle');
    const pinned = await get(page, '.result.is-focus');
    assert.ok(!pinned.outline && !plain.outline && pinned.border === plain.border, `pinned result: no line of its own: ${JSON.stringify(pinned)}`);
    // ...and neither moves a row, or anything in it.
    const places = await page.evaluate(() =>
      [...document.querySelectorAll('.result')].map((row) => {
        const name = row.querySelector('.pname').getBoundingClientRect();
        const box = row.getBoundingClientRect();
        return { inRow: `${Math.round(name.left - box.left)},${Math.round(name.top - box.top)}`, left: Math.round(name.left), width: Math.round(box.width) };
      }),
    );
    for (const key of ['inRow', 'left', 'width']) assert.equal(new Set(places.map((p) => p[key])).size, 1, `rows differ in ${key}: ${JSON.stringify(places)}`);
    // A focused row's ring sits inside on every side, clear of even a Best row's
    // thick border and within the padding (off the contents).
    await page.keyboard.press('Tab'); // keyboard use, so programmatic focus counts as :focus-visible
    const ring = await page.evaluate(() => {
      const row = document.querySelector('.result.is-best');
      const summary = row.querySelector('summary');
      summary.focus();
      const st = getComputedStyle(summary);
      const r = row.getBoundingClientRect();
      const b = summary.getBoundingClientRect();
      const offset = parseFloat(st.outlineOffset);
      const width = parseFloat(st.outlineWidth);
      const edges = { top: b.top - r.top, right: r.right - b.right, bottom: r.bottom - b.bottom, left: b.left - r.left };
      const sides = ['top', 'right', 'bottom', 'left'];
      return {
        visible: summary.matches(':focus-visible'),
        width,
        clearOfBorder: Math.min(...sides.map((side) => edges[side] - offset - width - parseFloat(getComputedStyle(row)[`border${side[0].toUpperCase()}${side.slice(1)}Width`]))),
        clearOfContent: Math.min(...sides.map((side) => parseFloat(st[`padding${side[0].toUpperCase()}${side.slice(1)}`]) + offset)),
      };
    });
    assert.ok(ring.visible && ring.width >= 3 && ring.clearOfBorder >= 1 && ring.clearOfContent >= 1, `the Best row's focus ring sits between its border and its contents: ${JSON.stringify(ring)}`);
    await page.focus('#f-price');
    // Every focus ring, the field's included, is the system focus colour.
    const fieldRing = (await get(page, '.input-wrap:has(#f-price)')).outlineColor;
    await page.keyboard.press('Tab');
    const tabRing = await page.evaluate(() => {
      const tab = document.querySelector('[role=tab][aria-selected=true]');
      tab.focus();
      return getComputedStyle(tab).outlineColor;
    });
    const logoRing = await page.evaluate(() => {
      document.querySelector('.site-header .brand').focus();
      return getComputedStyle(document.querySelector('.site-header .brand svg')).outlineColor;
    });
    assert.deepEqual([fieldRing, logoRing], [tabRing, tabRing], 'focus rings share one colour');
    // A result both pinned and Best keeps both edges (the top marketplace's own page).
    await page.goto(`${base}/`, { waitUntil: 'networkidle' });
    const circles = await page.evaluate(() => ['.checklist li', '.steps .card h3'].map((sel) => getComputedStyle(document.querySelector(sel), '::before').outlineStyle));
    assert.deepEqual(circles, ['solid', 'solid'], 'the checklist ticks and step numbers keep their circles');
    const top = await page.getAttribute('.result.is-best', 'data-id');
    await page.goto(`${base}/fees/${top}/`, { waitUntil: 'networkidle' });
    const both = await get(page, '.result.is-best.is-focus');
    assert.ok(both.border >= 3 && !both.outline, `pinned and Best: ${JSON.stringify(both)}`);
    assert.deepEqual(await page.locator('.result.is-best.is-focus .tag').allInnerTexts(), ['BEST', 'THIS PAGE']);
    await context.close();

    // Nothing spills at very large text in forced colors either.
    const small = await open(null, { viewport: { width: 320, height: 800 }, forcedColors: 'active' });
    await setTextSize(small.page, 2.5);
    await small.page.goto(`${base}/`, { waitUntil: 'networkidle' });
    const spills = await small.page.evaluate(() => [...document.querySelectorAll('.result .pname, .result .figure')].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent));
    assert.deepEqual(spills, [], 'forced colors, 320px, text 250%');
    await small.context.close();

    // Focus rings, normal and forced colors: a focused state element shows the
    // focus ring, not its state line.
    for (const forcedColors of ['none', 'active']) {
      const { context: ctx, page: p } = await open(null, { viewport: { width: 1280, height: 900 }, forcedColors });
      await p.goto(`${base}/fees/facebook/`, { waitUntil: 'networkidle' });
      await p.keyboard.press('Tab'); // keyboard use, so programmatic focus counts as :focus-visible
      for (const selector of ['[role=tab][aria-selected=true]', '.site-header nav a[aria-current]', '.result.is-best summary']) {
        const visible = await p.evaluate((sel) => {
          const el = document.querySelector(sel);
          el.focus();
          return el.matches(':focus-visible');
        }, selector);
        assert.ok(visible, `${selector} takes keyboard focus`);
        const ring = await get(p, selector);
        assert.ok(ring.outline && ring.outlineStyle === 'solid' && ring.outlineWidth >= 3, `forced colors ${forcedColors}: ${selector} focus ring ${JSON.stringify(ring)}`);
      }
      // The Best row's ring keeps clear of its edge (the 4px Best bar, or the
      // High Contrast border) by at least 1px.
      const clear = await p.evaluate(() => {
        const row = document.querySelector('.result.is-best');
        const summary = row.querySelector('summary');
        summary.focus();
        const st = getComputedStyle(summary);
        return summary.getBoundingClientRect().left - row.getBoundingClientRect().left - parseFloat(st.outlineOffset) - parseFloat(st.outlineWidth);
      });
      assert.ok(clear >= 6, `forced colors ${forcedColors}: Best row ring ${clear}px from the row's edge (border 1px + 4px bar, or the 3px High Contrast border, + 1px)`);
      // A focused invalid field shows the focus ring (its red border or double
      // line waits until focus leaves).
      await p.fill('#f-cost', '-5');
      await p.focus('#f-price'); // left, so it's judged
      await p.focus('#f-cost');
      assert.equal(await p.getAttribute('#f-cost', 'aria-invalid'), 'true');
      const invalidFocused = await get(p, '.input-wrap:has(#f-cost)');
      assert.ok(invalidFocused.outlineStyle === 'solid' && invalidFocused.outlineWidth >= 3, `forced colors ${forcedColors}: focused invalid field ${JSON.stringify(invalidFocused)}`);
      // Field lines, focused or not, stay off the label and the hint: a money
      // field (invalid) and a select.
      await p.locator('.tune > summary').click();
      for (const [box, focusOn, label, hintId] of [
        ['.input-wrap:has(#f-cost)', '#f-cost', 'f-cost', 'h-cost'],
        ['.input-wrap:has(#f-cost)', '#f-price', 'f-cost', 'h-cost'],
        ['#f-ebayCategory', '#f-ebayCategory', 'f-ebayCategory', null],
      ]) {
        await p.keyboard.press('Tab');
        await p.evaluate((sel) => document.querySelector(sel).focus(), focusOn);
        const gaps = await p.evaluate(([sel, forId, hint]) => {
          const el = document.querySelector(sel);
          const st = getComputedStyle(el);
          const reach = st.outlineStyle === 'none' ? 0 : parseFloat(st.outlineWidth) + parseFloat(st.outlineOffset);
          const r = el.getBoundingClientRect();
          const out = [r.top - reach - document.querySelector(`label[for="${forId}"]`).getBoundingClientRect().bottom];
          if (hint) out.push(document.getElementById(hint).getBoundingClientRect().top - r.bottom - reach);
          return out;
        }, [box, label, hintId]);
        assert.ok(Math.min(...gaps) >= 0.5, `forced colors ${forcedColors}, focus on ${focusOn}: ${box} lines ${gaps} from the label and hint`);
      }
      await p.keyboard.press('Tab');
      const corners = await p.evaluate(() => {
        const [focused, other] = ['#f-ebayCategory', '#f-etsyOffsite'].map((sel) => document.querySelector(sel));
        focused.focus();
        return { visible: focused.matches(':focus-visible'), radii: [focused, other].map((el) => getComputedStyle(el).borderTopLeftRadius) };
      });
      assert.ok(corners.visible && corners.radii[0] === corners.radii[1], `forced colors ${forcedColors}: a focused select keeps its corners ${JSON.stringify(corners)}`);
      await ctx.close();
    }
  });

  test('results stack their figures only when a name would be squeezed, all rows together', async () => {
    const placement = (page) =>
      page.evaluate(() => ({
        stacked: document.querySelector('[data-results]').classList.contains('stacked'),
        under: [...document.querySelectorAll('.result')].map((r) => r.querySelector('.figure').getBoundingClientRect().top >= r.querySelector('.pname').getBoundingClientRect().bottom - 1),
      }));
    // Whether every figure is under its name in the first frame the list is
    // shown in from now on: resolves once a change made by `act` shows it.
    const firstFrameShown = async (page, act) => {
      await page.evaluate(() => {
        window.firstFrame = undefined;
        const list = document.querySelector('[data-results]');
        new MutationObserver((_, watch) => {
          if (list.hidden) return;
          watch.disconnect();
          requestAnimationFrame(() => (window.firstFrame = [...list.querySelectorAll('.result')].every((row) => row.querySelector('.figure').getBoundingClientRect().top >= row.querySelector('.pname').getBoundingClientRect().bottom - 1)));
        }).observe(list, { attributes: true, attributeFilter: ['hidden'] });
      });
      await act();
      await page.waitForFunction(() => window.firstFrame !== undefined);
      return page.evaluate(() => window.firstFrame);
    };
    const promptThen = (page, price) => async () => {
      for (const value of ['', price]) {
        await page.fill('#f-price', value);
        await page.locator('#f-price').press('Tab');
        await settle(page);
      }
    };
    const { context, page, errors } = await open(null, { viewport: { width: 320, height: 800 } });
    await page.goto(`${base}/#price=4000&cost=100`, { waitUntil: 'networkidle' });
    let r = await placement(page);
    assert.ok(r.stacked && r.under.every(Boolean), 'a $4,000 sale on a 320px phone: every figure under its name');
    // A new list that replaces a prompt is fitted once shown: stacked from
    // its first frame, not jumping to it after.
    assert.deepEqual([await firstFrameShown(page, promptThen(page, '5000')), (await placement(page)).stacked], [true, true], 'a new list after a prompt: stacked from its first frame, and after');
    // So is the same list back after a prompt, shown at a new width (a
    // phone turned while the prompt was up).
    await page.setViewportSize({ width: 900, height: 800 });
    await settle(page);
    assert.equal((await placement(page)).stacked, false, 'wide: beside');
    const turned = await firstFrameShown(page, async () => {
      await page.fill('#f-price', '');
      await page.locator('#f-price').press('Tab');
      await settle(page);
      await page.setViewportSize({ width: 320, height: 800 });
      await settle(page);
      await page.fill('#f-price', '5000');
      await page.locator('#f-price').press('Tab');
    });
    assert.equal(turned, true, 'the same list, narrower now: stacked from its first frame');
    // Resizing refits the list, without ResizeObserver loop errors.
    await page.evaluate(() => {
      window.errorsSeen = [];
      addEventListener('error', (e) => window.errorsSeen.push(e.message));
    });
    for (const width of [900, 320, 900, 320, 900]) {
      await page.setViewportSize({ width, height: 800 });
      await page.waitForTimeout(120);
    }
    r = await placement(page);
    assert.ok(!r.stacked && r.under.every((u) => !u), 'room again: every figure beside its name');
    assert.deepEqual(await page.evaluate(() => window.errorsSeen), []);
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(`${base}/`, { waitUntil: 'networkidle' });
    r = await placement(page);
    assert.ok(!r.stacked && r.under.every((u) => !u), 'default sale on a 390px phone: figures beside names');
    assert.deepEqual(errors, []);
    await context.close();
    // Before the script fits the list, and without JavaScript, a CSS guess
    // from the list's width stacks the built results where names would be
    // squeezed: no name runs into its figure, and the first frame already
    // has every figure under its name where the script then stacks them.
    // Rows whose name runs into its figure.
    const runsInto = (page) =>
      page.evaluate(() =>
        [...document.querySelectorAll('.result')]
          .filter((row) => {
            const name = row.querySelector('.pname');
            const under = row.querySelector('.figure').getBoundingClientRect().top >= name.getBoundingClientRect().bottom - 1;
            return !under && name.scrollWidth > name.clientWidth + 1;
          })
          .map((row) => `${row.dataset.id} runs into its figure`),
      );
    // The list at a given width (its content box), the page around it adjusted for.
    const listAt = async (page, target) => {
      const width = () => page.evaluate(() => {
        const list = document.querySelector('[data-results]');
        const style = getComputedStyle(list);
        return list.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      });
      let viewport = Math.round(target + page.viewportSize().width - (await width()));
      await page.setViewportSize({ width: viewport, height: 800 });
      viewport += Math.round(target - (await width()));
      await page.setViewportSize({ width: viewport, height: 800 });
      assert.ok(Math.abs((await width()) - target) <= 1, `the list at ${target}px`);
      return viewport;
    };
    // Every built page (each fee page pins its own marketplace), at three
    // text sizes, at list widths around both edges of the CSS's band (12em,
    // and 12em plus 54px) and under it (where every figure has its own
    // line): no name runs into its figure or breaks.
    for (const path of ['/', ...FEE_PAGES]) {
      for (const scale of [1, 1.25, 1.5]) {
        const plain = await open(null, { viewport: { width: 360, height: 800 }, javaScriptEnabled: false });
        await setTextSize(plain.page, scale);
        await plain.page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
        const em = await plain.page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('[data-results]')).fontSize));
        const bad = [];
        for (const over of [-48, -24, -2, 2, 27, 52, 56, 60, 72, 96]) {
          const viewport = await listAt(plain.page, 12 * em + over);
          const trouble = [...(await runsInto(plain.page)), ...(await plain.page.evaluate(avoidableSplits, '.results'))];
          if (trouble.length) bad.push(`${viewport}px: ${trouble.join(', ')}`);
        }
        assert.deepEqual(bad, [], `no JavaScript, ${path} at ${scale * 100}% text`);
        await plain.context.close();
      }
    }
    // With text spacing overrides wider than the CSS allows for, a name
    // without JavaScript breaks rather than runs into its figure.
    const spaced = await open(null, { viewport: { width: 240, height: 800 }, javaScriptEnabled: false });
    await spaced.page.goto(`${base}/`, { waitUntil: 'networkidle' });
    await spaced.page.evaluate(() => document.styleSheets[0].insertRule('* { letter-spacing: .12em !important; word-spacing: .16em !important; line-height: 1.5 !important; }', document.styleSheets[0].cssRules.length));
    const runInto = [];
    for (let width = 240; width <= 480; width += 4) {
      await spaced.page.setViewportSize({ width, height: 800 });
      if ((await runsInto(spaced.page)).length) runInto.push(width);
    }
    assert.deepEqual(runInto, [], 'no JavaScript, text spacing overrides: no name runs into its figure');
    await spaced.context.close();
    // A change after the script fitted the list but before the first frame
    // (a link loaded in a background tab, the window then narrowed): the
    // first look at the column refits it. Here the column narrowed as the
    // page finishes loading, a $4,000 sale's names squeezed.
    const narrowed = await open(null, { viewport: { width: 1000, height: 800 } });
    await narrowed.page.addInitScript(() =>
      document.addEventListener('DOMContentLoaded', () => document.styleSheets[0].insertRule('.calc-output { width: 320px !important; max-width: 320px !important; }', document.styleSheets[0].cssRules.length)),
    );
    await narrowed.page.goto(`${base}/#price=4000&cost=100`, { waitUntil: 'networkidle' });
    assert.deepEqual([...(await runsInto(narrowed.page)), (await placement(narrowed.page)).stacked], [true], 'narrowed before the first frame: refitted, stacked');
    assert.deepEqual(narrowed.errors, []);
    await narrowed.context.close();
    // The hidden word the script watches for text changes never widens the
    // page, however large the text.
    const huge = await open(null, { viewport: { width: 320, height: 800 } });
    await setTextSize(huge.page, 3);
    await huge.page.goto(`${base}/`, { waitUntil: 'networkidle' });
    assert.ok(await huge.page.evaluate(() => document.querySelector('.fit-probe').getBoundingClientRect().right <= document.documentElement.clientWidth), '300% text at 320px: the probe stays inside the page');
    await huge.context.close();
    // Once the script has fitted the list, it decides, not the CSS: a $12
    // sale's short figures fit beside their names at a width the CSS alone
    // would stack.
    const shortFigures = await open(null, { viewport: { width: 320, height: 800 } });
    await shortFigures.page.goto(`${base}/#price=12&cost=2`, { waitUntil: 'networkidle' });
    await listAt(shortFigures.page, 240); // in the CSS's band (12em to 12em plus 54px)
    assert.ok((await placement(shortFigures.page)).under.every((u) => !u), 'fitted: figures beside names where they fit');
    assert.deepEqual(shortFigures.errors, []);
    await shortFigures.context.close();
    for (const [width, scale] of [[320, 1.25], [300, 1]]) {
      const loaded = await open(null, { viewport: { width, height: 800 } });
      await setTextSize(loaded.page, scale);
      await loaded.page.addInitScript(() => {
        const frame = () => {
          const rows = [...document.querySelectorAll('.result')];
          if (rows.length) window.firstFrame = rows.every((row) => row.querySelector('.figure').getBoundingClientRect().top >= row.querySelector('.pname').getBoundingClientRect().bottom - 1);
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      await loaded.page.goto(`${base}/`, { waitUntil: 'networkidle' });
      assert.equal(await loaded.page.evaluate(() => window.firstFrame), true, `${width}px at ${scale * 100}% text: every figure under its name in the first frame`);
      assert.ok((await placement(loaded.page)).under.every(Boolean), 'and after the script has run');
      assert.deepEqual(loaded.errors, []);
      await loaded.context.close();
    }
    // Refitted before the frame paints when the text grows at the same
    // width: a larger text size, or text spacing overrides (WCAG 1.4.12:
    // letters and words wider, the lines as they were). A $4,000 sale, at
    // widths the script decides (wider than the CSS stacks by itself).
    // Sampled as each frame starts, so a frame's sample is what the one
    // before it painted.
    for (const how of ['text size', 'text spacing']) {
      const resized = await open(null, { viewport: { width: 400, height: 800 } });
      await resized.page.goto(`${base}/#price=4000&cost=100`, { waitUntil: 'networkidle' });
      await listAt(resized.page, how === 'text size' ? 314 : 294); // beside now, squeezed once the text grows
      assert.ok((await placement(resized.page)).under.every((u) => !u), `${how}: beside to begin with`);
      await resized.page.evaluate(() => {
        window.samples = [];
        const list = document.querySelector('[data-results]');
        const name = list.querySelector('.pname');
        const under = () => [...list.querySelectorAll('.result')].every((row) => row.querySelector('.figure').getBoundingClientRect().top >= row.querySelector('.pname').getBoundingClientRect().bottom - 1);
        const sample = () => {
          const text = getComputedStyle(name);
          window.samples.push([`${text.fontSize} ${text.letterSpacing}`, under()]);
          const changedAt = window.samples.findIndex(([seen]) => seen !== window.samples[0][0]);
          if (changedAt < 0 || window.samples.length < changedAt + 3) requestAnimationFrame(sample); // until a couple of frames after the change
          else window.sampled = true;
        };
        requestAnimationFrame(sample);
      });
      await resized.page.waitForTimeout(100);
      if (how === 'text size') await setTextSize(resized.page, 1.25);
      else await resized.page.evaluate(() => document.styleSheets[0].insertRule('* { letter-spacing: .12em !important; word-spacing: .16em !important; }', document.styleSheets[0].cssRules.length)); // as a bookmarklet would
      await resized.page.waitForFunction(() => window.sampled, null, { timeout: 5000 });
      const samples = await resized.page.evaluate(() => window.samples);
      const changedAt = samples.findIndex(([text]) => text !== samples[0][0]);
      assert.ok(changedAt > 0 && changedAt < samples.length - 1, `${how}: the change seen mid-sampling`);
      r = await placement(resized.page);
      assert.deepEqual([samples[changedAt + 1][1], r.stacked && r.under.every(Boolean)], [true, true], `${how} grown at the same width: refitted in the frame it changed, every figure under its name`);
      assert.deepEqual(resized.errors, []);
      await resized.context.close();
    }
  });

  test("a desktop scrollbar coming or going leaves the results column's width as it was", async () => {
    // Real desktop scrollbars, which take room (headless hides them).
    const desktop = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, ignoreDefaultArgs: ['--hide-scrollbars'] });
    try {
      const page = await (await desktop.newContext({ viewport: { width: 1000, height: 1400 } })).newPage();
      await page.goto(`${base}/`, { waitUntil: 'networkidle' });
      const column = () => page.evaluate(() => [document.querySelector('[data-verdict]').clientWidth, document.documentElement.scrollHeight > innerHeight]);
      const [long, overflows] = await column();
      // Only the calculator left: the page no longer needs a scrollbar.
      await page.evaluate(() => {
        const calc = document.querySelector('#calculator');
        for (const el of document.body.querySelectorAll('*')) if (!el.contains(calc) && !calc.contains(el)) el.style.display = 'none';
      });
      const short = await column();
      await page.evaluate(() => (document.documentElement.style.scrollbarGutter = 'auto'));
      const [unkept] = await column();
      assert.deepEqual([overflows, short, unkept > long], [true, [long, false], true], 'its room kept: the same width either way (wider without that)');
      // A page without the calculator keeps no such room: a short one shows
      // no empty strip beside its header and footer.
      await page.goto(`${base}/404.html`, { waitUntil: 'networkidle' });
      assert.deepEqual(
        await page.evaluate(() => [document.documentElement.scrollHeight > innerHeight, document.querySelector('.site-header').getBoundingClientRect().width === innerWidth]),
        [false, true],
        'a short page: header across the whole window',
      );
    } finally {
      await desktop.close();
    }
  });

  test('fee tables show their numbers on a phone without scrolling sideways', async () => {
    for (const width of [320, 360, 390]) {
      const { context, page } = await open(null, { viewport: { width, height: 800 } });
      for (const path of ['/fees/', '/fees/ebay/', '/fees/facebook/', '/fees/grailed/']) {
        await page.goto(base + path, { waitUntil: 'networkidle' });
        const hidden = await page.evaluate(() =>
          [...document.querySelectorAll('.table-wrap')].flatMap((wrap) => {
            const box = wrap.getBoundingClientRect();
            return [...wrap.querySelectorAll('.num')].filter((c) => c.getBoundingClientRect().right > box.right + 0.5).map((c) => c.textContent);
          }),
        );
        assert.deepEqual(hidden, [], `${width}px ${path}: numbers cut off`);
      }
      await context.close();
    }
  });

  test('no page scrolls sideways or splits a word, default or fully configured, even with large text', async () => {
    const pages = ['/', '/fees/', '/fees/ebay/', '/fees/facebook/', '/tracker/', '/privacy/', '/terms/', '/404.html', '/offline.html'];
    // Every optional setting on: contact email, signup forms, a live buy button,
    // analytics (privacy text) and a long one-word site name.
    const configured = {
      CONTACT_EMAIL: 'support@threadvet.com',
      NEWSLETTER_ACTION: 'https://example.com/subscribe',
      TRACKER_CHECKOUT_URL: 'https://example.com/buy',
      PLAUSIBLE_DOMAIN: 'threadvet.com',
      SITE_NAME: 'ResellerCalculatorPro',
    };
    const problems = [];
    for (const env of [null, configured]) {
      if (env) build(env);
      try {
        for (const width of [320, 360, 414, 600, 768, 800, 1024, 1280, 1920]) {
          for (const text of [1, 1.25, 1.5, 2, 2.5]) {
            const { context, page } = await open(null, { viewport: { width, height: 800 }, serviceWorkers: 'block' });
            await context.route(/^https?:\/\/(?!localhost)/, (route) => route.abort()); // no outside network (analytics)
            await setTextSize(page, text);
            for (const path of pages) {
              await page.goto(base + path, { waitUntil: 'domcontentloaded' });
              await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
              const over = await page.evaluate(sideways);
              const found = [...(over > 0 ? [`scrolls sideways +${over}px`] : []), ...(await page.evaluate(avoidableSplits, 'body'))];
              if (found.length) problems.push(`${env ? 'configured' : 'default'}, ${width}px, text ${text * 100}%, ${path}: ${found.join('; ')}`);
            }
            await context.close();
          }
        }
      } finally {
        if (env) build();
      }
    }
    assert.deepEqual(problems, []);
  });

  test('the header stays on one row and never cuts the site name short', async () => {
    for (const name of ['', 'ResellerCalculatorPro']) {
      if (name) build({ SITE_NAME: name });
      try {
        for (const width of [320, 360, 390, 430, 480, 768, 1280]) {
          for (const text of [1, 1.25, 1.5, 2]) {
            const { context, page } = await open(null, { viewport: { width, height: 700 } });
            await setTextSize(page, text);
            await page.goto(`${base}/fees/`, { waitUntil: 'networkidle' });
            const where = `${width}px, text ${text * 100}%${name ? `, "${name}"` : ''}`;
            const r = await page.evaluate(() => {
              const brand = document.querySelector('.site-header .brand').getBoundingClientRect();
              const name = document.querySelector('.site-header .brand span').getBoundingClientRect();
              const shown = name.top < brand.bottom - 1; // on the logo's line, not the clipped one below
              const nav = document.querySelector('.site-header nav').getBoundingClientRect();
              return {
                // Beside the logo, not below it (at very large text its links may stack there).
                beside: nav.left >= brand.right - 1 && nav.top < brand.bottom,
                shown,
                cut: shown && name.right > brand.right + 1,
              };
            });
            assert.ok(r.beside, `${where}: nav wrapped under the logo`);
            // Either the whole name or just the logo (name still read out): never "Threa…".
            assert.ok(!r.cut, `${where}: site name cut short`);
            if (!name && text === 1 && width >= 768) assert.ok(r.shown, `${where}: there is room, so the name shows`);
            assert.equal(await page.evaluate(sideways), 0, `${where}: page scrolls sideways (header or footer)`);
            const logoLink = page.locator('.site-header').getByRole('link', { name: name || 'ThreadVet', exact: true });
            assert.equal(await logoLink.count(), 1, `${where}: logo link keeps its name`);
            await context.close();
          }
        }
      } finally {
        if (name) build();
      }
    }
  });

  test('pages used offline survive a site update', async () => {
    const { context, page } = await open();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.goto(`${base}/fees/poshmark/`, { waitUntil: 'networkidle' });
    // Deploy a new version (any page change gives the service worker a new cache).
    build({ CONTACT_EMAIL: 'update@example.com' });
    try {
      const updated = page.evaluate(
        () => new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })),
      );
      await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
      await updated;
      // The new worker copies previously cached pages across, then drops the old cache.
      for (let i = 0; i < 60 && (await page.evaluate(async () => (await caches.keys()).length)) > 1; i++) {
        await page.waitForTimeout(250);
      }
      serverMode = 'down';
      await page.goto(`${base}/fees/poshmark/`, { waitUntil: 'networkidle' });
      assert.equal(await page.locator('h1').innerText(), `Poshmark fees calculator (${FEES_VERIFIED.slice(0, 4)})`);
      // Its CSS/JS came along too: the calculator is live, pinned to Poshmark.
      assert.equal(await page.locator('.result').first().getAttribute('data-id'), 'poshmark');
      await page.fill('#f-price', '30');
      await settle(page);
      assert.match(await verdict(page), /\$/);
    } finally {
      serverMode = 'normal';
      build();
      await context.close();
    }
  });

  test('works offline and falls back quickly on a weak connection', async () => {
    const { context, page } = await open();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: 'networkidle' });
    // Leave the calculator so the next visit is a real page load through the service worker.
    await page.goto(`${base}/privacy/`, { waitUntil: 'networkidle' });
    try {
      serverMode = 'down';
      await page.goto(`${base}/#price=30`, { waitUntil: 'networkidle' });
      assert.match(await verdict(page), /Worth it\./, 'calculator works offline');
      assert.equal(await page.inputValue('#f-price'), '30');
      // A link without its trailing slash is redirected to the cached page, as online.
      await page.goto(`${base}/fees?ref=x`);
      assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, '/fees/?ref=x');
      assert.match(await page.locator('h1').innerText(), /fees/i);
      await page.goto(`${base}/tracker/`);
      assert.equal(await page.locator('h1').innerText(), 'You are offline');
      serverMode = 'slow';
      const started = Date.now();
      await page.goto(`${base}/fees/`, { waitUntil: 'domcontentloaded' });
      assert.ok(Date.now() - started < 6000, 'cached page served before the slow network answers');
    } finally {
      serverMode = 'normal';
      await context.close();
    }
  });
}
