import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, statSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { createServer, request } from 'node:http';
import vm from 'node:vm';
import config from '../site.config.mjs';
import { FEES_VERIFIED, PLATFORMS, percentOf } from '../src/engine/fees.mjs';
import { IRS_MILEAGE_RATES, MILEAGE_YEAR } from '../src/data/mileage.mjs';
import { createStaticHandler, insideRoot } from '../scripts/serve.mjs';
import { ogData, rowsToShow, CARD_ROWS } from '../scripts/og-data.mjs';
import { DEFAULTS } from '../src/engine/calc.mjs';
import { builtOutput } from '../src/engine/render.mjs';
import { stripJs } from '../scripts/strip-js.mjs';
import { MODULES, CLASSIC_SCRIPTS } from '../scripts/assets.mjs';

const OUT = mkdtempSync(join(tmpdir(), 'threadvet-'));
const tempDirs = [OUT];
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
execFileSync(process.execPath, ['scripts/build.mjs', '--out', OUT, '--quiet'], { cwd: new URL('..', import.meta.url) });

const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const files = walk(OUT);
const html = files.filter((f) => f.endsWith('.html')).map((f) => ({ file: relative(OUT, f), src: readFileSync(f, 'utf8') }));
const pathOf = (file) => (file.endsWith('index.html') ? `/${file.replace(/index\.html$/, '')}` : `/${file}`);
const NOINDEX = new Set(['404.html', 'offline.html']);

/** A throwaway copy of everything the build reads, for tests that edit sources or could delete files. */
function copyProject() {
  const copy = mkdtempSync(join(tmpdir(), 'threadvet-copy-'));
  tempDirs.push(copy);
  for (const entry of ['scripts', 'src', 'site.config.mjs', 'package.json']) {
    cpSync(fileURLToPath(new URL(`../${entry}`, import.meta.url)), join(copy, entry), { recursive: true });
  }
  return copy;
}

