#!/usr/bin/env node
// Regenerates the brand images in src/assets from icon.svg: PNG app icons,
// favicon.ico and the 1200x630 social card. Needed when the logo changes, or
// when `npm test` reports that the social card's numbers are out of date (a
// fee change moved them). The outputs are committed.
//
//   npm i --no-save playwright-core && node scripts/gen-images.mjs
//   (set CHROMIUM_PATH if Chromium is not on the default Playwright path)
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ogData } from './og-data.mjs';
import { esc } from '../src/engine/render.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = join(ROOT, 'src/assets/icons');
const svg = await readFile(join(ICONS, 'icon.svg'), 'utf8');
const hanger = svg.match(/<path[^>]*\/>/)[0];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();

// `transparent` keeps the rounded icon's corners see-through (for tabs, docks
// and launchers); maskable and Apple icons must be opaque full squares.
async function shot(html, width, height, { transparent = false } = {}) {
  await page.setViewportSize({ width, height });
  await page.setContent(`<!doctype html><html><head><style>html,body{margin:0}</style></head><body>${html}</body></html>`);
  return page.screenshot({ type: 'png', omitBackground: transparent });
}

const icon = (size) => `<div style="width:${size}px;height:${size}px">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div>`;
const maskable = (size) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32"><rect width="32" height="32" fill="#0b6b58"/><g transform="translate(16 16) scale(0.62) translate(-16 -16)">${hanger}</g></svg>`;

await writeFile(join(ICONS, 'icon-192.png'), await shot(icon(192), 192, 192, { transparent: true }));
await writeFile(join(ICONS, 'icon-512.png'), await shot(icon(512), 512, 512, { transparent: true }));
await writeFile(join(ICONS, 'maskable-512.png'), await shot(maskable(512), 512, 512));
await writeFile(join(ICONS, 'apple-touch-icon.png'), await shot(maskable(180), 180, 180));

// favicon.ico: a single 32x32 PNG wrapped in an ICO container.
const png32 = await shot(icon(32), 32, 32, { transparent: true });
const header = Buffer.alloc(22);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(1, 4); // image count
header.writeUInt8(32, 6); // width
header.writeUInt8(32, 7); // height
header.writeUInt16LE(1, 10); // color planes
header.writeUInt16LE(32, 12); // bits per pixel
header.writeUInt32LE(png32.length, 14);
header.writeUInt32LE(22, 18); // data offset
await writeFile(join(ROOT, 'src/assets/favicon.ico'), Buffer.concat([header, png32]));

// Social card with real numbers from the engine at the calculator defaults.
const data = ogData();
const rows = data.rows
  .map((r) => `<div class="row${r.best ? ' best' : ''}"><span class="n">${r.rank}</span><span class="p">${esc(r.name)}</span><span class="v">${esc(r.profit)}</span></div>`)
  .join('');
const og = `
<style>
*{box-sizing:border-box}
.card{width:1200px;height:630px;padding:72px;display:flex;gap:56px;align-items:center;background:#fbfaf7;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#16201d;position:relative;overflow:hidden}
.card:before{content:'';position:absolute;right:-160px;top:-160px;width:640px;height:640px;border-radius:50%;background:#e3f3ee}
.left{flex:1;position:relative}
.brand{display:flex;align-items:center;gap:16px;font-size:34px;font-weight:800;letter-spacing:-.02em}
h1{font-size:64px;line-height:1.04;letter-spacing:-.03em;margin:36px 0 20px;font-weight:850}
p{font-size:27px;color:#56615d;margin:0;line-height:1.35}
.panel{position:relative;width:480px;flex:none;background:#fff;border:1px solid #e2dfd8;border-radius:28px;padding:28px;box-shadow:0 20px 50px rgba(22,32,29,.12)}
.cap{font-size:20px;color:#56615d;margin-bottom:16px}
.row{display:flex;align-items:center;gap:14px;padding:16px 18px;border:1px solid #e2dfd8;border-radius:18px;margin-top:10px;font-size:25px;font-weight:700}
.row.best{border-color:#0b6b58;box-shadow:inset 6px 0 0 #0b6b58}
.n{flex:none;width:34px;height:34px;border-radius:50%;display:grid;place-items:center;background:#f3f1ec;color:#56615d;font-size:17px}
.best .n{background:#0b6b58;color:#fff}
.p{flex:1;white-space:nowrap}
.v{color:#0b6b58;font-variant-numeric:tabular-nums}
</style>
<div class="card">
<div class="left">
<div class="brand">${svg.replace('<svg ', '<svg width="56" height="56" ')}${esc(data.name)}</div>
<h1>Know your real profit before you buy.</h1>
<p>Free calculator for resellers: fees, payout and profit on ${data.marketplaces} marketplaces.</p>
</div>
<div class="panel">
<div class="cap">$${data.caption.price} sale &middot; $${data.caption.cost} cost &middot; $${data.caption.label} label</div>
${rows}
</div>
</div>`;
await writeFile(join(ROOT, 'src/assets/og.png'), await shot(og, 1200, 630));
await writeFile(join(ROOT, 'src/assets/og.json'), `${JSON.stringify(data, null, 2)}\n`);

await browser.close();
console.log('Brand images written to src/assets');
