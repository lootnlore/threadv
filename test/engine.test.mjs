import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInputs, evaluate, maxBuy, listPrice, rank, parseNumber, competitionRanks, ranksWithTies, scoreFor, byScore, recommends, MAX_CENTS, DEFAULTS } from '../src/engine/calc.mjs';
import { percent, money, renderResults, renderVerdict, ordinal } from '../src/engine/render.mjs';
import { PLATFORMS, PLATFORM_BY_ID as P, RATES, EBAY_CATEGORIES, tiered, firstPriceWhere, roundCents, pctText, usdText } from '../src/engine/fees.mjs';

// Tax defaults to 0 in tests so hand-computed numbers stay readable.
const input = (raw) => normalizeInputs({ taxRate: 0, ...raw });
const fees = (id, raw) => evaluate(P[id], input(raw)).feeTotal;
/** Lowest clearing price by trying every cent up to `max`: the reference for listPrice. */
const bruteList = (platform, i, max = 1_000_000) => {
  for (let p = 1; p <= max; p++) if (evaluate(platform, i, p).profit >= i.target) return p;
  return null;
};


test('percent and money formatting', () => {
  assert.equal(percent(0.6427), '64%');
  assert.equal(percent(-0.00375), '0%', 'no negative zero');
  assert.equal(percent(-0.5), '\u221250%');
  assert.equal(percent(null), '\u2014');
  assert.equal(money(-320), '\u2212$3.20');
});

test('parseNumber accepts currency strings and rejects junk', () => {
  assert.ok(Number.isNaN(parseNumber('0x10')), 'no hex');
  assert.ok(Number.isNaN(parseNumber('0b11')), 'no binary');
  assert.ok(Number.isNaN(parseNumber('1e3')), 'no exponent');
  assert.ok(Number.isNaN(parseNumber('1.2.3')));
  assert.equal(parseNumber('.5'), 0.5);
  assert.equal(parseNumber('5.'), 5);
  assert.equal(parseNumber('-5'), -5);
  assert.equal(parseNumber('$1,234.50'), 1234.5);
  assert.equal(parseNumber('12,345,678'), 12345678);
  assert.ok(Number.isNaN(parseNumber('12,50')), 'decimal comma is rejected, not read as 1250');
  assert.ok(Number.isNaN(parseNumber('1,2,3')));
  assert.equal(parseNumber(' 12 '), 12);
  assert.equal(parseNumber('7.5%'), 7.5);
  assert.ok(Number.isNaN(parseNumber('')));
  assert.ok(Number.isNaN(parseNumber('abc')));
  assert.ok(Number.isNaN(parseNumber(undefined)));
});

test('normalizeInputs clamps money and rates and validates options', () => {
  const n = normalizeInputs({
    price: '$1,234.50',
    cost: -5,
    ship: 'abc',
    label: 1e12,
    taxRate: '',
    ebayCategory: 'nope',
    etsyOffsite: '__proto__',
    depopBoost: 'true',
    whatnotRate: 99,
  });
  assert.equal(n.price, 123450);
  assert.equal(n.cost, 0);
  assert.equal(n.ship, 0);
  assert.equal(n.label, MAX_CENTS);
  assert.equal(n.taxRate, 0, 'a cleared rate field means 0, like money fields');
  assert.equal(n.opts.ebayCategory, 'most');
  assert.equal(n.opts.etsyOffsite, 'none');
  assert.equal(n.opts.depopBoost, true);
  assert.equal(n.opts.whatnotRate, 0.3);
});

test('money input rounds half cents up, consistently', () => {
  assert.equal(normalizeInputs({ price: '1.005' }).price, 101);
  assert.equal(normalizeInputs({ price: '0.285' }).price, 29);
  assert.equal(normalizeInputs({ price: '2.675' }).price, 268);
});

test('missing or junk rates fall back to defaults', () => {
  assert.equal(normalizeInputs({}).taxRate, 0.075);
  assert.equal(normalizeInputs({ taxRate: 'abc', whatnotRate: 'x' }).taxRate, 0.075);
  assert.equal(normalizeInputs({ whatnotRate: 'x' }).opts.whatnotRate, 0.08);
  assert.equal(normalizeInputs({ whatnotRate: '' }).opts.whatnotRate, 0);
});

