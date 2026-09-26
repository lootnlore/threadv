// What the social card (src/assets/og.png) says: the site name, the
// calculator's defaults and the top marketplaces for them, with their ranks
// and Best badges as the site shows them (see rowsToShow for which rows).
// gen-images.mjs draws the
// card from this and saves it to src/assets/og.json; a build test compares that
// file with this function, so a fee change that alters the card fails `npm test`
// until the images are regenerated.
import config from '../site.config.mjs';
import { normalizeInputs, rank, scoreFor, competitionRanks, recommends, DEFAULTS } from '../src/engine/calc.mjs';
import { PLATFORMS } from '../src/engine/fees.mjs';
import { money } from '../src/engine/render.mjs';

/**
 * How many of the leading results (ranked best-first, null for out of range)
 * the card lists: at most `max`, ending at a whole rank so a tie is never cut
 * in half, and never an out-of-range one. Only when more than `max` tie for
 * first does the card cut them (to `max`).
 */
export function rowsToShow(ranks, max) {
  const ranked = ranks.filter((n) => n !== null);
  const fits = ranked.filter((n) => ranked.filter((m) => m <= n).length <= max);
  return fits.length ? Math.max(...fits.map((n) => ranked.filter((m) => m <= n).length)) : Math.min(max, ranked.length);
}

export function ogData() {
  const input = normalizeInputs(DEFAULTS);
  const results = rank('profit', input);
  const ranks = competitionRanks(results.map((r) => scoreFor('profit', r)));
  return {
    name: config.name,
    caption: { price: DEFAULTS.price, cost: DEFAULTS.cost, label: DEFAULTS.label },
    marketplaces: PLATFORMS.length,
    rows: results.slice(0, rowsToShow(ranks, 4)).map((r, i) => ({
      rank: ranks[i],
      best: ranks[i] === 1 && recommends('profit', r, input.target), // as on the site
      name: r.short,
      profit: money(r.profit),
    })),
  };
}