function resolves(url) {
  const clean = url.split(/[?#]/)[0];
  if (clean === '') return true;
  const target = join(OUT, clean);
  return clean.endsWith('/') ? existsSync(join(target, 'index.html')) : existsSync(target);
}

test('builds every expected page', () => {
  assert.equal(html.length, 16);
  for (const f of ['index.html', 'fees/index.html', 'fees/ebay/index.html', 'tracker/index.html', 'privacy/index.html', 'terms/index.html', '404.html', 'offline.html']) {
    assert.ok(html.some((h) => h.file === f), f);
  }
});

test('each calculator is built showing builtOutput(), which the app takes as already drawn', () => {
  const calculators = html.filter((h) => h.src.includes('data-calc'));
  assert.ok(calculators.length >= 1 + PLATFORMS.length, 'the home page and every fee page');
  for (const { file, src } of calculators) {
    const focus = src.match(/data-calc data-focus="([a-z]+)"/)?.[1];
    const { tone, verdict, list } = builtOutput(focus);
    assert.ok(src.includes(`<div class="verdict verdict-${tone}" data-verdict tabindex="-1">${verdict}</div>`), `${file}: its verdict`);
    assert.ok(src.includes(`aria-label="Results by marketplace">${list}</ul>`), `${file}: its list`);
  }
});

test('stripped scripts work as written: the engine tests pass against stripped engine code, and every published script parses', () => {
  const copy = copyProject();
  mkdirSync(join(copy, 'test'));
  cpSync(fileURLToPath(new URL('./engine.test.mjs', import.meta.url)), join(copy, 'test/engine.test.mjs'));
  for (const [src] of MODULES.filter(([file]) => file.startsWith('src/engine/'))) {
    const file = join(copy, src);
    writeFileSync(file, stripJs(readFileSync(file, 'utf8')));
  }
  execFileSync(process.execPath, ['--test', 'test/engine.test.mjs'], { cwd: copy, stdio: 'pipe' });
  // Parsed, not run (app.js needs a page): modules as modules, classic
  // scripts as the scripts a page runs them as.
  const checked = join(copy, 'checked');
  mkdirSync(checked);
  for (const file of readdirSync(join(OUT, 'assets')).filter((f) => f.endsWith('.js'))) {
    const code = readFileSync(join(OUT, 'assets', file), 'utf8');
    if (CLASSIC_SCRIPTS.some(([, name]) => file.startsWith(`${name}.`))) new vm.Script(code, { filename: file });
    else {
      writeFileSync(join(checked, file.replace(/\.js$/, '.mjs')), code);
      execFileSync(process.execPath, ['--check', join(checked, file.replace(/\.js$/, '.mjs'))], { stdio: 'pipe' });
    }
    assert.ok(!/^\s*\/\//m.test(code), `${file}: comments stripped`);
  }
});

test('stripped scripts tokenize exactly as their sources, each token on its own line', () => {
  // Read by Node's own copy of acorn, a tokenizer independent of the
  // stripper: same tokens, same values, same line numbers (so automatic
  // semicolons fall where they did, and errors point at the source).
  const dir = mkdtempSync(join(tmpdir(), 'threadvet-strip-'));
  tempDirs.push(dir);
  const pairs = [];
  for (const [src, classic] of [...MODULES.map(([file]) => [file, false]), ...CLASSIC_SCRIPTS.map(([file]) => [file, true])]) {
    const source = fileURLToPath(new URL(`../${src}`, import.meta.url));
    const stripped = join(dir, `${pairs.length}.js`);
    writeFileSync(stripped, stripJs(readFileSync(source, 'utf8')));
    pairs.push([source, stripped, classic ? 'script' : 'module']);
  }
  // (Node keeps acorn at this internal path; were it moved, this fails
  // saying so, rather than passing unchecked.)
  const reader = `
    const { tokenizer } = require('internal/deps/acorn/acorn/dist/acorn');
    const { readFileSync } = require('node:fs');
    const shown = (v) => (v && typeof v === 'object' && 'pattern' in v ? '/' + v.pattern + '/' + v.flags : typeof v + ':' + String(v));
    const tokens = (file, sourceType) => [...tokenizer(readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType, locations: true })]
      .map((t) => t.type.label + ' ' + shown(t.value) + ' @' + t.loc.start.line);
    for (const [source, stripped, sourceType] of JSON.parse(process.argv[1])) {
      const [a, b] = [tokens(source, sourceType), tokens(stripped, sourceType)];
      const at = a.findIndex((t, i) => t !== b[i]);
      if (at >= 0) console.log(source + ': token ' + at + ', ' + a[at] + ', became ' + b[at]);
      else if (a.length !== b.length) console.log(source + ': ' + a.length + ' tokens became ' + b.length);
      else console.log('same');
    }`;
  let report;
  try {
    report = execFileSync(process.execPath, ['--expose-internals', '-e', reader, JSON.stringify(pairs)], { encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    assert.fail(`the token check could not run: ${err.stderr || err.message}`);
  }
  assert.deepEqual(report.trim().split('\n'), pairs.map(() => 'same'));
});

test('the build refuses asset names the site cannot read, and a failed build keeps the last one', () => {
  const copy = copyProject();
  const run = () => execFileSync(process.execPath, ['scripts/build.mjs', '--quiet'], { cwd: copy, stdio: 'pipe' });
  run(); // a good build there to keep
  // Readable as any folder made here is (a web server runs as another user).
  mkdirSync(join(copy, 'plain'));
  assert.equal(statSync(join(copy, 'dist')).mode & 0o777, statSync(join(copy, 'plain')).mode & 0o777, 'the output has a plain folder\'s permissions');
  const kept = readdirSync(join(copy, 'dist')).sort();
  const list = join(copy, 'scripts/assets.mjs');
  const good = readFileSync(list, 'utf8');
  for (const [from, to, why] of [
    ["['src/assets/offline.js', 'offline']", "['src/assets/offline.js', 'off-line']", /lowercase letters only/],
    ["['src/assets/offline.js', 'offline']", "['src/assets/offline.js', 'css']", /not "css"/],
    ["['src/assets/analytics.js', 'analytics']", "['src/assets/analytics.js', 'offline']", /published twice/],
    ["['src/engine/fees.mjs', 'fees']", "['src/engine/fees.mjs', 'pricing']", /its file's name/],
    ["['src/assets/offline.js', 'offline']", "['src/assets/offline.js', 'online']", /nothing is published as "offline"/],
    // Found part-way through: a module listed before what it imports.
    ["  ['src/engine/fees.mjs', 'fees'],\n  ['src/engine/calc.mjs', 'calc'],", "  ['src/engine/calc.mjs', 'calc'],\n  ['src/engine/fees.mjs', 'fees'],", /fix MODULES order/],
  ]) {
    assert.ok(good.includes(from), from);
    writeFileSync(list, good.replace(from, to));
    assert.throws(run, (err) => why.test(String(err.stderr)), to);
    assert.deepEqual(readdirSync(join(copy, 'dist')).sort(), kept, `${to}: the last build kept, whole`);
    assert.deepEqual(readdirSync(copy).filter((name) => name.startsWith('.dist.building')), [], `${to}: nothing half-built left`);
  }
});

test('every page has complete, sane metadata', () => {
  for (const { file, src } of html) {
    assert.match(src, /^<!DOCTYPE html>\n<html lang="en">/, file);
    const title = src.match(/<title>([^<]+)<\/title>/)?.[1];
    assert.ok(title && title.length <= 80, `${file}: title "${title}"`);
    const desc = src.match(/<meta name="description" content="([^"]+)">/)?.[1];
    assert.ok(desc && desc.length >= 50 && desc.length <= 170, `${file}: description length ${desc?.length}`);
    assert.equal(src.match(/<h1[\s>]/g)?.length, 1, `${file}: exactly one h1`);
    if (NOINDEX.has(file)) {
      assert.match(src, /<meta name="robots" content="noindex">/);
    } else {
      assert.ok(src.includes(`<link rel="canonical" href="${config.url}${pathOf(file)}">`), `${file}: canonical`);
    }
  }
});

test('no template leaks in output', () => {
  for (const { file, src } of html) {
    for (const bad of ['undefined', 'NaN', '[object Object]', '${', '&amp;amp;']) {
      assert.ok(!src.includes(bad), `${file} contains ${bad}`);
    }
  }
  const sw = readFileSync(join(OUT, 'sw.js'), 'utf8');
  assert.ok(!sw.includes('__VERSION__') && !sw.includes('__PRECACHE__'));
});

test('nav marks the current page, and only the section on sub-pages', () => {
  const nav = (file) => html.find((h) => h.file === file).src.match(/<nav aria-label="Main">[\s\S]*?<\/nav>/)[0];
  const ebay = nav('fees/ebay/index.html');
  assert.match(ebay, /<a href="\/fees\/" aria-current="true">/);
  assert.ok(!ebay.includes('aria-current="page"'));
  assert.match(nav('fees/index.html'), /<a href="\/fees\/" aria-current="page">/);
});

test('ids are unique within each page', () => {
  for (const { file, src } of html) {
    const ids = [...src.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, `${file}: duplicate id`);
  }
});

test('internal links and assets resolve', () => {
  for (const { file, src } of html) {
    for (const [, url] of src.matchAll(/(?:href|src)="(\/[^"]*)"/g)) {
      assert.ok(resolves(url), `${file} -> ${url}`);
    }
  }
  const sw = readFileSync(join(OUT, 'sw.js'), 'utf8');
  for (const url of JSON.parse(sw.match(/const PRECACHE = (\[.*?\]);/)[1])) assert.ok(resolves(url), `precache ${url}`);
  const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.webmanifest'), 'utf8'));
  for (const icon of manifest.icons) assert.ok(resolves(icon.src), icon.src);
});

test('assets are content-hashed and import each other by hashed name', () => {
  const manifest = JSON.parse(readFileSync(join(OUT, 'assets', 'manifest.json'), 'utf8'));
  assert.equal(manifest.length, 7); // styles + 4 modules + offline + analytics
  for (const name of manifest) {
    assert.match(name, /^[a-z]+\.[0-9a-f]{10}\.(js|css)$/);
    const src = readFileSync(join(OUT, 'assets', name), 'utf8');
    for (const [, spec] of src.matchAll(/from '([^']+)'/g)) {
      assert.match(spec, /^\.\/[a-z]+\.[0-9a-f]{10}\.js$/, `${name} imports ${spec}`);
      assert.ok(manifest.includes(spec.slice(2)), spec);
    }
  }
});

test('refuses to wipe folders it did not create', () => {
  // Runs a copy of the project, so a broken guard could only ever wipe the copy.
  const copy = copyProject();
  const run = (out) => execFileSync(process.execPath, ['scripts/build.mjs', '--out', out, '--quiet'], { cwd: copy, stdio: 'pipe' });
  assert.throws(() => run('.'), /contains the project/);
  assert.throws(() => run('src'), /not created by this build/);
  const foreign = mkdtempSync(join(tmpdir(), 'threadvet-foreign-'));
  tempDirs.push(foreign);
  writeFileSync(join(foreign, 'keep.txt'), 'mine');
  assert.throws(() => run(foreign), /not created by this build/);
  assert.ok(existsSync(join(foreign, 'keep.txt')) && existsSync(join(copy, 'src/engine/fees.mjs')), 'nothing was deleted');
  // Beside the output: a stage, or a last build moved aside, untouched for
  // an hour (its build died) is swept; fresh ones (a build running, maybe
  // in another container, which removes its own) are left alone, and so,
  // said, is a folder of that name the build didn't make.
  const beside = mkdtempSync(join(tmpdir(), 'threadvet-beside-'));
  tempDirs.push(beside);
  const stage = (name, { ours = true, hoursAgo = 0 } = {}) => {
    mkdirSync(join(beside, name));
    writeFileSync(join(beside, name, ours ? '.threadvet-build' : 'keep.txt'), '');
    const when = new Date(Date.now() - hoursAgo * 3600_000);
    utimesSync(join(beside, name), when, when);
  };
  stage('.site.building-dead01', { hoursAgo: 2 });
  stage('.site.building-dead02-old', { hoursAgo: 2 });
  stage('.site.building-live01');
  stage('.site.building-live02-old');
  mkdirSync(join(beside, '.site.building-empty01')); // a build killed before it wrote anything
  utimesSync(join(beside, '.site.building-empty01'), new Date(Date.now() - 7200_000), new Date(Date.now() - 7200_000));
  run(join(beside, 'site'));
  assert.deepEqual(readdirSync(beside).sort(), ['.site.building-live01', '.site.building-live02-old', 'site'], "a dead build's leftovers swept; a running build's left");
  stage('.site.building-mine01', { ours: false, hoursAgo: 2 });
  const { status, stderr } = spawnSync(process.execPath, ['scripts/build.mjs', '--out', join(beside, 'site'), '--quiet'], { cwd: copy, encoding: 'utf8' });
  assert.deepEqual([status, /Left .*building-mine01 alone/.test(stderr)], [0, true], stderr);
  assert.ok(existsSync(join(beside, '.site.building-mine01/keep.txt')), 'nothing was deleted beside it');
  run(OUT); // its own previous output is fine
});

test('a build that fails while replacing the last one never leaves it part-deleted, or gone', () => {
  // The last build is moved aside whole, never deleted where it stands:
  // here deleting it would fail part-way (one file gone, then an error).
  const copy = copyProject();
  const out = join(copy, 'site');
  const run = () => execFileSync(process.execPath, ['--import', './fault.mjs', 'scripts/build.mjs', '--out', out, '--quiet'], { cwd: copy, stdio: 'pipe', env: { ...process.env, FAULT_OUT: out } });
  writeFileSync(
    join(copy, 'fault.mjs'),
    `import fs from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const rm = fs.rm;
fs.rm = async (path, options) => {
  if (path !== process.env.FAULT_OUT) return rm(path, options);
  unlinkSync(\`\${path}/robots.txt\`);
  throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
};
syncBuiltinESMExports(); // (the build's own import of rm sees this one)
`,
  );
  run();
  const whole = readdirSync(out, { recursive: true }).sort();
  run();
  assert.deepEqual(readdirSync(out, { recursive: true }).sort(), whole);
  const left = () => readdirSync(copy).filter((name) => name.startsWith('.site.'));
  // Nor if putting the new one in its place fails (on Windows a virus
  // scanner can hold a new folder): the last one goes back.
  writeFileSync(
    join(copy, 'fault.mjs'),
    `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const rename = fs.rename;
fs.rename = async (from, to) => {
  if (to === process.env.FAULT_OUT && !from.endsWith('-old')) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  return rename(from, to);
};
syncBuiltinESMExports();
`,
  );
  assert.throws(run, (err) => /EPERM/.test(String(err.stderr)));
  assert.deepEqual([readdirSync(out, { recursive: true }).sort(), left()], [whole, []], 'the swap refused: the last build back, whole');
  // Nor if the build's own folder was swept while it was paused (over an
  // hour: a laptop asleep), and what it wrote after rebuilt only part of it.
  writeFileSync(
    join(copy, 'fault.mjs'),
    `import fs from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const writeFile = fs.writeFile;
fs.writeFile = async (file, ...rest) => {
  if (String(file).endsWith('/sw.js')) unlinkSync(String(file).replace(/sw\\.js$/, '.threadvet-build'));
  return writeFile(file, ...rest);
};
syncBuiltinESMExports();
`,
  );
  assert.throws(run, (err) => /removed while it ran/.test(String(err.stderr)));
  assert.deepEqual([readdirSync(out, { recursive: true }).sort(), left()], [whole, []], 'its folder swept mid-build: nothing published');
  const swept = readFileSync(join(copy, 'fault.mjs'), 'utf8');
  // If neither the new build nor the last can be put in place, the last is
  // kept beside it, and said; a build an hour later puts it back (here, one
  // that then publishes nothing of its own).
  writeFileSync(
    join(copy, 'fault.mjs'),
    `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const rename = fs.rename;
fs.rename = async (from, to) => {
  if (to === process.env.FAULT_OUT) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  return rename(from, to);
};
syncBuiltinESMExports();
`,
  );
  assert.throws(run, (err) => /The last build is kept in .*-old/.test(String(err.stderr)));
  const [aside] = left();
  assert.deepEqual([existsSync(out), left().length, readdirSync(join(copy, aside), { recursive: true }).sort()], [false, 1, whole], 'neither put in place: the last build kept, whole');
  const hourAgo = new Date(Date.now() - 2 * 3600_000);
  utimesSync(join(copy, aside), hourAgo, hourAgo);
  writeFileSync(join(copy, 'fault.mjs'), swept);
  assert.throws(run, (err) => /removed while it ran/.test(String(err.stderr)));
  assert.deepEqual([readdirSync(out, { recursive: true }).sort(), left()], [whole, []], 'an hour on: put back');
});

test('builds running at the same time into one folder leave it whole', async () => {
  const copy = copyProject();
  const out = join(copy, 'site');
  const files = (dir) => readdirSync(dir, { recursive: true }).sort();
  const build = () => {
    const child = spawn(process.execPath, ['scripts/build.mjs', '--out', out, '--quiet'], { cwd: copy });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const finished = new Promise((done) => child.on('close', (code) => done({ code, stderr })));
    return finished;
  };
  // Once a build has started writing (its stage there to see).
  const staged = () => readdirSync(copy).some((name) => name.startsWith('.site.building-'));
  const writing = async () => {
    for (let waited = 0; waited < 10_000 && !staged(); waited += 5) await new Promise((r) => setTimeout(r, 5));
    assert.ok(staged(), 'the first build started writing');
  };
  await build();
  const whole = files(out);
  // Started together, and the second once the first is writing (so it
  // finds the first's stage beside the output, which isn't its to sweep).
  // A big leftover from a build that died, for both to find at once (rounds
  // 0 and 2): one takes it, and neither finds it half-deleted.
  const leftover = () => {
    const dir = join(copy, '.site.building-dead');
    mkdirSync(join(dir, 'files'), { recursive: true });
    writeFileSync(join(dir, '.threadvet-build'), '');
    for (let i = 0; i < 2000; i++) writeFileSync(join(dir, 'files', `${i}.html`), '');
    const when = new Date(Date.now() - 2 * 3600_000);
    utimesSync(dir, when, when);
  };
  for (let round = 0; round < 6; round++) {
    if (round % 4 === 0) leftover();
    const first = build();
    if (round % 2) await writing();
    const results = await Promise.all([first, build()]);
    assert.deepEqual(files(out), whole, `round ${round}: the output whole`);
    assert.deepEqual(readdirSync(copy).filter((name) => name.startsWith('.site.')), [], `round ${round}: nothing left beside it`);
    for (const { code, stderr } of results) {
      // One may find the other's build swapped in first: said, not hidden.
      if (code) assert.match(stderr, /Another build of .* finished at the same moment/, `round ${round}`);
    }
  }
});

test('build rejects source changes that would ship a broken site', () => {
  const copy = copyProject();
  const run = (env = {}) =>
    execFileSync(process.execPath, ['scripts/build.mjs', '--quiet'], { cwd: copy, stdio: 'pipe', env: { ...process.env, ...env } });
  // A stray .DS_Store in the icons is neither published nor precached.
  writeFileSync(join(copy, 'src/assets/icons/.DS_Store'), 'x');
  run();
  assert.ok(!existsSync(join(copy, 'dist/assets/icons/.DS_Store')));
  assert.ok(!readFileSync(join(copy, 'dist/sw.js'), 'utf8').includes('.DS_Store'));
  // Double-quoted imports are rewritten too.
  const app = join(copy, 'src/assets/app.js');
  writeFileSync(app, readFileSync(app, 'utf8').replace("from '../engine/render.mjs'", 'from "../engine/render.mjs"'));
  run();
  const built = readdirSync(join(copy, 'dist/assets')).find((f) => f.startsWith('app.'));
  assert.ok(!readFileSync(join(copy, 'dist/assets', built), 'utf8').includes('.mjs'));
  // An import the build cannot publish stops the build instead of shipping a 404.
  writeFileSync(app, `import './helpers.mjs';\n${readFileSync(app, 'utf8')}`);
  assert.throws(() => run(), /cannot publish/);
  // Outside links must be https.
  writeFileSync(app, readFileSync(app, 'utf8').replace("import './helpers.mjs';\n", ''));
  assert.throws(() => run({ NEWSLETTER_ACTION: 'http://example.com/subscribe' }), /newsletter.action must start with https/);
  assert.throws(() => run({ TRACKER_CHECKOUT_URL: 'javascript:alert(1)' }), /tracker.checkoutUrl must start with https/);
  const cfg = join(copy, 'site.config.mjs');
  const original = readFileSync(cfg, 'utf8');
  writeFileSync(cfg, original.replace(/price: [\d.]+,/, 'price: 24.5,'));
  run();
  assert.match(readFileSync(join(copy, 'dist/tracker/index.html'), 'utf8'), /One-time \$24\.50/, 'prices show cents');
  for (const ok of ['19.99', '4.35', '1.10']) {
    writeFileSync(cfg, original.replace(/price: [\d.]+,/, `price: ${ok},`));
    run(); // float prices that are whole cents are accepted
  }
  writeFileSync(cfg, original.replace(/price: [\d.]+,/, 'price: 19.999,'));
  assert.throws(() => run(), /tracker.price must be a positive number/);
  writeFileSync(cfg, original.replace(/price: [\d.]+,/, "price: '19',"));
  assert.throws(() => run(), /tracker.price must be a positive number/);
});

test('structured data is valid JSON with a schema.org context', () => {
  for (const { file, src } of html) {
    for (const [, json] of src.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      const data = JSON.parse(json);
      assert.equal(data['@context'], 'https://schema.org', file);
    }
  }
});

test('everything a precached page loads is precached too, with or without analytics', () => {
  for (const env of [{}, { PLAUSIBLE_DOMAIN: 'example.com' }]) {
    const dir = mkdtempSync(join(tmpdir(), 'threadvet-'));
    tempDirs.push(dir);
    execFileSync(process.execPath, ['scripts/build.mjs', '--out', dir, '--quiet'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, ...env },
    });
    const precache = JSON.parse(readFileSync(join(dir, 'sw.js'), 'utf8').match(/const PRECACHE = (\[.*?\]);/)[1]);
    for (const page of precache.filter((u) => u.endsWith('/') || u.endsWith('.html'))) {
      const src = readFileSync(join(dir, page.endsWith('/') ? `${page}index.html` : page), 'utf8');
      // Everything the page itself loads: CSS, scripts, icons, the web manifest.
      const used = [...src.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
      assert.ok(used.filter((u) => /\.(js|css)$/.test(u)).length >= 2, `${page} loads its CSS and scripts`);
      assert.ok(used.includes('/favicon.ico'), `${page} links the favicon`);
      for (const url of used) assert.ok(precache.includes(url), `${page} loads ${url}, which is not precached (env ${JSON.stringify(env)})`);
    }
  }
});

test('preview server mirrors nginx: redirects stay on this site, dotfiles refused, real 404s', async () => {
  // Serve a copy of the site from a folder whose parent holds a file that must stay private.
  const base = mkdtempSync(join(tmpdir(), 'threadvet-serve-'));
  tempDirs.push(base);
  cpSync(OUT, join(base, 'site'), { recursive: true });
  writeFileSync(join(base, 'secret.txt'), 'private');
  mkdirSync(join(base, 'site-old'));
  writeFileSync(join(base, 'site-old', 'secret.txt'), 'private');
  mkdirSync(join(base, 'site', 'caf\u00e9'));
  writeFileSync(join(base, 'site', 'caf\u00e9', 'index.html'), 'ok');

  const server = createServer(createStaticHandler(join(base, 'site')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // Raw request paths: fetch() would normalize ../ and // before sending.
  const get = (path) =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server.address().port, path }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location }));
      });
      req.on('error', reject);
      req.end();
    });
  try {
    assert.deepEqual(await get('/fees?x=1'), { status: 301, location: '/fees/?x=1' });
    // Repeated or encoded slashes never produce a //host redirect.
    assert.deepEqual(await get('//fees'), { status: 301, location: '/fees/' });
    assert.ok(!(await get('/%2Ffees')).location.startsWith('//'));
    assert.ok(!(await get('/\\fees')).location.startsWith('//'));
    assert.deepEqual(await get('/caf%C3%A9'), { status: 301, location: '/caf%C3%A9/' }, 'Location stays encoded');
    assert.equal((await get('/fees/')).status, 200);
    assert.equal((await get('/no-such-page/')).status, 404);
    assert.equal((await get('/404.html')).status, 404, 'the error page is not a page of its own');
    for (const path of ['/.threadvet-build', '/%2Ethreadvet-build', '/.git/config']) assert.equal((await get(path)).status, 403, path);
    for (const path of ['/../secret.txt', '/..%2Fsecret.txt', '/%2e%2e/secret.txt', '/../site-old/secret.txt', '/..%2Fsite-old%2Fsecret.txt']) {
      assert.notEqual((await get(path)).status, 200, `${path} must not escape the site folder`);
    }
    assert.equal((await get('fees')).status, 400);
  } finally {
    server.close();
  }
});

