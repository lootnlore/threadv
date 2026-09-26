#!/usr/bin/env node
// Static site builder. Zero dependencies: renders every page from
// src/pages, versions the assets, and writes a deployable folder.
//
//   node scripts/build.mjs            -> dist/
//   node scripts/build.mjs --out tmp  -> tmp/
import { mkdir, readFile, writeFile, rm, cp, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import config from '../site.config.mjs';
import { layout } from '../src/pages/layout.mjs';
import { abs } from '../src/pages/components.mjs';
import { home } from '../src/pages/home.mjs';
import { feesHub, feePage } from '../src/pages/fees.mjs';
import { tracker } from '../src/pages/tracker.mjs';
import { privacy, terms, notFound, offline } from '../src/pages/legal.mjs';
import { PLATFORMS, usdText } from '../src/engine/fees.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.indexOf('--out');
if (outArg > -1 && !/^[^-]/.test(process.argv[outArg + 1] ?? '')) throw new Error('--out needs a directory');
const OUT = resolve(ROOT, outArg > -1 ? process.argv[outArg + 1] : 'dist');
const MARKER = '.threadvet-build';
const quiet = process.argv.includes('--quiet');

// Browser modules in dependency order (a module's imports come before it).
// Each is published as <name>.<content hash>.js with its imports rewritten.
const MODULES = [
  ['src/engine/fees.mjs', 'fees'],
  ['src/engine/calc.mjs', 'calc'],
  ['src/engine/render.mjs', 'render'],
  ['src/assets/app.js', 'app'],
];

const hash = (...parts) => {
  const h = createHash('sha256');
  for (const part of parts) h.update(part);
  return h.digest('hex').slice(0, 10);
};

/** The build wipes OUT, so only allow folders it created (or new/empty ones). */
async function assertSafeToClean(dir) {
  const rel = relative(dir, ROOT);
  if (!rel.startsWith('..')) throw new Error(`Refusing to build into ${dir}: it contains the project.`);
  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return; // does not exist yet
    throw new Error(`Refusing to build into ${dir}: ${err.code === 'ENOTDIR' ? 'it is a file' : err.message}.`);
  }
  if (entries.length && !entries.includes(MARKER) && dir !== join(ROOT, 'dist')) {
    throw new Error(`Refusing to wipe ${dir}: it is not empty and was not created by this build.`);
  }
}

function minifyCss(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};,>])\s*/g, '$1')
    .replace(/;}/g, '}')
    .trim();
}

function validateConfig() {
  const problems = [];
  const url = new URL(config.url);
  if (url.pathname !== '/' || config.url.endsWith('/')) problems.push('config.url must be an origin with no path or trailing slash');
  const { price } = config.tracker;
  // Whole cents, allowing for binary floats (19.99 * 100 is 1998.9999999999998).
  if (!(typeof price === 'number' && price > 0 && Math.abs(price * 100 - Math.round(price * 100)) < 1e-6)) {
    problems.push(`tracker.price must be a positive number of dollars and cents, like 19 or 24.50 (got ${price})`);
  }
  // Outside links must be https: the page CSP only allows https form targets,
  // and nothing else (javascript:, data:...) belongs in an href.
  const external = [
    ...config.crosslisters.map((c) => [`crosslisters ${c.id} url`, c.url]),
    ['tracker.checkoutUrl', config.tracker.checkoutUrl],
    ['newsletter.action', config.newsletter.action],
  ];
  for (const [name, value] of external) {
    if (!value) continue;
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      problems.push(`${name} is not a valid URL: ${value}`);
      continue;
    }
    if (parsed.protocol !== 'https:') problems.push(`${name} must start with https:// (got ${value})`);
  }
  if (problems.length) throw new Error(problems.join('\n'));

  const todo = [];
  if (!config.tracker.checkoutUrl) todo.push(`Add tracker.checkoutUrl so the ${usdText(config.tracker.price)} tracker can be bought`);
  if (config.crosslisters.some((c) => new URL(c.url).search === '' && new URL(c.url).pathname === '/')) {
    todo.push('Swap crosslister URLs for your referral links (they earn 20% recurring)');
  }
  if (!config.newsletter.action) todo.push('Add newsletter.action to collect fee-alert emails');
  if (!config.contactEmail) todo.push('Add contactEmail for support and legal pages');
  return todo;
}

