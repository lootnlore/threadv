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
    const sizes = [[320, 1], [320, 1.25], [320, 1.5], [320, 2], [330, 1.25], [360, 1.25], [390, 1], [390, 1.5], [390, 2], [414, 1], [900, 1.75], [1280, 1], [1280, 1.75]];
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
          // ...or break in the middle of a word ("Merca/ri"): each word's line boxes must share one line.
          const walker = document.createTreeWalker(calc, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const el = node.parentElement;
            if (!el.getClientRects().length || el.closest('.visually-hidden, select')) continue;
            for (const word of node.textContent.matchAll(/[^\s-]+/g)) {
              const range = document.createRange();
              range.setStart(node, word.index);
              range.setEnd(node, word.index + word[0].length);
              if (new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size > 1) found.push(`word split across lines: "${word[0]}"`);
            }
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
        assert.deepEqual(problems, [], `${width}px, text ${text * 100}%, ${state}`);
      }
      await context.close();
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

  test('no page scrolls sideways, from small phones to desktops, even with large text', async () => {
    const pages = ['/', '/fees/', '/fees/ebay/', '/fees/facebook/', '/tracker/', '/privacy/', '/terms/', '/404.html', '/offline.html'];
    const problems = [];
    for (const width of [320, 360, 414, 600, 768, 800, 1024, 1280]) {
      for (const text of [1, 1.25, 1.5, 2]) {
        const { context, page } = await open(null, { viewport: { width, height: 800 }, serviceWorkers: 'block' });
        await setTextSize(page, text);
        for (const path of pages) {
          await page.goto(base + path, { waitUntil: 'domcontentloaded' });
          await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
          const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
          if (over > 0) problems.push(`${width}px, text ${text * 100}%, ${path}: +${over}px`);
        }
        await context.close();
      }
    }
    assert.deepEqual(problems, []);
  });

  test('the header stays on one row and never cuts the site name short', async () => {
    for (const name of ['', 'ResellerCalculatorPro']) {
      if (name) build({ SITE_NAME: name });
      try {
        for (const width of [320, 360, 390, 430, 480, 768, 1280]) {
          for (const text of [1, 1.25, 1.5]) {
            const { context, page } = await open(null, { viewport: { width, height: 700 } });
            await setTextSize(page, text);
            await page.goto(`${base}/fees/`, { waitUntil: 'networkidle' });
            const where = `${width}px, text ${text * 100}%${name ? `, "${name}"` : ''}`;
            const r = await page.evaluate(() => {
              const brand = document.querySelector('.site-header .brand').getBoundingClientRect();
              const name = document.querySelector('.site-header .brand span').getBoundingClientRect();
              const shown = name.top < brand.bottom - 1; // on the logo's line, not the clipped one below
              return {
                rowGap: Math.abs(brand.top - document.querySelector('.site-header nav').getBoundingClientRect().top),
                cut: shown && name.right > brand.right + 1,
                sideways: document.documentElement.scrollWidth - innerWidth,
              };
            });
            assert.ok(r.rowGap < 20, `${where}: nav wrapped under the logo`);
            // Either the whole name or just the logo (name still read out): never "Threa…".
            assert.ok(!r.cut, `${where}: site name cut short`);
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
