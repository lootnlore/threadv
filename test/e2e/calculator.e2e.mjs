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
import { FEES_VERIFIED } from '../../src/engine/fees.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
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

  const open = async (path = '/', options = {}) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...options });
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

  test('results are pre-rendered without JavaScript', async () => {
    const { context, page } = await open('/', { javaScriptEnabled: false });
    assert.equal(await page.locator('.result').count(), 9);
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
    const first = await tp.getAttribute('.result:first-child', 'data-id');
    const box = await tp.locator(`.result[data-id="${first}"] summary`).boundingBox();
    await tp.focus('#f-price');
    await tp.keyboard.press('End');
    const cdp = await touch.context.newCDPSession(tp);
    const point = { x: box.x + 30, y: box.y + box.height / 2 };
    await notePress(tp);
    await Promise.all([...keyEvents(cdp, '0'), cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })]); // 40 becomes 400: the order changes
    await tp.waitForTimeout(120); // longer than the result takes to catch up while typing
    await tp.keyboard.type('0'); // and typed with the other thumb, mid-press: 4000
    await tp.waitForTimeout(120);
    const midTap = await tp.getAttribute('.result:first-child', 'data-id');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settle(tp);
    assert.ok((await pressGap(tp)) < 60, 'the render was due when the finger went down');
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
      return { row, finger: { x: at.x + 30, y: at.y + at.height / 2 } };
    };
    const openRows = () => tp.$$eval('.result details[open]', (d) => d.map((el) => el.closest('.result').dataset.id));
    const firstRow = () => tp.getAttribute('.result:first-child', 'data-id');
    let aim = await tapFirstRow();
    await tp.fill('#f-price', '12..');
    await settle(tp);
    const listed = await verdict(tp);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [aim.finger] });
    await tp.keyboard.press('Tab'); // Next
    await tp.keyboard.type('1,'); // and on into the next field, half-typed
    await tp.waitForTimeout(150);
    const afterNext = await verdict(tp);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settle(tp);
    assert.deepEqual(
      [afterNext, await openRows(), await verdict(tp), await tp.getAttribute('#f-price', 'aria-invalid')],
      [listed, [aim.row], 'Check “Sell price”. Write it like 1,234.50.', 'true'],
      'Next: judged at once, shown once the finger lifted',
    );
    await tp.fill('#f-cost', '0');
    aim = await tapFirstRow();
    await tp.focus('#f-price');
    await tp.keyboard.press('End');
    await notePress(tp);
    await Promise.all([...keyEvents(cdp, '0'), cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [aim.finger] })]);
    await tp.keyboard.press('Enter'); // Go
    await tp.waitForTimeout(150);
    const afterGo = [await firstRow(), await tp.evaluate(() => scrollY)];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settle(tp);
    assert.ok((await pressGap(tp)) < 60, 'the render was due when the finger went down');
    assert.deepEqual([afterGo, await openRows()], [[aim.row, 0], [aim.row]], 'Go: nothing re-ranked or scrolled under the finger');
    assert.ok((await tp.evaluate(() => scrollY)) > 0, 'then it went to the verdict');
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
    // whole page), and goes once the finger lifts...
    aim = await tapFirstRow();
    await tp.focus('#f-price');
    const onForm = { x: formSpot.x + 10, y: formSpot.y + 5 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [onForm] });
    await tp.keyboard.press('Enter');
    await tp.waitForTimeout(150);
    const goOnForm = await tp.evaluate(() => scrollY);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settle(tp);
    assert.deepEqual([goOnForm, (await tp.evaluate(() => scrollY)) > 0], [0, true], 'Go: not under the finger, then to the verdict');
    // ...unless another press begins first: the user has moved on.
    aim = await tapFirstRow();
    await tp.focus('#f-price');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...aim.finger, id: 0 }] });
    await tp.keyboard.press('Enter');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...aim.finger, id: 0 }, secondFinger] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settle(tp);
    assert.deepEqual(await tp.evaluate(() => [scrollY, document.activeElement.matches('[data-verdict]')]), [0, false], 'Go dropped');
    // Keys acting on other controls wait too: Space on a marketplace's box,
    // an arrow on the mode tabs.
    for (const [control, key] of [['input[name="platform"][value="poshmark"]', 'Space'], ['[role="tab"][aria-selected="true"]', 'ArrowRight']]) {
      await tp.locator(control).evaluate((el) => el.closest('details')?.setAttribute('open', '')); // where it can take focus
      aim = await tapFirstRow();
      const before = await verdict(tp);
      await tp.focus(control);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [aim.finger] });
      await tp.keyboard.press(key);
      await tp.waitForTimeout(150);
      const midPress = [await firstRow(), await verdict(tp)];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await settle(tp);
      assert.deepEqual(midPress, [aim.row, before], `${key}: nothing redrawn under the finger`);
      assert.notEqual(await verdict(tp), before, `${key}: then it was`);
      if (key === 'Space') await tp.check(control);
      else await tp.getByRole('tab', { name: 'Profit' }).click();
    }
    await touch.context.close();

    const { context, page } = await open('/', { viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
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
    await page.locator('#f-price').click();
    await page.keyboard.press('End');
    await page.keyboard.type('.');
    await settle(page);
    assert.equal(await inAddressBar(page, 'price'), '12...', 'judged (and saved) as typed');
    const [line] = (await hintLines('h-price')).lines;
    await notePress(page);
    await Promise.all([...keyEvents(raw, '.'), mouse('mousePressed', { x: line.right + 6, y: line.y })]);
    for (let x = line.right + 6; x > line.left + 1; x -= 20) await mouse('mouseMoved', { x, y: line.y }, { buttons: 1 });
    await mouse('mouseMoved', { x: line.left + 1, y: line.y }, { buttons: 1 });
    await mouse('mouseReleased', { x: line.left + 1, y: line.y });
    await settle(page);
    assert.ok((await pressGap(page)) < 60, 'the render was due when the press began');
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
    // (A right press is over once its menu is: a key the page hears says so.)
    const fixUnderPress = async (button) => {
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
      if (button === 'right') await page.keyboard.press('Shift'); // the menu closed
      await settle(page);
      return [(await pressGap(page)) < 60, midPress, await hintText()];
    };
    for (const button of ['left', 'right']) {
      assert.deepEqual(await fixUnderPress(button), [true, 'Write it like 1,234.50.', 'What it will sell for'], `${button}: due at the press, unchanged under it, then updated`);
    }
    // A right press on a row with a render due: its menu opens on the row
    // aimed at, and the list re-ranks once the menu is gone.
    await page.fill('#f-price', '40');
    await settle(page);
    await page.keyboard.press('End');
    await page.evaluate(() => scrollTo(0, 0));
    const aimed = await page.getAttribute('.result:first-child', 'data-id');
    const rowBox = await page.locator('.result:first-child summary').boundingBox();
    const rowAt = { x: rowBox.x + 30, y: rowBox.y + rowBox.height / 2 };
    const menuOn = () =>
      page.evaluate(() => addEventListener('contextmenu', (c) => (window.menuOn = c.target.closest('.result')?.dataset.id), { capture: true, once: true }));
    await menuOn();
    await notePress(page);
    await Promise.all([...keyEvents(raw, '0'), mouse('mousePressed', rowAt, { button: 'right' })]); // 400: the order changes
    await mouse('mouseReleased', rowAt, { button: 'right' });
    await page.waitForTimeout(150);
    const underMenu = await page.evaluate(() => [window.menuOn, document.querySelector('.result').dataset.id]);
    await hover({ x: rowAt.x + 5, y: rowAt.y }); // back from the menu
    await settle(page);
    assert.ok((await pressGap(page)) < 60, 'the render was due when the press began');
    assert.deepEqual(underMenu, [aimed, aimed], 'the menu on the row aimed at, the list as it was');
    assert.notEqual(await page.getAttribute('.result:first-child', 'data-id'), aimed, 'then re-ranked for 400');
    // A press on what a render doesn't rewrite (here the field itself) holds
    // nothing back: the results keep up with typing while it lasts.
    await page.fill('#f-price', '40');
    await settle(page);
    await page.keyboard.press('End');
    const ranked = await page.getAttribute('.result:first-child', 'data-id');
    const fieldBox = await page.locator('#f-price').boundingBox();
    const inField = { x: fieldBox.x + fieldBox.width - 8, y: fieldBox.y + fieldBox.height / 2 };
    await notePress(page);
    await Promise.all([...keyEvents(raw, '0'), mouse('mousePressed', inField)]);
    await page.waitForTimeout(150);
    const rankedMidPress = await page.getAttribute('.result:first-child', 'data-id');
    await mouse('mouseReleased', inField);
    await settle(page);
    assert.ok((await pressGap(page)) < 60, 'the render was due when the press began');
    assert.notEqual(rankedMidPress, ranked, 'the list re-ranked for 400 mid-press');
    // A drag that starts on the form side holds once it reaches the results.
    await page.fill('#f-price', '40');
    await settle(page);
    await page.keyboard.press('End');
    const modeHint = await page.locator('[data-hint]').boundingBox();
    const fromForm = { x: modeHint.x + 5, y: modeHint.y + modeHint.height / 2 };
    const rankedBeforeDrag = await page.getAttribute('.result:first-child', 'data-id');
    await notePress(page);
    await Promise.all([...keyEvents(raw, '0'), mouse('mousePressed', fromForm), mouse('mouseMoved', rowAt, { buttons: 1 })]);
    await page.waitForTimeout(150);
    const rankedMidDrag = await page.getAttribute('.result:first-child', 'data-id');
    await mouse('mouseReleased', rowAt);
    await settle(page);
    await page.evaluate(() => getSelection().removeAllRanges());
    assert.ok((await pressGap(page)) < 60, 'the render was due when the press began');
    assert.deepEqual([rankedMidDrag, (await page.getAttribute('.result:first-child', 'data-id')) !== rankedBeforeDrag], [rankedBeforeDrag, true], 'held under the drag, then re-ranked');
    // A right press that takes focus from a half-typed field: judged once
    // the menu is gone, not under it.
    await page.fill('#f-price', '40');
    await settle(page);
    await page.fill('#f-price', '12..');
    await settle(page);
    before = await shown();
    await mouse('mousePressed', rowAt, { button: 'right' });
    await mouse('mouseReleased', rowAt, { button: 'right' });
    await page.waitForTimeout(150);
    const leftUnderMenu = [await page.evaluate(() => document.activeElement.id), await shown()];
    await hover({ x: rowAt.x + 5, y: rowAt.y });
    await settle(page);
    assert.deepEqual(leftUnderMenu, ['', before], 'left, but not judged under its menu');
    assert.equal(await shown(), 'Check “Sell price”. Write it like 1,234.50.', 'judged once it was gone');
    // A press below the calculator holds a keystroke's render too: the
    // results coming back in the prompt's place would move it.
    await page.fill('#f-price', '');
    await page.locator('#f-price').press('Tab');
    await page.locator('#f-price').focus();
    await page.evaluate(() => scrollTo(0, 200));
    const heading = page.locator('h2', { hasText: 'Three questions' });
    const headAt = await heading.boundingBox();
    const onHeading = { x: headAt.x + 20, y: headAt.y + headAt.height / 2 };
    await notePress(page);
    await Promise.all([...keyEvents(raw, '4'), mouse('mousePressed', onHeading)]);
    await page.waitForTimeout(150);
    const headMidPress = (await heading.boundingBox()).y;
    await mouse('mouseReleased', onHeading);
    await settle(page);
    assert.ok((await pressGap(page)) < 60, 'the render was due when the press began');
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
    // Leaving the page writes the address bar at once, not 250ms on: Back
    // and reload find what was typed.
    await page.fill('#f-price', '45');
    await page.waitForTimeout(100); // its render, not yet its address-bar write
    const beforeLeaving = await inAddressBar(page, 'price');
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide')));
    assert.deepEqual([beforeLeaving !== '45', await inAddressBar(page, 'price')], [true, '45'], 'not written yet, then as the page went');
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
    const row4 = page.locator('.result:nth-child(4)');
    const id4 = await row4.getAttribute('data-id');
    const at4 = await row4.locator('summary').boundingBox();
    await page.fill('#f-price', '1,5'); // read (and re-ranked) only when left
    await page.evaluate(() => {
      // A press that takes focus from the field, whose release the page never hears.
      const h1 = document.querySelector('h1');
      h1.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 11, pointerType: 'mouse', isPrimary: true, button: 0, bubbles: true }));
      h1.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      document.activeElement.blur();
    });
    await pressAt(page, at4, 600);
    assert.equal(await page.locator(`.result[data-id="${id4}"] details`).getAttribute('open'), '', 'the next press opened its row');
    assert.equal(await page.inputValue('#f-price'), '1.5', 'and then the field was judged');
    await page.locator(`.result[data-id="${id4}"] summary`).click();
    await page.fill('#f-price', '40');
    await settle(page);
    // A right press holds back a keystroke's render due when it began, like
    // any press off the form, and its menu with it: once that's gone, it shows.
    before = await shown();
    await page.focus('#f-price');
    await page.keyboard.type('1');
    await page.mouse.move(640, 20);
    await page.mouse.down({ button: 'right' });
    await page.waitForTimeout(300);
    const during = await shown();
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(300);
    const released = await shown();
    await page.mouse.move(650, 20); // back from the menu
    await settle(page);
    assert.deepEqual([during, released], [before, before], 'held while the button was down, and its menu open');
    assert.notEqual(await shown(), before, 'then shown');
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
    // and only while that press lasts.
    const pressFrom = (init) =>
      page.evaluate((i) => {
        const h1 = document.querySelector('h1');
        h1.dispatchEvent(new PointerEvent('pointerdown', { isPrimary: true, button: 0, bubbles: true, ...i }));
        h1.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        document.activeElement.blur(); // its mousedown takes focus from the field
      }, init);
    const pointer = (type, init) => page.evaluate(([t, i]) => document.querySelector('h1').dispatchEvent(new (t === 'click' ? MouseEvent : PointerEvent)(t, { bubbles: true, ...i })), [type, init]);
    const judged = () => page.locator('#f-price').getAttribute('aria-invalid').then((v) => v === 'true');
    const halfType = async () => {
      await page.fill('#f-price', '40');
      await settle(page);
      await page.fill('#f-price', '12..');
    };
    // A mouse press whose release the page never heard (a menu took it)
    // doesn't hold a later Tab's judgement...
    await pointer('pointerdown', { pointerId: 9, pointerType: 'mouse', isPrimary: true, button: 0 });
    await page.fill('#f-price', '12..');
    await page.locator('#f-price').press('Tab');
    await tick(page);
    assert.equal(await judged(), true, 'a later Tab is judged at once');
    // ...and one that took focus waits for its click, not a keyboard's, or
    // ends when the mouse is seen with no button down.
    await halfType();
    await pressFrom({ pointerId: 9, pointerType: 'mouse' });
    await tick(page);
    assert.equal(await judged(), false, 'waits for the press');
    await pointer('click', { detail: 0 });
    await tick(page);
    assert.equal(await judged(), false, "a keyboard's click isn't the press's");
    await page.waitForTimeout(3200);
    assert.equal(await judged(), false, 'a mouse held still keeps its press (a slow click)');
    await pointer('pointermove', { pointerId: 9, pointerType: 'mouse', buttons: 0 });
    await tick(page);
    assert.equal(await judged(), true, 'the mouse moving with no button down ends it');
    // A press ends 250ms after a release that makes no click.
    await halfType();
    await pressFrom({ pointerId: 9, pointerType: 'mouse' });
    const afterRelease = await page.evaluate(async () => {
      const at = (ms) => new Promise((r) => setTimeout(r, ms));
      const flagged = () => document.querySelector('#f-price').getAttribute('aria-invalid') === 'true';
      document.querySelector('h1').dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, pointerType: 'mouse', isPrimary: true, button: 0, bubbles: true }));
      await at(150);
      const early = flagged();
      await at(250);
      return [early, flagged()];
    });
    assert.deepEqual(afterRelease, [false, true], 'waits 250ms for a click; none came: over');
    // Released, a hovering pointer (a pen before its tap's click) doesn't end
    // the press: its click is still coming.
    await halfType();
    await pressFrom({ pointerId: 9, pointerType: 'pen' });
    const hovering = await page.evaluate(async () => {
      const h1 = document.querySelector('h1');
      const init = { pointerId: 9, pointerType: 'pen', isPrimary: true, bubbles: true };
      h1.dispatchEvent(new PointerEvent('pointerup', { ...init, button: 0 }));
      h1.dispatchEvent(new PointerEvent('pointermove', { ...init, buttons: 0 }));
      await new Promise((r) => setTimeout(r, 50));
      const early = document.querySelector('#f-price').getAttribute('aria-invalid');
      h1.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true }));
      await new Promise((r) => setTimeout(r, 50));
      return [early, document.querySelector('#f-price').getAttribute('aria-invalid')];
    });
    assert.deepEqual(hovering, [null, 'true'], 'judged after the click, not at the hover');
    // One that opens its context menu (a Ctrl-click on a Mac, a right
    // click) is over once the menu is: at a move with no button down, or a
    // key the page hears, not at its release (the menu may still be open).
    // Firefox and Safari send its menu as a mouse event, naming no pointer.
    for (const [pointerType, end, menuSent] of [['mouse', 'a move', 'a pointer event'], ['mouse', 'a key', 'a mouse event'], ['mouse', 'a scroll', 'a pointer event'], ['pen', 'a move', 'a mouse event'], ['touch', '3s without a word', 'a pointer event']]) {
      const how = `${pointerType}, its menu sent as ${menuSent}, then ${end}`;
      await halfType();
      await pressFrom({ pointerId: 9, pointerType });
      await pointer('contextmenu', { pointerId: 9, button: 2 });
      await tick(page);
      await tick(page);
      assert.equal(await judged(), false, `${how}: another button's menu isn't this press's`);
      if (menuSent === 'a pointer event') await pointer('contextmenu', { pointerId: 9, button: 0 });
      else await page.evaluate(() => document.querySelector('h1').dispatchEvent(new MouseEvent('contextmenu', { button: 0, bubbles: true })));
      await pointer('pointerup', { pointerId: 9, pointerType, button: 0 });
      await page.waitForTimeout(400);
      assert.equal(await judged(), false, `${how}: waits, past its release`);
      if (end === 'a move') await pointer('pointermove', { pointerId: 9, pointerType, buttons: 0 });
      else if (end === 'a key') await page.keyboard.press('Shift');
      else if (end === 'a scroll') await page.evaluate(() => document.querySelector('h1').dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true })));
      else await page.waitForFunction(() => document.querySelector('#f-price').getAttribute('aria-invalid') === 'true', null, { timeout: 3500 });
      await tick(page);
      await tick(page);
      assert.equal(await judged(), true, `${how}: over`);
    }
    // A finger's press ends if cancelled (a scroll), and a finger's or pen's
    // after 3s without a word from it.
    await halfType();
    await pressFrom({ pointerId: 12, pointerType: 'touch' });
    await pointer('pointercancel', { pointerId: 12, pointerType: 'touch' });
    await tick(page);
    assert.equal(await judged(), true, 'a cancelled press is over');
    for (const [pointerId, pointerType] of [[13, 'touch'], [14, 'pen']]) {
      await halfType();
      await pressFrom({ pointerId, pointerType });
      await tick(page);
      assert.equal(await judged(), false, `${pointerType}: waits`);
      await page.waitForFunction(() => document.querySelector('#f-price').getAttribute('aria-invalid') === 'true', null, { timeout: 3500 });
    }
    // A key ends a mouse's press (it's rarely held down while typing, and a
    // key after a release the page never heard means the user moved on),
    // but not a modifier held for a click.
    await halfType();
    await pressFrom({ pointerId: 9, pointerType: 'mouse' });
    await page.keyboard.press('Shift');
    await tick(page);
    await tick(page);
    assert.equal(await judged(), false, 'Shift: held for a click');
    await page.keyboard.press('KeyA');
    await tick(page);
    await tick(page);
    assert.equal(await judged(), true, 'a key: over');
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

    await page.setViewportSize({ width: 900, height: 800 });
    await orientation('horizontal');
    assert.equal(await press('Profit', 'ArrowDown'), 'profit');
    assert.equal(await press('Profit', 'ArrowRight'), 'maxbuy');
    await context.close();
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
          if (document.documentElement.scrollWidth > innerWidth) found.push('page scrolls sideways');
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
          return { sub: left('.result-sub'), bd: left('.breakdown dl'), name: left('.pname'), rankShown: row.querySelector('.rank').offsetWidth > 0, wide: innerWidth / parseFloat(getComputedStyle(document.documentElement).fontSize) > 30 };
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
    const { context, page, errors } = await open(null, { viewport: { width: 320, height: 800 } });
    await page.goto(`${base}/#price=4000&cost=100`, { waitUntil: 'networkidle' });
    let r = await placement(page);
    assert.ok(r.stacked && r.under.every(Boolean), 'a $4,000 sale on a 320px phone: every figure under its name');
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
              const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
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
                sideways: document.documentElement.scrollWidth - innerWidth,
              };
            });
            assert.ok(r.beside, `${where}: nav wrapped under the logo`);
            // Either the whole name or just the logo (name still read out): never "Threa…".
            assert.ok(!r.cut, `${where}: site name cut short`);
            if (!name && text === 1 && width >= 768) assert.ok(r.shown, `${where}: there is room, so the name shows`);
            assert.equal(r.sideways, 0, `${where}: page scrolls sideways (header or footer)`);
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
