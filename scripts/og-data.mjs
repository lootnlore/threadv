// What the social card (src/assets/og.png) says: the site name, the
// calculator's defaults and the top marketplaces for them, with their ranks
// and Best badges as the site shows them (see rowsToShow for which rows).
// gen-images.mjs draws the card from this and saves it to
// src/assets/og.json; a build test compares that
// file with this function, so a fee change that alters the card fails `npm test`
// until the images are regenerated.
import config from '../site.config.mjs';
import { normalizeInputs, rank, rankedRows, DEFAULTS } from '../src/engine/calc.mjs';
import { PLATFORMS, usdText } from '../src/engine/fees.mjs';
import { money } from '../src/engine/render.mjs';

/** Rows the card's panel has room for (gen-images.mjs lays out 630px). */
export const CARD_ROWS = 4;

/**
 * How many of the leading results the card lists, given their ranks in
 * best-first order (null for out of range, last): at most `max`, ending
 * where a rank ends so a tie is never cut in half, and never an out-of-range
 * one. Only when more than `max` tie for first are they cut (to `max`).
 */
export function rowsToShow(ranks, max) {
  const sorted = ranks.every((n, i) => i === 0 || n == null || (ranks[i - 1] != null && ranks[i - 1] <= n));
  if (!sorted) throw new Error(`rowsToShow needs ranks best-first, got ${JSON.stringify(ranks)}`);
  let shown = 0;
  for (let i = 0; i < max && ranks[i] != null; i++) if (ranks[i + 1] !== ranks[i]) shown = i + 1;
  if (shown) return shown;
  return ranks[0] == null ? 0 : max; // nothing ranked, or more than `max` tied for first
}

/** The card's content; `raw` is the calculator input (the defaults). */
const usd = (cents) => usdText(cents / 100);

export function ogData(raw = DEFAULTS) {
  const input = normalizeInputs(raw);
  const rows = rankedRows('profit', rank('profit', input), input.target);
  return {
    name: config.name,
    // From the checked input, formatted as on the site ("$40", "$7.50").
    caption: `${usd(input.price)} sale \u00b7 ${usd(input.cost)} cost \u00b7 ${usd(input.label)} label`,
    marketplaces: PLATFORMS.length,
    rows: rows.slice(0, rowsToShow(rows.map((row) => row.rank), CARD_ROWS)).map(({ r, rank: n, best }) => ({
      rank: n,
      best,
      name: r.short,
      profit: money(r.profit),
    })),
  };
}
