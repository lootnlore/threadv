import { PLATFORMS, FEES_VERIFIED, andList } from '../engine/fees.mjs';
import { normalizeInputs, evaluate, DEFAULTS } from '../engine/calc.mjs';
import { esc, money, percent } from '../engine/render.mjs';
import { calculator, crosslisters, newsletter, feeChanges, faq, breadcrumbs, verifiedLabel } from './components.mjs';

const EXAMPLE_PRICES = [10, 25, 50, 100, 250];

/** A fee table row as a sentence, following the row convention in src/engine/fees.mjs. */
function feeSentence([fee, rate, base]) {
  if (base === '-') return `${fee}: ${rate}`;
  if (base.startsWith('Per ')) return `${fee}: ${rate}, ${base.toLowerCase()}`;
  return `${fee}: ${rate}, charged on ${base.toLowerCase()}`;
}
/** The fee schedule's year, for titles and headings: follows FEES_VERIFIED. */
const YEAR = FEES_VERIFIED.slice(0, 4);

/** Fees at a plain sale: no shipping charged, default tax and options. */
const at = (platform, price) => evaluate(platform, normalizeInputs({ ...DEFAULTS, price, cost: 0, ship: 0, label: 0 }));

/** The calculator defaults behind a platform's example numbers, where it has options. */
const DEFAULT_OPTIONS = { ebay: 'most categories, no Promoted Listings', depop: 'no boost', etsy: 'no Offsite Ads' };

/** "Assumes ..." for the example figures of one platform, or of all of them on the hub. */
function assumptionsFor(platforms) {
  const parts = ['no shipping charged to the buyer'];
  if (platforms.some((p) => p.feesIncludeTax)) parts.push(`${DEFAULTS.taxRate}% buyer sales tax`);
  const options = platforms
    .filter((p) => DEFAULT_OPTIONS[p.id])
    .map((p) => (platforms.length > 1 ? `${p.name} ${DEFAULT_OPTIONS[p.id]}` : DEFAULT_OPTIONS[p.id]));
  if (options.length) parts.push(`default options (${options.join('; ')})`);
  return `Assumes ${andList(parts)}.`;
}

export function feesHub(config) {
  const rows = PLATFORMS.map((p) => {
    const a = at(p, 25);
    const b = at(p, 100);
    return `<tr>
<th scope="row"><a href="/fees/${p.id}/">${esc(p.name)}</a></th>
<td class="num">${money(a.feeTotal)}</td>
<td class="num">${money(b.feeTotal)}</td>
<td class="num">${money(b.payout)}</td>
<td class="prose">${esc(p.headline)}</td>
</tr>`;
  }).join('');

  const crumbs = breadcrumbs(config, [
    { name: 'Home', path: '/' },
    { name: 'Marketplace fees', path: '/fees/' },
  ]);

  const body = `
<div class="wrap">
${crumbs.html}
<header class="page-head">
<h1>Marketplace seller fees in ${YEAR}</h1>
<p class="lede">What ${andList(PLATFORMS.map((p) => p.name))} take from each sale, checked against their own fee pages on ${verifiedLabel}.</p>
</header>
<section class="table-wrap" tabindex="0" aria-labelledby="cmp-caption">
<table class="data">
<caption id="cmp-caption">Fees compared at $25 and $100</caption>
<thead><tr><th scope="col">Market&shy;place</th><th scope="col" class="num">Fees on $25</th><th scope="col" class="num">Fees on $100</th><th scope="col" class="num">You keep of $100</th><th scope="col" class="prose">How fees work</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</section>
<p class="fineprint">${esc(assumptionsFor(PLATFORMS))} Shipping and label costs change the ranking, so use the <a href="/#calculator">calculator</a> for your real numbers.</p>
</div>

<section class="section" aria-labelledby="changes-title">
<div class="wrap narrow">
<h2 id="changes-title">Fee changes we are tracking</h2>
${feeChanges()}
</div>
</section>

<section class="section section-tint" aria-labelledby="method-title">
<div class="wrap narrow prose">
<h2 id="method-title">How we calculate fees</h2>
<p>Each marketplace charges on a different base. eBay charges its percentage on the whole order including shipping and the buyer's sales tax. Mercari charges on the item plus shipping. Whatnot charges commission on the item price only but processing on the full order. Poshmark ignores shipping entirely because the buyer pays for the label.</p>
<p>${esc(config.name)} models each of these bases separately, rounds every fee to the cent like the marketplaces do, and shows the full breakdown for every result. Rates are for US sellers without paid store subscriptions. Promotions, store plans, and category exceptions can lower or raise your actual fees.</p>
<p>Spotted a fee that changed? Every platform page links to the official source we used.</p>
</div>
</section>

${crosslisters(config)}
${newsletter(config)}
`;

  return {
    path: '/fees/',
    lastmod: FEES_VERIFIED,
    title: `Seller Fees ${YEAR}: eBay vs Poshmark vs Mercari & More | ${config.name}`,
    description: `Side-by-side ${YEAR} seller fees for ${PLATFORMS.length} resale marketplaces, with the fee on a $25 and $100 sale and what you keep. Verified ${verifiedLabel}.`,
    jsonld: [crumbs.jsonld],
    body,
  };
}

