/**
 * Profit engine shared by the browser calculator, the static page builder
 * and the tests. Pure functions, integer cents, no DOM access.
 */
import { PLATFORMS, PLATFORM_BY_ID, EBAY_CATEGORIES, ETSY_OFFSITE, RATES, MAX_CENTS, firstPriceWhere, roundCents, percentOf, usdText } from './fees.mjs';

/** Defaults shown when the calculator first loads (dollars / percents). */
export const DEFAULTS = Object.freeze({
  price: 40,
  cost: 8,
  ship: 0,
  label: 7,
  other: 0,
  target: 10,
  taxRate: 7.5,
  ebayCategory: 'most',
  ebayCustomRate: percentOf(RATES.ebay.fvf),
  ebayAdRate: 0,
  depopBoost: false,
  etsyOffsite: 'none',
  whatnotRate: percentOf(RATES.whatnot.commission),
  tiktokRate: percentOf(RATES.tiktok.referral),
});

/**
 * Largest accepted value per field (percent for rates, dollars for money):
 * the most each marketplace allows (eBay ad rates go to 100%). Inputs outside
 * 0..max are clamped here and flagged in the UI.
 */
export const LIMITS = Object.freeze({
  money: MAX_CENTS / 100,
  taxRate: 20,
  ebayCustomRate: 30,
  ebayAdRate: 100,
  whatnotRate: 30,
  tiktokRate: 60,
});

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
/** Own-property check that also works in browsers without Object.hasOwn. */
export const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const US_THOUSANDS = /^[-+]?[1-9]\d{0,2}(,\d{3})+(\.\d*)?$/; // "1,234.50"
const DOT_THOUSANDS = /^[-+]?[1-9]\d{0,2}(\.\d{3})+$/; // "1.500": 1.5 here, 1500 in many regions
const commaIsDecimal = (text, rate) => (rate ? /^[-+]?\d*,\d*$/ : /^[-+]?\d*,\d{0,2}$/).test(text);
const bare = (value) => value.replace(/[$%\s]/g, '');

/**
 * Parse "$1,234.50", "12", 12 or "" into a finite number (NaN if unusable).
 * A comma separates thousands ("1,234.50") or, where it can't, is the
 * decimal point: "12,50", "12,5", "12," (the decimal keypad in many regions
 * has only a comma). A comma that could be either ("0,500", "1.000,50")
 * makes the text NaN, not a guess. In a `rate` (no rate reaches a thousand)
 * a single comma is always the decimal point. A dot always is one, as on a
 * US keyboard: "1.500" is 1.5 (the form, stricter, asks for such an amount
 * again; see inputProblem).
 */
export function parseNumber(value, { rate = false } = {}) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return NaN;
  let text = bare(value);
  if (!rate && US_THOUSANDS.test(text)) text = text.replace(/,/g, '');
  else if (commaIsDecimal(text, rate)) text = text.replace(',', '.');
  // Plain decimals only: Number() would also accept "0x10", "0b11" or "1e3".
  return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(text) ? Number(text) : NaN;
}

const isRate = (key) => key !== 'money' && has(LIMITS, key);
// Money is checked as the engine reads it, rounded to the cent.
const inRange = (key, n) => Number.isFinite(n) && n >= 0 && (isRate(key) ? n <= LIMITS[key] : roundCents(n * 100) <= MAX_CENTS);
const outOfRange = (key) => (isRate(key) ? `Enter 0 to ${LIMITS[key]}%.` : `Enter $0 to ${usdText(LIMITS.money)}.`);
const unreadable = (key) => (isRate(key) ? 'Write it like 7.5.' : 'Write it like 1,234.50.');
const BELOW_A_CENT = 'Enter at least $0.01.';
/** The hint under a sell price the mode needs that isn't typed yet: a prompt, not an error. */
export const PRICE_NEEDED = 'Needed to see results.';

/**
 * What is wrong with a numeric field's raw text (short enough for the hint
 * under it), or '' when it is fine: not a number as parseNumber reads it
 * (shown the way to write it), or out of range. An amount like "1.500" is
 * asked for again too: parseNumber reads 1.5, but many regions write 1500
 * that way. Empty is fine: it means $0 or, for a sell price the mode needs,
 * not typed yet. That sell price must be at least $0.01 once rounded to the
 * cent, as the engine rounds it.
 */
export function inputProblem(key, raw, { sellPrice = false } = {}) {
  const text = String(raw).trim();
  if (text === '') return '';
  const n = parseNumber(text, { rate: isRate(key) });
  if (Number.isNaN(n) || (!isRate(key) && DOT_THOUSANDS.test(bare(text)))) return unreadable(key);
  if (!inRange(key, n)) return outOfRange(key);
  return sellPrice && roundCents(n * 100) === 0 ? BELOW_A_CENT : '';
}