test('preview server never maps a path outside its folder', () => {
  const root = join(tmpdir(), 'site');
  assert.equal(insideRoot(root, '/fees/../index.html'), join(root, 'index.html'));
  assert.equal(insideRoot(root, '/'), join(root, '/'));
  // Relative paths can climb: into the parent, or a sibling sharing the name prefix.
  assert.equal(insideRoot(root, '../secret.txt'), null);
  assert.equal(insideRoot(root, '../site-old/secret.txt'), null);
  assert.equal(insideRoot(root, 'a/../../site-old'), null);
});

test('renaming the site in site.config.mjs renames it everywhere', () => {
  const copy = copyProject();
  // Only the brand changes: the product name follows it (tracker.name derives from it).
  execFileSync(process.execPath, ['scripts/build.mjs', '--quiet'], { cwd: copy, stdio: 'pipe', env: { ...process.env, SITE_NAME: 'FlipCheck' } });
  const built = walk(join(copy, 'dist')).filter((f) => /\.(html|webmanifest)$/.test(f));
  for (const file of built) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!text.includes('ThreadVet'), `${relative(copy, file)} still says ThreadVet`);
  }
  assert.match(readFileSync(join(copy, 'dist/terms/index.html'), 'utf8'), /FlipCheck Reseller Tracker/);
  const title = () => readFileSync(join(copy, 'dist/tracker/index.html'), 'utf8').match(/<title>([^<]*)</)[1];
  assert.equal(title(), 'FlipCheck Reseller Tracker: Profit, Fee &amp; Tax Spreadsheet', 'the brand is already in the product name');

  // A product name of its own: used everywhere, and the title adds the brand.
  const cfg = join(copy, 'site.config.mjs');
  const edited = readFileSync(cfg, 'utf8').replace('name: `${name} Reseller Tracker`', "name: 'Resale Ledger'");
  assert.notEqual(edited, readFileSync(cfg, 'utf8'));
  writeFileSync(cfg, edited);
  execFileSync(process.execPath, ['scripts/build.mjs', '--quiet'], { cwd: copy, stdio: 'pipe', env: { ...process.env, SITE_NAME: 'FlipCheck' } });
  assert.equal(title(), 'Resale Ledger: Profit, Fee &amp; Tax Spreadsheet | FlipCheck');
  assert.match(readFileSync(join(copy, 'dist/terms/index.html'), 'utf8'), /buy the Resale Ledger/);
});