async function write(rel, content) {
  const file = join(OUT, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function build() {
  const todo = validateConfig();
  await assertSafeToClean(OUT);
  await rm(OUT, { recursive: true, force: true });
  await write(MARKER, 'Created by scripts/build.mjs. This folder is wiped on every build.\n');

  // ---- assets: content-hashed names, so a URL always means the same bytes ----
  const css = minifyCss(await readFile(join(ROOT, 'src/assets/styles.css'), 'utf8'));
  const published = { css: `styles.${hash(css)}.css` };
  await write(`assets/${published.css}`, css);
  for (const [src, name] of MODULES) {
    // JS ships unminified: it is small, gzip does most of the work, and a
    // regex "minifier" is one clever edit away from deleting real code.
    const code = (await readFile(join(ROOT, src), 'utf8')).replace(
      /from (['"])(?:\.\.\/engine\/|\.\/)([a-z]+)\.mjs\1/g,
      (_, quote, mod) => {
        if (!published[mod]) throw new Error(`${src} imports ${mod} before it is built; fix MODULES order`);
        return `from './${published[mod]}'`;
      },
    );
    // Any import left pointing at a source file would 404 in the browser.
    const leftover = code.match(/(?:\bfrom|\bimport)\s*\(?\s*['"][^'"]+\.mjs['"]/);
    if (leftover) throw new Error(`${src}: cannot publish "${leftover[0]}". Browser modules may only import src/engine/*.mjs.`);
    published[name] = `${name}.${hash(code)}.js`;
    await write(`assets/${published[name]}`, code);
  }
  // Classic (non-module) scripts: offline support on every page, and analytics.
  for (const name of ['offline', 'analytics']) {
    const code = await readFile(join(ROOT, `src/assets/${name}.js`), 'utf8');
    published[name] = `${name}.${hash(code)}.js`;
    await write(`assets/${published[name]}`, code);
  }
  await write('assets/manifest.json', `${JSON.stringify(Object.values(published), null, 2)}\n`);
  // Skip dotfiles (.DS_Store...): nginx refuses them, which would break precaching.
  const iconFiles = (await readdir(join(ROOT, 'src/assets/icons'))).filter((f) => !f.startsWith('.')).sort();
  for (const f of iconFiles) await cp(join(ROOT, 'src/assets/icons', f), join(OUT, 'assets/icons', f));
  await cp(join(ROOT, 'src/assets/og.png'), join(OUT, 'assets/og.png'));
  await cp(join(ROOT, 'src/assets/favicon.ico'), join(OUT, 'favicon.ico'));

  const url = (name) => `/assets/${name}`;
  const assets = {
    css: url(published.css),
    app: url(published.app),
    modules: ['fees', 'calc', 'render'].map((m) => url(published[m])),
    analytics: url(published.analytics),
    offline: url(published.offline),
  };

  // ---- pages ----
  const pages = [
    home(config),
    feesHub(config),
    ...PLATFORMS.map((p) => feePage(config, p)),
    tracker(config),
    privacy(config),
    terms(config),
    notFound(config),
    offline(config),
  ];
  const rendered = pages.map((page) => [page, layout(page, config, assets)]);
  for (const [page, html] of rendered) {
    const file = page.path.endsWith('/') ? `${page.path}index.html` : page.path;
    await write(file.slice(1), html);
  }
  // The service worker's cache name covers the pages and static images too
  // (asset names already carry their own hashes), so any visible change
  // refreshes what installed users see offline.
  const webmanifest = JSON.stringify(
    {
      id: '/',
      name: `${config.name} Reseller Profit Calculator`,
      short_name: config.name,
      description: config.description,
      start_url: '/?source=pwa',
      scope: '/',
      display: 'standalone',
      background_color: '#fbfaf7',
      theme_color: '#0b6b58',
      icons: [
        { src: '/assets/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/assets/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/assets/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    null,
    2,
  );
  await write('manifest.webmanifest', webmanifest);

  const staticFiles = [
    ...iconFiles.map((f) => join(ROOT, 'src/assets/icons', f)),
    join(ROOT, 'src/assets/og.png'),
    join(ROOT, 'src/assets/favicon.ico'),
  ];
  const swVersion = hash(
    webmanifest,
    ...rendered.map(([, html]) => html),
    ...(await Promise.all(staticFiles.map((f) => readFile(f)))),
  );

  // ---- crawl + install metadata ----
  // lastmod is each page's real content date, not the build date, so search
  // engines can trust it when fees change.
  const indexable = pages.filter((p) => !p.noindex);
  for (const p of indexable) if (!/^\d{4}-\d{2}-\d{2}$/.test(p.lastmod ?? '')) throw new Error(`${p.path} needs a lastmod date`);
  await write(
    'sitemap.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${indexable.map((p) => `<url><loc>${abs(config, p.path)}</loc><lastmod>${p.lastmod}</lastmod></url>`).join('\n')}
</urlset>
`,
  );
  await write('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${abs(config, '/sitemap.xml')}\n`);
  const icons = [...iconFiles.map((f) => `/assets/icons/${f}`), '/favicon.ico'];
  // Every page loads offline.js (and analytics.js when enabled), so they must be
  // cached too or a page served from the cache would fail its script loads.
  const scripts = [assets.offline, ...(config.analytics.plausibleDomain ? [assets.analytics] : [])];
  const precache = ['/', '/fees/', '/offline.html', assets.css, assets.app, ...assets.modules, ...scripts, ...icons, '/manifest.webmanifest'];
  const sw = (await readFile(join(ROOT, 'src/assets/sw.js'), 'utf8'))
    .replace("'__VERSION__'", JSON.stringify(swVersion))
    .replace('__PRECACHE__', JSON.stringify(precache));
  await write('sw.js', sw);

  if (!quiet) {
    console.log(`Built ${pages.length} pages to ${OUT} (cache ${swVersion}) for ${config.url}`);
    if (todo.length) console.log(`\nTo start earning:\n${todo.map((t) => `  - ${t}`).join('\n')}\n`);
  }
  return { pages, swVersion };
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