/**
 * Mid-typing, an amount whose comma could still turn out to separate
 * thousands of one in range ("1," "1,2" "1,23" on the way to "1,234"): it
 * isn't read until the field is left.
 */
export function stillTyping(key, raw) {
  const [, lead, tail] = /^\+?([1-9]\d{0,2}),(\d{0,2})$/.exec(bare(String(raw))) ?? [];
  // "100," may become "100,000"; "100,1" or "250,5" can't end in range: read now.
  return !isRate(key) && lead !== undefined && Number(lead) * 1000 + Number(tail.padEnd(3, '0')) <= LIMITS.money;
}

/**
 * Mid-typing, a value not readable or in range yet that one more digit
 * could make so ("0" and "0." before "0.75", "." before ".99", "$" before
 * "$5"): a field already showing what's wrong waits for it rather than say
 * something new is. An empty field isn't on its way to anything, nor is
 * "1.500", a whole amount the form asks to have written another way.
 */
export function onItsWay(key, raw, options) {
  const text = String(raw).trim();
  if (text === '' || !inputProblem(key, text, options)) return false;
  if (!isRate(key) && DOT_THOUSANDS.test(bare(text))) return false; // "1.500" is written out, only ambiguously
  return inputProblem(key, `${text}1`, options) === '';
}

/** The text with a comma read as the decimal point written as one ("12,50" is "12.50"), so the field shows how it was read. */
export function withDecimalPoint(key, raw) {
  const text = String(raw);
  return commaIsDecimal(bare(text), isRate(key)) ? text.replace(',', '.') : text;
}

/** Every message a numeric field's hint can switch to, as { text, error }, so the form can keep room for the longest. */
export function hintsFor(key) {
  const hints = [outOfRange(key), unreadable(key)].map((text) => ({ text, error: true }));
  if (key === 'price') hints.push({ text: BELOW_A_CENT, error: true }, { text: PRICE_NEEDED, error: false });
  return hints;
}

function cents(value, fallback) {
  const n = parseNumber(value);
  return Number.isFinite(n) ? clamp(roundCents(n * 100), 0, MAX_CENTS) : roundCents(fallback * 100);
}

/**
 * Percent -> fraction. A field the user cleared means 0, like the money
 * fields; a missing key (e.g. an old saved setting) or junk text falls back
 * to the default, and the UI flags junk as invalid.
 */
function rate(value, fallbackPct, maxPct) {
  if (typeof value === 'string' && value.trim() === '') return 0;
  const n = parseNumber(value, { rate: true });
  return clamp(Number.isFinite(n) ? n : fallbackPct, 0, maxPct) / 100;
}

function bool(value) {
  return value === true || value === 'true' || value === '1' || value === 'on';
}

/**
 * Turn raw user input (strings from a form or URL, or numbers) into clean,
 * clamped values the engine can trust. Empty or invalid money fields fall
 * back to 0; invalid rates fall back to their defaults.
 */
export function normalizeInputs(raw = {}) {
  const money = (key) => cents(raw[key], 0);
  return {
    price: money('price'),
    cost: money('cost'),
    ship: money('ship'),
    label: money('label'),
    other: money('other'),
    target: money('target'),
    taxRate: rate(raw.taxRate, DEFAULTS.taxRate, LIMITS.taxRate),
    opts: {
      ebayCategory: has(EBAY_CATEGORIES, raw.ebayCategory) ? raw.ebayCategory : DEFAULTS.ebayCategory,
      ebayCustomRate: rate(raw.ebayCustomRate, DEFAULTS.ebayCustomRate, LIMITS.ebayCustomRate),
      ebayAdRate: rate(raw.ebayAdRate, DEFAULTS.ebayAdRate, LIMITS.ebayAdRate),
      depopBoost: bool(raw.depopBoost),
      etsyOffsite: has(ETSY_OFFSITE, raw.etsyOffsite) ? raw.etsyOffsite : DEFAULTS.etsyOffsite,
      whatnotRate: rate(raw.whatnotRate, DEFAULTS.whatnotRate, LIMITS.whatnotRate),
      tiktokRate: rate(raw.tiktokRate, DEFAULTS.tiktokRate, LIMITS.tiktokRate),
    },
  };
}

function makeOrder(platform, input, price) {
  const ship = platform.sellerPaysShipping ? input.ship : 0;
  const taxFor = (p) => roundCents((p + ship) * input.taxRate);
  return { price, ship, tax: taxFor(price), taxFor, opts: input.opts };
}