test('rounding is decimal half-up, not binary-float', () => {
  assert.equal(roundCents(4500 * 0.075), 338); // 337.5 exactly on paper
  assert.equal(roundCents(4505 * 0.1), 451);
  assert.equal(roundCents(33.4999), 33);
  // $45 at 7.5% tax: tax is $3.38, so eBay's order total is $48.38.
  assert.equal(evaluate(P.ebay, input({ price: 45, taxRate: 7.5 })).tax, 338);
});

test('tiered applies marginal rates', () => {
  const tiers = [[1000, 0.1], [Infinity, 0.05]];
  assert.equal(tiered(500, tiers), 50);
  assert.equal(tiered(1000, tiers), 100);
  assert.equal(tiered(3000, tiers), 200);
  assert.equal(tiered(0, tiers), 0);
});

test('firstPriceWhere finds the first true value in range, or null', () => {
  assert.equal(firstPriceWhere((p) => p >= 1234), 1234);
  assert.equal(firstPriceWhere(() => true), 0);
  assert.equal(firstPriceWhere(() => true, 500, 200), 200);
  assert.equal(firstPriceWhere((p) => p >= 300, 500, 200), 300);
  assert.equal(firstPriceWhere(() => false), null);
  assert.equal(firstPriceWhere((p) => p >= 600, 500, 200), null);
});

test('eBay: 13.6% of the order total plus per-order fee', () => {
  assert.equal(fees('ebay', { price: 40 }), 544 + 40);
  // 7.5% sales tax is part of the order total eBay charges on.
  assert.equal(fees('ebay', { price: 40, taxRate: 7.5 }), 585 + 40);
  // Shipping charged to the buyer is included too.
  assert.equal(fees('ebay', { price: 40, ship: 10 }), 680 + 40);
});

test('eBay: per-order fee is $0.30 up to a $10 order total', () => {
  assert.equal(evaluate(P.ebay, input({ price: 10 })).fees[1].cents, 30);
  assert.equal(evaluate(P.ebay, input({ price: 10.01 })).fees[1].cents, 40);
  assert.equal(evaluate(P.ebay, input({ price: 9.5, taxRate: 7.5 })).fees[1].cents, 40); // 9.50 + 0.71 tax > 10
});

test('eBay: category tiers, custom rate and promoted listings', () => {
  assert.equal(fees('ebay', { price: 10000 }), 102000 + 5875 + 40);
  assert.equal(fees('ebay', { price: 3000, ebayCategory: 'handbags' }), 30000 + 9000 + 40);
  assert.equal(fees('ebay', { price: 50, ebayCategory: 'media' }), 765 + 40);
  assert.equal(fees('ebay', { price: 50, ebayCategory: 'custom', ebayCustomRate: 10 }), 500 + 40);
  assert.equal(fees('ebay', { price: 40, ebayAdRate: 5 }), 544 + 40 + 200);
});

test('Poshmark: $2.95 under $15, 20% from $15, shipping ignored', () => {
  assert.equal(fees('poshmark', { price: 14.99 }), 295);
  assert.equal(fees('poshmark', { price: 15 }), 300);
  assert.equal(fees('poshmark', { price: 100 }), 2000);
  const r = evaluate(P.poshmark, input({ price: 50, cost: 10, ship: 5, label: 8 }));
  assert.equal(r.shipping, 0);
  assert.equal(r.ship, 0);
  assert.equal(r.profit, 5000 - 1000 - 1000);
});

test('Mercari: 10% of item plus shipping', () => {
  assert.equal(fees('mercari', { price: 40, ship: 5 }), 450);
});

test('Depop: processing on total incl. tax, optional 12% boost', () => {
  assert.equal(fees('depop', { price: 40 }), 132 + 45);
  assert.equal(fees('depop', { price: 40, depopBoost: true }), 132 + 45 + 480);
  assert.equal(fees('depop', { price: 40, taxRate: 10 }), 145 + 45);
});

test('Etsy: listing + transaction + processing, offsite ads capped at $100', () => {
  assert.equal(fees('etsy', { price: 30 }), 20 + 195 + 90 + 25);
  assert.equal(fees('etsy', { price: 30, etsyOffsite: 'standard' }), 20 + 195 + 90 + 25 + 450);
  const big = evaluate(P.etsy, input({ price: 2000, etsyOffsite: 'standard' }));
  assert.equal(big.fees.find((f) => f.label === 'Offsite Ads fee').cents, 10000);
});