test('tracker launch signups are tagged so only they get the launch note', () => {
  const copy = copyProject();
  execFileSync(process.execPath, ['scripts/build.mjs', '--quiet'], { cwd: copy, stdio: 'pipe', env: { ...process.env, NEWSLETTER_ACTION: 'https://example.com/subscribe' } });
  const page = (path) => readFileSync(join(copy, 'dist', path), 'utf8');
  const { field, value } = config.newsletter.launchTag;
  assert.ok(page('tracker/index.html').includes(`<input type="hidden" name="${field}" value="${value}">`));
  assert.ok(!page('index.html').includes(`value="${value}"`), 'fee-alert signups are not tagged for the launch');
});

test('fee pages rank marketplaces by payout, ties sharing a rank', () => {
  const pages = html.filter((h) => /^fees\/[a-z]+\/index\.html$/.test(h.file));
  assert.equal(pages.length, PLATFORMS.length);
  for (const { file, src } of pages) {
    const list = src.match(/<ul class="compare" role="list">([\s\S]*?)<\/ul>/)[1];
    const rows = [...list.matchAll(/<span class="cmp-rank">(\d+)\.<\/span>[\s\S]*?<span class="num">\$([\d,.]+)<\/span>/g)].map(([, shown, payout]) => ({
      shown: Number(shown),
      payout: Number(payout.replace(/,/g, '')),
    }));
    assert.equal(rows.length, PLATFORMS.length, file);
    rows.forEach((row, i) => {
      const want = 1 + rows.filter((o) => o.payout > row.payout).length;
      assert.ok(i === 0 || rows[i - 1].payout >= row.payout, `${file}: sorted by payout`);
      assert.equal(row.shown, want, `${file}: ${row.payout} ranks ${want}`);
    });
  }
});