/**
 * Full breakdown for one platform at a given sale price and item cost.
 * payout = what the marketplace deposits; profit = payout minus your costs.
 */
export function evaluate(platform, input, price = input.price, cost = input.cost) {
  const order = makeOrder(platform, input, price);
  const fees = platform.fees(order).filter((f) => f.cents !== 0);
  const feeTotal = fees.reduce((sum, f) => sum + f.cents, 0);
  const gross = price + order.ship;
  const payout = gross - feeTotal;
  const shipping = platform.sellerPaysShipping ? input.label : 0;
  const profit = payout - shipping - cost - input.other;
  return {
    id: platform.id,
    name: platform.name,
    short: platform.short ?? platform.name,
    price,
    ship: order.ship,
    tax: order.tax,
    taxInFees: Boolean(platform.feesIncludeTax) && order.tax > 0,
    fees,
    feeTotal,
    gross,
    payout,
    shipping,
    cost,
    other: input.other,
    profit,
    roi: cost > 0 ? profit / cost : null,
    feeRate: gross > 0 ? feeTotal / gross : null,
  };
}

/** Most you can pay for the item and still clear `input.target` profit. */
export function maxBuy(platform, input) {
  const atZeroCost = evaluate(platform, input, input.price, 0);
  return { ...atZeroCost, minimum: input.target, maxCost: atZeroCost.profit - input.target };
}

/**
 * Rounding makes profit wobble: each fee part (and the tax) is rounded to the
 * cent on its own, so over a few cents profit can dip even as the price rises.
 * With at most 5 separately rounded amounts the wobble is under 3 cents.
 */
const ROUNDING_NOISE = 3;
/** Cap on any linear scan, so extreme settings stay responsive. */
const MAX_SCAN = 20_000;

/**
 * Lowest price in [lo, hi] that clears the target, or null. A rounding dip
 * can hide a clearing price at most 2 * ROUNDING_NOISE / slope cents below a
 * failing one, where slope is how fast profit rises with price (cents per
 * cent). Slopes are measured over long spans so rounding averages out, and
 * any doubt (a flat or noisy slope) falls back to the widest scan.
 * Tests brute-force this across random and extreme settings.
 */
function lowestIn(profitAt, target, lo, hi) {
  const clears = (p) => profitAt(p) >= target;
  const slopeBelow = (p, span) => {
    const from = Math.max(lo, p - span);
    return from < p ? (profitAt(p) - profitAt(from)) / (p - from) : 1;
  };
  const dipWidth = (slope) => (slope > 0 ? Math.min(MAX_SCAN, Math.ceil((2 * ROUNDING_NOISE) / slope) + 2) : MAX_SCAN);

  let top = hi;
  if (!clears(top)) {
    if (slopeBelow(hi, 100_000) <= 0) {
      // Fees outpace the price at the top, and fee rates only fall as the
      // price rises, so profit is falling throughout: only the cheapest
      // prices can clear, and only if the cheapest one is within rounding
      // noise of the target (it never is with a per-order fee).
      if (profitAt(lo) < target - 2 * ROUNDING_NOISE) return null;
      for (let p = lo; p <= Math.min(hi, lo + 64); p++) if (clears(p)) return p;
      return null;
    }
    // The last cent can fail inside a dip even though earlier cents pass.
    const stop = Math.max(lo, hi - dipWidth(slopeBelow(hi, 10_000)));
    while (top >= stop && !clears(top)) top--;
    if (top < stop) return null;
  }

  // Binary search, then walk down until a dip's width of cents fail in a row
  // (restarting at every hit), in case the search landed past a dip.
  let price = firstPriceWhere(clears, top, lo);
  const width = dipWidth(slopeBelow(price, 10_000));
  for (let p = price - 1, misses = 0; p >= lo && misses < width; p--) {
    if (clears(p)) {
      price = p;
      misses = 0;
    } else {
      misses++;
    }
  }
  return price;
}

/**
 * Lowest sale price (cents) that clears `input.target` profit, or null if
 * no price up to MAX_CENTS does. Between fee cliffs (e.g. Poshmark at $15)
 * profit rises with price apart from rounding dips, so each segment is
 * binary-searched in order and refined through the rounding window.
 */
