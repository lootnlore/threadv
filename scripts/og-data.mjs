// What the social card (src/assets/og.png) says: the site name, the
// calculator's defaults and the top marketplaces for them, with their ranks
// as the site shows them (ties share one; a tie is never cut in half, so the
// card lists up to four rows, ending at a whole rank). gen-images.mjs draws the
// card from this and saves it to src/assets/og.json; a build test compares that
// file with this function, so a fee change that alters the card fails `npm test`
// until the images are regenerated.
import config from '../site.config.mjs';
import { normalizeInputs, rank, scoreFor, competitionRanks, DEFAULTS } from '../src/engine/calc.mjs';
import { PLATFORMS } from '../src/engine/fees.mjs';
import { money } from '../src/engine/render.mjs';

const MAX_ROWS = 4;

export function ogData() {
  const results = rank('profit', normalizeInputs(DEFAULTS));
  const ranks = competitionRanks(results.map((r) => scoreFor('profit', r)));
  // The last rank whose rows all fit (at least the first, however many tie).
  const last = Math.max(1, ...ranks.filter((n) => ranks.filter((m) => m <= n).length <= MAX_ROWS));
  return {
    name: config.name,
    caption: { price: DEFAULTS.price, cost: DEFAULTS.cost, label: DEFAULTS.label },
    marketplaces: PLATFORMS.length,
    rows: results.flatMap((r, i) => (ranks[i] <= last ? [{ rank: ranks[i], name: r.short, profit: money(r.profit) }] : [])),
  };
}
