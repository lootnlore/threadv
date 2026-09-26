/**
 * Profit engine shared by the browser calculator, the static page builder
 * and the tests. Pure functions, integer cents, no DOM access.
 */
import { PLATFORMS, PLATFORM_BY_ID, EBAY_CATEGORIES, ETSY_OFFSITE, RATES, MAX_CENTS, firstPriceWhere, roundCents, percentOf } from './fees.mjs';

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

/** Parse "$1,234.50", "12", 12 or "" into a finite number (NaN if unusable). */
export function parseNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return NaN;
  const trimmed = value.replace(/[$%\s]/g, '');
  // Commas only as thousands separators: "1,234.50" yes, a decimal comma
  // like "12,50" no (it would silently read as 1250).
  if (trimmed.includes(',') && !/^[-+]?\d{1,3}(,\d{3})+(\.\d*)?$/.test(trimmed)) return NaN;
  const cleaned = trimmed.replace(/,/g, '');
  // Plain decimals only: Number() would also accept "0x10", "0b11" or "1e3".
  return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(cleaned) ? Number(cleaned) : NaN;
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
  const n = parseNumber(value);
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
  return { ...atZeroCost, maxCost: atZeroCost.profit - input.target };
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
 * Competition ranks ("1, 2, 2, 4") for scores where higher is better: equal
 * scores share a rank. A null score (can't be reached) gets no rank.
 */
export function competitionRanks(scores) {
  return scores.map((s) => (s === null ? null : 1 + scores.filter((t) => t !== null && t > s).length));
}

/**
 * Run a calculator mode across platforms and rank the results best-first
 * (see scoreFor; unreachable last, ties in platform order).
 */
export function rank(mode, input, ids) {
  const run = {
    profit: (p) => evaluate(p, input),
    maxbuy: (p) => maxBuy(p, input),
    price: (p) => listPrice(p, input) ?? { id: p.id, name: p.name, short: p.short ?? p.name, unreachable: true },
  }[mode] ?? ((p) => evaluate(p, input)); // like scoreFor: anything else is profit
  const key = (r) => scoreFor(mode, r) ?? -Infinity;
  return pick(ids)
    .map(run)
    .sort((a, b) => (key(a) === key(b) ? 0 : key(b) > key(a) ? 1 : -1));
}

export { PLATFORMS, PLATFORM_BY_ID, MAX_CENTS };