export function listPrice(platform, input) {
  const profitAt = (p) => evaluate(platform, input, p).profit;
  const order = makeOrder(platform, input, 0);
  const breaks = [...new Set(platform.breakpoints?.(order) ?? [])]
    .filter((b) => b > 0 && b <= MAX_CENTS)
    .sort((a, b) => a - b);
  const edges = [1, ...breaks.filter((b) => b > 1), MAX_CENTS + 1]; // a list price is at least 1 cent
  for (let i = 0; i < edges.length - 1; i++) {
    const price = lowestIn(profitAt, input.target, edges[i], edges[i + 1] - 1);
    if (price !== null) return evaluate(platform, input, price);
  }
  return null;
}

function pick(ids) {
  if (!ids) return PLATFORMS;
  const wanted = new Set(ids);
  return PLATFORMS.filter((p) => wanted.has(p.id));
}

/**
 * How good a result is in a mode, higher is better: profit, max buy price, or
 * the negated list price. null for a result that can't be reached. The one
 * definition behind the order, the rank numbers and the verdict.
 */
export function scoreFor(mode, r) {
  if (r.unreachable) return null;
  return mode === 'maxbuy' ? r.maxCost : mode === 'price' ? -r.price : r.profit;
}

/**
 * Which of the sale price and item cost each mode works from: Max buy works
 * out the cost, List price the price. The calculator hides the other one.
 */
export const MODE_INPUTS = Object.freeze({ profit: ['price', 'cost'], maxbuy: ['price'], price: ['cost'] });

/**
 * The calculator inputs a platform's results depend on in a mode (Max buy
 * works out the cost, List price the price), given the normalized `input`
 * (some options only apply with others). A bad value in any other input can't
 * hold its results back. Tested against the engine from random starting
 * points: changing an input left out never changes a result.
 */
export function inputsUsedBy(platform, mode = 'profit', input) {
  const own = has(MODE_INPUTS, mode) ? MODE_INPUTS[mode] : MODE_INPUTS.profit;
  return [
    ...own,
    'target',
    'other',
    ...(platform.sellerPaysShipping ? ['ship', 'label'] : []),
    ...(platform.feesIncludeTax ? ['taxRate'] : []),
    ...(platform.options ?? []).filter((key) => !input || !platform.usesOption || platform.usesOption(key, input.opts)),
  ];
}

/**
 * Competition ranks ("1, 2, 2, 4") for scores where higher is better: equal
 * scores share a rank. A null score (can't be reached) gets no rank.
 */
export function competitionRanks(scores) {
  return scores.map((s) => (s === null ? null : 1 + scores.filter((t) => t !== null && t > s).length));
}

/** competitionRanks, with whether each rank is shared: [{ rank, tied }]. */
export function ranksWithTies(scores) {
  const ranks = competitionRanks(scores);
  return ranks.map((rank) => ({ rank, tied: rank !== null && ranks.filter((n) => n === rank).length > 1 }));
}

/**
 * The results as the site ranks them: [{ r, rank, tied, best }]. Equal
 * results share a rank, one that can't be reached has none, and Best marks
 * each first-ranked result the verdict recommends. The results list, the
 * verdict and the social card all use it.
 */
export function rankedRows(mode, results, target = 0) {
  return ranksWithTies(results.map((r) => scoreFor(mode, r))).map(({ rank, tied }, i) => ({
    r: results[i],
    rank,
    tied,
    best: rank === 1 && recommends(mode, results[i], target),
  }));
}

/**
 * Whether the verdict would recommend this result: reachable, a max buy of
 * at least $0, or a profit above zero that meets the minimum. The Best badge
 * and the verdict both ask this.
 */
export function recommends(mode, r, target) {
  if (r.unreachable) return false;
  if (mode === 'maxbuy') return r.maxCost >= 0;
  if (mode === 'price') return true;
  return r.profit > 0 && r.profit >= target;
}

/**
 * Run a calculator mode across platforms and rank the results best-first
 * (see scoreFor; unreachable last, ties in platform order).
 */
export function rank(mode, input, ids) {
  const runs = {
    profit: (p) => evaluate(p, input),
    maxbuy: (p) => maxBuy(p, input),
    price: (p) => listPrice(p, input) ?? { id: p.id, name: p.name, short: p.short ?? p.name, unreachable: true },
  };
  const run = has(runs, mode) ? runs[mode] : runs.profit; // like scoreFor: anything else is profit
  return pick(ids).map(run).sort(byScore(mode));
}

/** Sort comparator: best scoreFor first, unreachable last, ties keep their order. */
export function byScore(mode) {
  const key = (r) => scoreFor(mode, r) ?? -Infinity;
  return (a, b) => (key(a) === key(b) ? 0 : key(b) > key(a) ? 1 : -1);
}

export { PLATFORMS, PLATFORM_BY_ID, MAX_CENTS };
