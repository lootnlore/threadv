// What the social card (src/assets/og.png) says: the site name, the
// calculator's defaults and the top four marketplaces for them. gen-images.mjs draws the
// card from this and saves it to src/assets/og.json; a build test compares that
// file with this function, so a fee change that alters the card fails `npm test`
// until the images are regenerated.
import config from '../site.config.mjs';
import { normalizeInputs, rank, DEFAULTS } from '../src/engine/calc.mjs';
import { PLATFORMS } from '../src/engine/fees.mjs';
import { money } from '../src/engine/render.mjs';

export function ogData() {
  return {
    name: config.name,
    caption: { price: DEFAULTS.price, cost: DEFAULTS.cost, label: DEFAULTS.label },
    marketplaces: PLATFORMS.length,
    rows: rank('profit', normalizeInputs(DEFAULTS))
      .slice(0, 4)
      .map((r) => ({ name: r.short, profit: money(r.profit) })),
  };
}