/** Escaped FAQ answer, computed from the engine so it can't contradict the fee rules. */
function shippingAnswer(platform) {
  const name = esc(platform.name);
  if (!platform.sellerPaysShipping) {
    return `No. On ${name} the buyer pays for the shipping label, so shipping is not part of your fees or your payout.`;
  }
  const fees = (ship) => evaluate(platform, normalizeInputs({ price: 50, ship, taxRate: 0 })).feeTotal;
  const extra = fees(10) - fees(0);
  return extra > 0
    ? `Yes. ${name} counts shipping you charge the buyer in its fee base, so charging $10 for shipping adds ${money(extra)} in fees. The calculator includes this automatically when you enter a shipping amount.`
    : `No. ${name} calculates its fees on the item price, so shipping you charge the buyer does not add to them. You still pay for your own label.`;
}

export function feePage(config, platform) {
  const ex = at(platform, 40);
  const hundred = at(platform, 100);

  const rows = platform.rows
    .map(([fee, rate, base]) => `<tr><th scope="row">${esc(fee)}</th><td>${esc(rate)}</td><td>${base === '-' ? '\u2014' : esc(base)}</td></tr>`)
    .join('');

  const examples = EXAMPLE_PRICES.map((price) => {
    const r = at(platform, price);
    return `<tr><th scope="row" class="num">${money(r.price)}</th><td class="num">${money(r.feeTotal)}</td><td class="num">${percent(r.feeRate)}</td><td class="num">${money(r.payout)}</td></tr>`;
  }).join('');

  const others = PLATFORMS.map((p) => at(p, 50))
    .sort((a, b) => b.payout - a.payout)
    .map(
      (r) =>
        `<li${r.id === platform.id ? ' class="is-current"' : ''}>${
          r.id === platform.id ? `<strong>${esc(r.name)}</strong>` : `<a href="/fees/${r.id}/">${esc(r.name)}</a>`
        }<span class="num">${money(r.payout)}</span></li>`,
    )
    .join('');

  const sources = platform.sources
    .map((s) => `<li><a href="${esc(s.url)}" rel="noopener" target="_blank">${esc(s.label)}<span class="visually-hidden"> (opens in a new tab)</span></a></li>`)
    .join('');

  const questions = faq(
    [
      {
        q: `How much does ${platform.name} take from a $100 sale?`,
        a: `${money(hundred.feeTotal)}, or ${percent(hundred.feeRate)} of the sale, so you receive ${money(hundred.payout)}. ${esc(assumptionsFor([platform]))}`,
      },
      {
        q: `How are ${platform.name} fees calculated?`,
        a: esc(`${platform.rows.map(feeSentence).join('. ')}.`),
      },
      {
        q: `Does ${platform.name} charge fees on shipping?`,
        a: shippingAnswer(platform),
      },
    ],
    'pfaq-title',
    `${platform.name} fee questions`,
  );

  const crumbs = breadcrumbs(config, [
    { name: 'Home', path: '/' },
    { name: 'Marketplace fees', path: '/fees/' },
    { name: platform.name, path: `/fees/${platform.id}/` },
  ]);

  const body = `
<div class="wrap">
${crumbs.html}
<header class="page-head">
<h1>${esc(platform.name)} fees calculator (${YEAR})</h1>
<p class="answer"><strong>${esc(platform.headline)}.</strong> On a $40 sale${
   platform.feesIncludeTax ? ` (plus ${DEFAULTS.taxRate}% sales tax paid by the buyer, which ${esc(platform.name)} also charges on)` : ''
 } ${esc(platform.name)} takes ${money(ex.feeTotal)} and you receive ${money(ex.payout)}.</p>
</header>
${calculator({ focus: platform.id })}
</div>

<section class="section" aria-labelledby="how-title">
<div class="wrap narrow">
<h2 id="how-title">How ${esc(platform.name)} fees work</h2>
<section class="table-wrap" tabindex="0" aria-label="${esc(platform.name)} fee table">
<table class="data">
<thead><tr><th scope="col">Fee</th><th scope="col">Rate</th><th scope="col">Charged on</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</section>
<h3>Good to know</h3>
<ul class="notes">${platform.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
</div>
</section>

<section class="section section-tint" aria-labelledby="ex-title">
<div class="wrap narrow">
<h2 id="ex-title">${esc(platform.name)} fees at common prices</h2>
<section class="table-wrap" tabindex="0" aria-label="${esc(platform.name)} fees by sale price table">
<table class="data">
<thead><tr><th scope="col" class="num">Sale price</th><th scope="col" class="num">Total fees</th><th scope="col" class="num">Share of sale</th><th scope="col" class="num">You receive</th></tr></thead>
<tbody>${examples}</tbody>
</table>
</section>
<p class="fineprint">${esc(assumptionsFor([platform]))}</p>
</div>
</section>

<section class="section" aria-labelledby="cmp-title">
<div class="wrap narrow">
<h2 id="cmp-title">What you keep from a $50 sale, by marketplace</h2>
<ol class="compare" role="list">${others}</ol>
<p class="fineprint">Before shipping labels and item cost. Poshmark buyers pay for shipping; on the others it depends on your listing.</p>
</div>
</section>

<section class="section" aria-labelledby="src-title">
<div class="wrap narrow">
<h2 id="src-title">Sources</h2>
<p>Checked on ${verifiedLabel} against ${esc(platform.name)}'s own pages:</p>
<ul class="sources">${sources}</ul>
</div>
</section>

${questions.html}
${crosslisters(config)}
${newsletter(config)}
`;

  return {
    path: `/fees/${platform.id}/`,
    lastmod: FEES_VERIFIED,
    title: `${platform.name} Fee Calculator ${YEAR}: Fees, Payout & Profit | ${config.name}`,
    description: `${platform.headline}. See what ${platform.name} takes from a sale in ${YEAR} and what you keep after shipping and cost.`,
    app: true,
    jsonld: [crumbs.jsonld, questions.jsonld],
    body,
  };
}