test('the social card lists up to four rows, cutting a tie only when more than four share first place', () => {
  const cases = [
    [[1, 2, 3, 4], 4],
    [[1, 2, 3, 4, 5], 4],
    [[1, 2, 3, 4, 4, 6], 3, 'a tie for 4th would make five: stop at 3rd'],
    [[1, 2, 2, 2, 2], 1],
    [[1, 1, 2, 3, 4], 4],
    [[1, 2, 3], 3],
    [[1, null, null], 1, 'never an out-of-range result'],
    [[null, null], 0],
    [[], 0],
    [[1, 1, 1, 1, 1], 4, 'more than four tied for first: the first four'],
  ];
  for (const [ranks, want, why] of cases) assert.equal(rowsToShow(ranks, CARD_ROWS), want, why ?? JSON.stringify(ranks));
  assert.throws(() => rowsToShow([2, 1, 3], CARD_ROWS), /best-first/, 'ranks out of order are refused, not miscounted');
  // Best as on the site: on the top row at the defaults, and nowhere when the
  // verdict would reject the top result (a minimum above every profit).
  assert.equal(ogData().rows[0].best, true);
  assert.equal(ogData({ ...DEFAULTS, price: 40, cost: 8, label: 7.5 }).caption, '$40 sale \u00b7 $8 cost \u00b7 $7.50 label', 'caption formatted as on the site');
  const rejected = ogData({ ...DEFAULTS, target: 1000 }).rows;
  assert.ok(rejected.length > 0 && rejected.every((r) => !r.best), JSON.stringify(rejected));
});