test('Whatnot: commission on item only, processing on item + shipping + tax', () => {
  assert.equal(fees('whatnot', { price: 50 }), 400 + 145 + 30);
  assert.equal(fees('whatnot', { price: 50, ship: 8 }), 400 + 168 + 30);
  assert.equal(fees('whatnot', { price: 50, whatnotRate: 4.5 }), 225 + 145 + 30);
});

test('Facebook Marketplace: 10% of item + shipping, $0.80 minimum', () => {
  assert.equal(fees('facebook', { price: 5 }), 80);
  assert.equal(fees('facebook', { price: 40, ship: 5 }), 450);
});

test('Grailed: 6% (min $1.99) under $120, 9% from $120, plus processing', () => {
  assert.equal(fees('grailed', { price: 20 }), 199 + 70 + 49);
  assert.equal(evaluate(P.grailed, input({ price: 119.99 })).fees[0].cents, 720);
  assert.equal(evaluate(P.grailed, input({ price: 120 })).fees[0].cents, 1080);
});

test('TikTok Shop: referral fee on item + buyer-paid shipping, not tax', () => {
  assert.equal(fees('tiktok', { price: 40 }), 320);
  assert.equal(fees('tiktok', { price: 50, ship: 10 }), 480); // TikTok's own example shape: fee on $60
  assert.equal(fees('tiktok', { price: 40, ship: 6, tiktokRate: 6 }), 276);
  assert.equal(fees('tiktok', { price: 40, taxRate: 9 }), 320, 'tax is excluded');
});

test('payout, profit, ROI and fee rate add up', () => {
  const r = evaluate(P.mercari, input({ price: 40, cost: 8, ship: 5, label: 6, other: 1 }));
  assert.equal(r.gross, 4500);
  assert.equal(r.payout, 4500 - 450);
  assert.equal(r.profit, 4050 - 600 - 800 - 100);
  assert.equal(r.roi, r.profit / 800);
  assert.equal(r.feeRate, 450 / 4500);
  assert.equal(evaluate(P.mercari, input({ price: 40 })).roi, null);
  assert.equal(evaluate(P.mercari, input({ price: 0 })).feeRate, null);
});

test('maxBuy: paying exactly the max cost leaves exactly the target profit', () => {
  const raw = { price: 63.5, ship: 4, label: 7.25, other: 0.5, target: 12, taxRate: 8.25, ebayAdRate: 3 };
  for (const p of PLATFORMS) {
    const i = input(raw);
    const { maxCost } = maxBuy(p, i);
    assert.equal(evaluate(p, i, i.price, maxCost).profit, i.target, p.id);
  }
});

test('listPrice: handles fee cliffs by choosing the price below them', () => {
  // Poshmark: $14.98 keeps $12.03; $15.00 only keeps $12.00.
  assert.equal(listPrice(P.poshmark, input({ target: 12.03 })).price, 1498);
  // Grailed: under $120 the 6% rate clears $105; at $120-ish it does not.
  const g = listPrice(P.grailed, input({ target: 105 }));
  assert.ok(g.price < 12000, `expected < $120, got ${g.price}`);
  assert.ok(g.profit >= 10500);
});

test('listPrice: exact at extreme eBay ad rates, and null when fees exceed the price', () => {
  for (const ebayAdRate of [70, 80, 85, 90]) {
    for (const target of [0, 0.5, 3, 12]) {
      const i = input({ ebayCategory: 'custom', ebayCustomRate: 12, ebayAdRate, taxRate: 3, target });
      const brute = bruteList(P.ebay, i, 2_000_000);
      assert.equal(listPrice(P.ebay, i)?.price ?? null, brute, `ad ${ebayAdRate}% target ${target}`);
    }
  }
  // 100% ads + 13.6% FVF: every sale loses money, so no price reaches $0 profit.
  assert.equal(listPrice(P.ebay, input({ ebayAdRate: 100, target: 0 })), null);
});

test('listPrice: never recommends a $0 price', () => {
  const r = listPrice(P.mercari, input({ target: 0, cost: 0, label: 0 }));
  assert.equal(r.price, 1);
});

test('listPrice: returns null when the target is unreachable', () => {
  assert.equal(listPrice(P.mercari, input({ target: 100000 })), null);
});

