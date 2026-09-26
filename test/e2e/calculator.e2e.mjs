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

  test('out-of-range and junk input is flagged, not silently changed', async () => {
    const { context, page } = await open();
    await page.fill('#f-cost', '-5');
    await settle(page);
    assert.equal(await page.locator('#f-cost').getAttribute('aria-invalid'), 'true');
    assert.match(await page.locator('#h-cost').innerText(), /from \$0/);
    await page.fill('#f-cost', '8');
    await settle(page);
    assert.equal(await page.locator('#f-cost').getAttribute('aria-invalid'), null);
    assert.equal(await page.locator('#h-cost').innerText(), 'Item cost');
    await page.locator('.tune > summary').click();
    await page.fill('#f-tiktokRate', 'abc');
    await settle(page);
    assert.equal(await page.locator('#f-tiktokRate').getAttribute('aria-invalid'), 'true');
    await context.close();
  });

  test('no verdict from numbers the form rejects or leaves out', async () => {
    const { context, page } = await open();
    const state = () =>
      page.evaluate(() => ({ tone: document.querySelector('[data-verdict]').className, rows: document.querySelector('[data-results]').children.length }));
    const pending = { tone: 'verdict verdict-wait', rows: 0 };
    const cases = [
      ['#f-cost', '-5', 'Check “You paid”. Enter an amount from $0 to $100,000.'],
      ['#f-price', '12,5', 'Check “Sell price”. Enter an amount from $0 to $100,000.'],
      ['#f-price', '', 'Check “Sell price”. Enter a sell price of at least $0.01.'],
      ['#f-price', '0.004', 'Check “Sell price”. Enter a sell price of at least $0.01.', 'rounds to $0'],
    ];
    for (const [id, value, want, why] of cases) {
      await page.fill(id, value);
      await settle(page);
      assert.equal(await verdict(page), want, why ?? `${id} = "${value}"`);
      assert.deepEqual(await state(), pending, 'a neutral prompt, and no rows for numbers that were never entered');
      assert.equal(await page.locator(id).getAttribute('aria-invalid'), 'true', 'the field itself says so');
      await page.fill('#f-price', '40');
      await page.fill('#f-cost', '8');
      await settle(page);
      assert.match(await verdict(page), /^Worth it\./);
      assert.equal((await state()).rows, 9);
    }
    // Enter goes to what needs fixing, not to the verdict (phones scroll there)...
    await page.setViewportSize({ width: 390, height: 844 });
    await page.fill('#f-price', '');
    await page.locator('#f-cost').press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'f-price');
    await page.fill('#f-price', '40');
    // ...even inside the Fine-tune panel after the user closed it.
    const setRate = (v) =>
      page.evaluate((value) => {
        const rate = document.querySelector('#f-tiktokRate');
        rate.value = value;
        rate.dispatchEvent(new Event('input', { bubbles: true }));
      }, v);
    await setRate('x');
    await settle(page);
    assert.equal(await page.locator('.tune').getAttribute('open'), '', 'a field going bad in Fine-tune opens it');
    await page.locator('.tune > summary').click();
    await page.fill('#f-price', '41');
    await settle(page);
    assert.equal(await page.locator('.tune').getAttribute('open'), null, 'closed by the user, it stays closed while they type');
    await page.locator('#f-price').press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'f-tiktokRate', 'Enter opens it and goes to the field');
    // Several bad fields are all named.
    await page.fill('#f-cost', 'abc');
    await settle(page);
    assert.equal(await verdict(page), 'Check “You paid” and “TikTok Shop fee”. Each says what it needs.');
    // A bad value no compared marketplace reads doesn't hold results back.
    await page.fill('#f-cost', '8');
    await page.locator('input[name="platform"][value="tiktok"]').uncheck();
    await settle(page);
    assert.match(await verdict(page), /^Worth it\./, 'a bad TikTok rate with TikTok unticked');
    await page.locator('input[name="platform"][value="tiktok"]').check();
    await setRate('6');
    for (const box of await page.locator('input[name="platform"]').all()) if ((await box.getAttribute('value')) !== 'poshmark') await box.uncheck();
    await page.fill('#f-label', 'junk');
    await settle(page);
    assert.match(await verdict(page), /^Worth it\. Best on Poshmark/, 'Poshmark buyers pay the label, so a bad label cost is ignored');
    await page.fill('#f-label', '7');
    // No marketplace picked: a prompt too, and Enter goes to the first box.
    await page.locator('input[name="platform"][value="poshmark"]').uncheck();
    await settle(page);
    assert.deepEqual(await state(), pending);
    assert.match(await verdict(page), /^No marketplaces selected\./);
    await page.locator('#f-price').press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('name')), 'platform');
    await context.close();

    // A link that can't be worked out shows no rows (not the page's own example),
    // and a new link's bad Fine-tune field opens the panel again.
    const link = await open('/#mode=maxbuy&price=');
    assert.equal(await verdict(link.page), 'Check “Sell price”. Enter a sell price of at least $0.01.');
    assert.equal(await link.page.locator('[data-results] > li').count(), 0);
    await link.page.goto(`${base}/#s=1&tiktokRate=abc`);
    await settle(link.page);
    assert.equal(await link.page.locator('.tune').getAttribute('open'), '');
    await link.page.locator('.tune > summary').click();
    await link.page.evaluate(() => (location.hash = '#s=1&tiktokRate=xyz&price=50'));
    await settle(link.page);
    assert.equal(await link.page.locator('.tune').getAttribute('open'), '', 'reopened for the new link');
    await link.context.close();
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
      await p.focus('#f-cost');
      await settle(p);
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