test('in High Contrast every focus ring uses the system focus colour', () => {
  // Chromium already paints a focused element's ring in Highlight, so this is
  // checked in the stylesheet: Firefox relies on the rule. A "ring" is any
  // :focus, :focus-within or :focus-visible rule that draws an outline (any
  // outline property but `none`) or a ring-shaped box-shadow: no offset or
  // blur, just a spread (`0 0 0 3px`, `inset 0px 0px 0px 0.2rem`,
  // `0 0 0 var(--ring-width)`), not a drop shadow like the skip link's.
  const css = readFileSync(new URL('../src/assets/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const forcedAt = css.indexOf('@media (forced-colors: active)');
  assert.ok(forcedAt > 0, 'a forced-colors block exists');
  // Split at top-level separators only (not inside parentheses).
  const topLevel = (text, sep) => {
    const out = [''];
    let depth = 0;
    for (const ch of text) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (depth === 0 && sep.test(ch)) out.push('');
      else out[out.length - 1] += ch;
    }
    return out.map((x) => x.trim()).filter(Boolean);
  };
  const splitSelectors = (text) => topLevel(text, /,/).map((x) => x.replace(/\s+/g, ' '));
  const rules = (text) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({ sels: splitSelectors(sel), body }));
  // A shadow layer is a ring when three zero lengths (x, y, blur) are followed
  // by a spread, wherever the colour and `inset` sit and whichever layer it is.
  const isRing = (layer) => {
    const tokens = topLevel(layer, /\s/);
    const zero = (t) => /^0(px|r?em)?$/.test(t);
    return tokens.some((t, i) => zero(t) && zero(tokens[i + 1] ?? '') && zero(tokens[i + 2] ?? '') && /^([\d.]+(px|r?em)|calc\(|var\()/.test(tokens[i + 3] ?? '') && !zero(tokens[i + 3]));
  };
  const ringShadow = { test: (body) => [...body.matchAll(/(?:^|;|\s)box-shadow\s*:\s*([^;]+)/g)].some(([, value]) => topLevel(value, /,/).some(isRing)) };
  const draws = (body) => ringShadow.test(body) || [...body.matchAll(/(?:^|;|\s)outline(-style|-width|-color)?\s*:\s*([^;]+)/g)].some(([, , value]) => value.trim() !== 'none');
  const ringSelectors = rules(css.slice(0, forcedAt))
    .filter(({ body }) => draws(body))
    .flatMap(({ sels }) => sels)
    .filter((sel) => /:focus(-visible|-within)?\b/.test(sel));
  assert.ok(ringSelectors.length >= 4, ringSelectors.join(' | '));
  const highlighted = rules(css.slice(forcedAt))
    .filter(({ body }) => /outline(-color)?\s*:[^;]*Highlight/.test(body))
    .flatMap(({ sels }) => sels);
  for (const sel of ringSelectors) assert.ok(highlighted.includes(sel), `${sel} has no Highlight ring in forced colors`);
  assert.deepEqual(splitSelectors(':is(.a, .b):focus-visible, .c'), [':is(.a, .b):focus-visible', '.c'], 'selectors split at the top level only');
  for (const ring of [
    'box-shadow: 0 0 0 3px red',
    'box-shadow: inset 0px 0px 0px 0.2rem red',
    'box-shadow: 0 0 0 var(--ring-width) red',
    'box-shadow: var(--ring) 0 0 0 3px',
    'box-shadow: var(--shadow), 0 0 0 3px var(--ring)',
    'box-shadow: 0 0 0 calc(var(--ring-width) + 1px) red',
  ]) assert.ok(draws(ring), ring);
  for (const other of ['box-shadow: var(--shadow)', 'box-shadow: 0 1px 3px rgb(0 0 0 / 0.12)', 'outline: none']) assert.ok(!draws(other), other);
});

test('fee change dates are machine-readable', () => {
  const home = html.find((h) => h.file === 'index.html').src;
  const times = [...home.matchAll(/<time datetime="([^"]+)">([^<]+)<\/time>/g)];
  assert.ok(times.length >= 3);
  for (const [, iso, text] of times) {
    assert.match(iso, /^\d{4}-\d{2}(-\d{2})?$/);
    assert.ok(text.includes(iso.slice(0, 4)), `${text} shows the year of ${iso}`);
  }
  assert.ok(!/<time>/.test(home), 'every <time> has a datetime');
});

test('tracker page quotes the current IRS mileage rates from the shared data', () => {
  const page = html.find((h) => h.file === 'tracker/index.html').src;
  const latest = IRS_MILEAGE_RATES.at(-1);
  assert.ok(page.includes(`${percentOf(latest.rate)}&cent;`), 'latest rate shown');
  assert.ok(page.includes(`the ${MILEAGE_YEAR} IRS business rate`), 'year shown');
});

test('the social card image shows the current numbers', () => {
  const drawn = JSON.parse(readFileSync(new URL('../src/assets/og.json', import.meta.url), 'utf8'));
  assert.deepEqual(drawn, ogData(), 'src/assets/og.png is out of date (numbers or site name): run `node scripts/gen-images.mjs` (see its header)');
});

test('service worker version changes when only page text changes', () => {
  const OUT2 = mkdtempSync(join(tmpdir(), 'threadvet-'));
  tempDirs.push(OUT2);
  execFileSync(process.execPath, ['scripts/build.mjs', '--out', OUT2, '--quiet'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, CONTACT_EMAIL: 'changed@example.com' },
  });
  const version = (dir) => readFileSync(join(dir, 'sw.js'), 'utf8').match(/const VERSION = "([0-9a-f]+)"/)[1];
  assert.notEqual(version(OUT), version(OUT2));
});

test('sitemap lists every indexable page and nothing else', () => {
  const sitemap = readFileSync(join(OUT, 'sitemap.xml'), 'utf8');
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const expected = html.filter((h) => !NOINDEX.has(h.file)).map((h) => `${config.url}${pathOf(h.file)}`);
  assert.deepEqual(locs.sort(), expected.sort());
  const feeDate = sitemap.match(/fees\/ebay\/<\/loc><lastmod>([^<]+)</)[1];
  assert.equal(feeDate, FEES_VERIFIED, 'fee pages carry the fee verification date');
  assert.match(readFileSync(join(OUT, 'robots.txt'), 'utf8'), new RegExp(`Sitemap: ${config.url}/sitemap.xml`));
});

test('affiliate links are marked sponsored', () => {
  const home = html.find((h) => h.file === 'index.html').src;
  for (const c of config.crosslisters) {
    assert.ok(home.includes(`href="${c.url}" rel="sponsored noopener"`), c.id);
  }
});