test('listPrice: is exactly the lowest clearing price (brute force, random inputs)', () => {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  for (let n = 0; n < 40; n++) {
    const raw = {
      cost: Math.floor(rnd() * 3000) / 100,
      ship: Math.floor(rnd() * 1200) / 100,
      label: Math.floor(rnd() * 1200) / 100,
      other: Math.floor(rnd() * 300) / 100,
      target: Math.floor(rnd() * 8000) / 100,
      taxRate: Math.floor(rnd() * 2000) / 100,
      ebayCategory: pick(['most', 'handbags', 'media', 'custom']),
      ebayCustomRate: Math.floor(rnd() * 3000) / 100,
      ebayAdRate: pick([0, 0, 2, 7.5, 15, 30, 60, 85]),
      depopBoost: rnd() < 0.3,
      etsyOffsite: pick(['none', 'standard', 'reduced']),
      whatnotRate: pick([8, 6.5, 4.5, 30]),
      tiktokRate: pick([8, 6, 18, 40, 60]),
    };
    for (const p of PLATFORMS) {
      const i = input(raw);
      const found = listPrice(p, i);
      const brute = bruteList(p, i);
      // Beyond the brute-force range listPrice may still find a (higher) price.
      if (brute === null) assert.ok(!found || found.price > 1_000_000, `${p.id} ${JSON.stringify(raw)}`);
      else assert.equal(found?.price, brute, `${p.id} ${JSON.stringify(raw)}`);
    }
  }
});

test('listPrice: exact next to fee cliffs, where rounding dips hit segment edges', () => {
  // Reviewer's reproductions around eBay's $10 per-order-fee step.
  const cases = [
    { ebayCategory: 'custom', ebayCustomRate: 30, ebayAdRate: 30, taxRate: 20, target: 2.04 },
    { ebayCategory: 'custom', ebayCustomRate: 30, ebayAdRate: 30, taxRate: 7.25, target: 3.03 },
  ];
  for (const raw of cases) {
    const i = input(raw);
    assert.equal(listPrice(P.ebay, i).price, bruteList(P.ebay, i), JSON.stringify(raw));
  }
  // Sweep small targets across every cliff: eBay $10, Poshmark $15, Grailed $120.
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let n = 0; n < 150; n++) {
    const raw = {
      target: Math.floor(rnd() * 12000) / 100,
      ship: Math.floor(rnd() * 500) / 100,
      taxRate: Math.floor(rnd() * 2000) / 100,
      ebayCategory: 'custom',
      ebayCustomRate: Math.floor(rnd() * 3000) / 100,
      ebayAdRate: Math.floor(rnd() * 3000) / 100,
    };
    const i = input(raw);
    for (const id of ['ebay', 'poshmark', 'grailed']) {
      assert.equal(listPrice(P[id], i).price, bruteList(P[id], i), `${id} ${JSON.stringify(raw)}`);
    }
  }
});

test('listPrice: finds prices hidden by a one-cent rounding dip', () => {
  // Reviewer's case: Etsy, $7.99 shipping, Offsite Ads, no tax, $5 target.
  const i = input({ ship: 7.99, target: 5, etsyOffsite: 'standard' });
  assert.equal(listPrice(P.etsy, i).price, bruteList(P.etsy, i));
});

test('rank orders results best-first for every mode', () => {
  const i = input({ price: 40, cost: 8, target: 10 });
  const profit = rank('profit', i);
  assert.equal(profit.length, PLATFORMS.length);
  for (let k = 1; k < profit.length; k++) assert.ok(profit[k - 1].profit >= profit[k].profit);

  const buy = rank('maxbuy', i, ['ebay', 'poshmark']);
  assert.deepEqual(buy.map((r) => r.id).sort(), ['ebay', 'poshmark']);
  assert.ok(buy[0].maxCost >= buy[1].maxCost);

  const price = rank('price', input({ target: 1e5 }), ['mercari', 'ebay']);
  assert.ok(price.every((r) => r.unreachable));
  const prices = rank('price', i);
  for (let k = 1; k < prices.length; k++) assert.ok(prices[k - 1].price <= prices[k].price);
});

test('feesIncludeTax matches whether tax actually changes a platform\'s fees', () => {
  for (const p of PLATFORMS) {
    const withTax = evaluate(p, input({ price: 83.17, ship: 6.4, taxRate: 9 })).feeTotal;
    const without = evaluate(p, input({ price: 83.17, ship: 6.4, taxRate: 0 })).feeTotal;
    assert.equal(withTax !== without, Boolean(p.feesIncludeTax), p.id);
    assert.equal(evaluate(p, input({ price: 50, taxRate: 9 })).taxInFees, Boolean(p.feesIncludeTax), p.id);
  }
});

test('RATES drive the fees and the defaults', () => {
  assert.equal(DEFAULTS.whatnotRate, 8);
  assert.equal(DEFAULTS.tiktokRate, 8);
  assert.equal(DEFAULTS.ebayCustomRate, 13.6);
  // Headlines are prose, so check they state the current headline rates.
  assert.match(P.ebay.headline, /13\.6%/);
  assert.match(P.poshmark.headline, /20%/);
  assert.match(P.mercari.headline, /10%/);
  assert.match(P.grailed.headline, /6% .*9%/);
  assert.match(P.tiktok.headline, /8%/);
  assert.equal(RATES.ebay.fvf, 0.136);
});

test('every rate in RATES appears in its platform\'s descriptions', () => {
  // Catches prose left behind when a rate changes: percentages and dollar amounts alike.
  const money = new Set(['fvfCap', 'handbagsCap', 'orderFee', 'orderFeeSmall', 'smallOrderMax', 'flat', 'threshold', 'procFixed', 'listing', 'offsiteCap', 'offsiteReducedFrom', 'min']);
  for (const p of PLATFORMS) {
    // Only text the fee pages actually show counts.
    const prose = [p.headline, ...p.rows.flat(), ...p.notes].join(' ');
    for (const [key, value] of Object.entries(RATES[p.id])) {
      const text = money.has(key) ? usdText(value) : pctText(value);
      assert.ok(prose.includes(text), `${p.id}.${key} (${text}) is not mentioned`);
    }
  }
});

test('fee table rows follow the convention the FAQ sentences rely on', () => {
  for (const p of PLATFORMS) {
    for (const [fee, rate, base] of p.rows) {
      assert.ok(typeof fee === 'string' && typeof rate === 'string' && base, `${p.id}: ${fee}`);
      if (base.startsWith('Per ')) {
        assert.ok(!/\bper\b/i.test(`${fee} ${rate}`.replace(/-/g, ' ')), `${p.id}: "${fee}" / "${rate}" already says "per"; use '-' as the base`);
      } else if (base !== '-') {
        assert.ok(!/^per\b/i.test(base), `${p.id}: per-unit bases start with "Per "`);
      }
    }
  }
});

test('every platform is fully described for the fee pages', () => {
  for (const p of PLATFORMS) {
    assert.match(p.id, /^[a-z]+$/);
    assert.ok(p.name && p.headline, p.id);
    assert.ok(p.rows.length >= 2, p.id);
    assert.ok(p.notes.length >= 1, p.id);
    assert.ok(p.sources.length >= 1 && p.sources.every((s) => s.url.startsWith('https://')), p.id);
  }
});

test('ordinal numbers', () => {
  assert.deepEqual([1, 2, 3, 4, 9, 11, 12, 13, 21, 22, 23, 101, 111, 112].map(ordinal), [
    '1st', '2nd', '3rd', '4th', '9th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th', '112th',
  ]);
});

/** The rendered rows as plain data: id, rank badge (and whether it is read aloud), tags, name. */
const rows = (html) =>
  html.split('<li ').slice(1).map((li) => ({
    id: li.match(/data-id="([^"]+)"/)[1],
    best: li.includes('class="result is-best'),
    rank: ((n) => (n === '–' ? null : Number(n)))(li.match(/<span class="rank"[^>]*>([^<]+)<\/span>/)[1]),
    rankRead: !li.includes('<span class="rank" aria-hidden="true">'),
    tags: [...li.matchAll(/<span class="tag [^"]+">([^<]+)<\/span>/g)].map((m) => m[1]),
    name: li.match(/<span class="pname">(.*?)<\/span> <span class="figure/)[1].replace(/<[^>]+>/g, ''),
    // The headline as plain text (no CSS): badge, name, tags, figure.
    text: li.match(/<span class="result-main">(.*?)<\/span>\n/)[1].replace(/<[^>]+>/g, ''),
  }));

/**
 * Real results (every field the renderer needs) with a mode's score set by
 * hand, so ties and gaps don't depend on today's fee rates. Named A, B, C...
 */
const made = (mode, scores) => {
  const i = input({ price: 40, cost: 5, target: 5 });
  const base = rank(mode, i);
  const field = { profit: 'profit', maxbuy: 'maxCost', price: 'price' }[mode];
  return scores.map((score, n) => {
    const name = String.fromCharCode(65 + n);
    const r = { ...base[n], id: name.toLowerCase(), name, short: name };
    return score === null ? { ...r, unreachable: true } : { ...r, [field]: score };
  });
};

test('competition ranks: ties share a rank, the next rank skips, unreachable gets none', () => {
  assert.deepEqual(competitionRanks([5, 3, 3, 1, null]), [1, 2, 2, 4, null]);
  assert.deepEqual(competitionRanks([2, 2]), [1, 1]);
  assert.deepEqual(competitionRanks([]), []);
  assert.deepEqual(ranksWithTies([5, 3, 3, null]), [
    { rank: 1, tied: false },
    { rank: 2, tied: true },
    { rank: 2, tied: true },
    { rank: null, tied: false },
  ]);
});

test('byScore sorts best first and unreachable last in every mode', () => {
  const order = (mode, scores) => made(mode, scores).sort(byScore(mode)).map((r) => r.name).join('');
  assert.equal(order('profit', [100, 300, 200]), 'BCA');
  assert.equal(order('maxbuy', [-50, 20, 0]), 'BCA');
  assert.equal(order('price', [null, 500, 300, null]), 'CBAD', 'lowest price first, out of range last, ties in order');
  // And rank() uses it, with real fees.
  for (const [mode, raw] of [['profit', { price: 40, cost: 5 }], ['maxbuy', { price: 40, target: 5 }], ['price', { cost: 5, target: 10 }], ['price', { target: 96_000 }]]) {
    const scores = rank(mode, input(raw)).map((r) => scoreFor(mode, r) ?? -Infinity);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a), mode);
  }
  assert.equal(rank('toString', input({ price: 40 }))[0].profit, rank('profit', input({ price: 40 }))[0].profit, 'unknown modes are profit');
});

test('results: shared ranks on the badges (read aloud), and a rank tag for very large text', () => {
  const out = rows(renderResults('profit', made('profit', [3000, 2500, 2500, 2000]), { target: 500 }));
  assert.deepEqual(out.map((r) => r.rank), [1, 2, 2, 4], 'ties share a rank, the next is skipped');
  assert.ok(out.every((r) => r.rankRead));
  assert.deepEqual(out.map((r) => r.tags), [['Best'], ['Tied 2nd'], ['Tied 2nd'], ['4th']]);
  assert.deepEqual(out.map((r) => r.name), ['A Best', 'B Tied 2nd', 'C Tied 2nd', 'D 4th'], 'a space before each tag');
  assert.deepEqual(out.map((r) => r.text), ['1 A Best $30.00', '2 B Tied 2nd $25.00', '2 C Tied 2nd $25.00', '4 D 4th $20.00'], 'plain text keeps the parts apart');
  // A top result the verdict rejects has no Best tag, so it keeps a rank tag.
  const rejected = (scores) => rows(renderResults('profit', made('profit', scores), { target: 500 })).map((r) => r.tags);
  assert.deepEqual(rejected([400, 300]), [['1st'], ['2nd']]);
  assert.deepEqual(rejected([400, 400]), [['Tied 1st'], ['Tied 1st']]);
  const tiedTop = rows(renderResults('profit', made('profit', [3000, 3000, 100]), { target: 500 }));
  assert.deepEqual(tiedTop.map((r) => r.best), [true, true, false], 'Best on every result tied for first');
});

test('results: the Best badge only on a top result the verdict recommends', () => {
  const best = (mode, scores, target) => rows(renderResults(mode, made(mode, scores), { target })).map((r) => r.best);
  assert.deepEqual(best('profit', [900, 400], 500), [true, false]);
  assert.deepEqual(best('profit', [400, 300], 500), [false, false], 'under the minimum');
  assert.deepEqual(best('profit', [0, -100], 0), [false, false], 'no profit');
  assert.deepEqual(best('maxbuy', [0, -100], 500), [true, false], 'a $0 max buy still counts');
  assert.deepEqual(best('maxbuy', [-1, -100], 500), [false, false]);
  assert.deepEqual(best('price', [4000, 5000], 500), [true, false]);
  const out = rows(renderResults('price', made('price', [null, null]), { target: 500 }));
  assert.deepEqual(out.map((r) => [r.best, r.rank, r.rankRead, r.tags.length]), [[false, null, false, 0], [false, null, false, 0]], 'out of range: no rank, badge not read');
  // With real fees and random inputs, the badge and the verdict always agree
  // (a guard against either bypassing recommends(); its thresholds are
  // checked at their exact boundaries in the next test).
  let seed = 11;
  const rnd = (max) => Math.floor(((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * max);
  for (let n = 0; n < 300; n++) {
    const mode = ['profit', 'maxbuy', 'price'][n % 3];
    const i = input({ price: 1 + rnd(150), cost: rnd(80), target: rnd(50), label: rnd(12), ship: rnd(10) });
    const results = rank(mode, i);
    const anyBest = rows(renderResults(mode, results, { target: i.target })).some((r) => r.best);
    assert.equal(anyBest, renderVerdict(mode, results, i).tone === 'good', `${mode} ${JSON.stringify(i)}`);
    assert.equal(anyBest, results.some((r) => recommends(mode, r, i.target) && scoreFor(mode, r) === scoreFor(mode, results[0])));
  }
});

test('recommends: exact thresholds, and the verdict that goes with each side', () => {
  const r = (fields) => ({ unreachable: false, ...fields });
  assert.equal(recommends('profit', r({ profit: 500 }), 500), true, 'profit equal to the minimum');
  assert.equal(recommends('profit', r({ profit: 499 }), 500), false, 'a cent under');
  assert.equal(recommends('profit', r({ profit: 0 }), 0), false, 'break-even is not a profit');
  assert.equal(recommends('profit', r({ profit: 1 }), 0), true);
  assert.equal(recommends('maxbuy', r({ maxCost: 0 }), 500), true, 'a $0 max buy still clears the minimum');
  assert.equal(recommends('maxbuy', r({ maxCost: -1 }), 500), false);
  assert.equal(recommends('price', r({ price: 100 }), 500), true);
  assert.equal(recommends('price', { unreachable: true }, 500), false);
  const verdict = (mode, scores, raw) => renderVerdict(mode, made(mode, scores), input(raw));
  assert.equal(verdict('profit', [500, 100], { target: 5 }).tone, 'good');
  assert.match(verdict('profit', [499, 100], { target: 5 }).html, /^<span><strong>Pass\.<\/strong> Best case is \$4\.99/);
  assert.match(verdict('profit', [0, -100], { target: 0 }).html, /No profit\./);
  assert.match(verdict('maxbuy', [0, -100], { price: 40, target: 5 }).html, /Pay up to \$0\.00/);
  assert.match(verdict('maxbuy', [-1, -100], { price: 40, target: 5 }).html, /<strong>Pass\.<\/strong> At a \$40\.00 sale/);
});

test('results: a fee page pins its marketplace first and keeps its real rank', () => {
  const results = made('profit', [3000, 2500, 2500, 2000, 1000]);
  const out = rows(renderResults('profit', results, { focus: 'c', target: 500 }));
  assert.deepEqual(out.map((r) => r.id), ['c', 'a', 'b', 'd', 'e'], 'pinned first, the rest in order');
  assert.deepEqual(out.map((r) => r.rank), [2, 1, 2, 4, 5], 'every badge keeps its true rank');
  assert.deepEqual(out[0].tags, ['Tied 2nd']);
  assert.deepEqual(out[1].tags, ['Best'], 'Best stays on the real winner');
});

test('verdict names every marketplace tied for the top result', () => {
  const verdict = (mode, scores, raw) => renderVerdict(mode, made(mode, scores), input(raw)).html;
  assert.match(verdict('profit', [2100, 2100, 900], { target: 5 }), /Best on A and B: \$21\.00 profit/);
  assert.match(verdict('profit', [2100, 900], { target: 5 }), /Best on A: /);
  assert.match(verdict('profit', [2100, 2100, 2100], { target: 5 }), /Best on A, B and C: /);
  assert.match(verdict('maxbuy', [1500, 1500], { price: 40, target: 5 }), /selling on A or B at /);
  assert.match(verdict('price', [4000, 4000, 5000], { target: 5 }), /on A or B, the lowest price/);
  assert.match(verdict('profit', [300, 300], { target: 5 }), /Best case is \$3\.00 on A or B, under/);
  assert.match(verdict('profit', [0, 0], { target: 0 }), /break even on A or B\./);
});
