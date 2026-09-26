import { calculator, crosslisters, trackerPromo, newsletter, feeChanges, faq, abs } from './components.mjs';
import { PLATFORMS, PLATFORM_BY_ID, FEES_VERIFIED, RATES, pctText, usdText, andList } from '../engine/fees.mjs';
import { normalizeInputs, evaluate } from '../engine/calc.mjs';
import { esc, money } from '../engine/render.mjs';

export function home(config) {
  const posh = evaluate(PLATFORM_BY_ID.poshmark, normalizeInputs({ price: 40, taxRate: 0 }));
  const merc = evaluate(PLATFORM_BY_ID.mercari, normalizeInputs({ price: 40, taxRate: 0 }));

  const questions = faq([
    {
      q: 'Which marketplace has the lowest fees for resellers?',
      a: `It depends on the price and who pays shipping. Depop (US) charges no selling fee, only ${pctText(RATES.depop.proc)} + ${usdText(RATES.depop.procFixed)} processing, and Facebook Marketplace local pickup is free. For shipped sales, Mercari takes a flat ${pctText(RATES.mercari.rate)} while Poshmark takes ${pctText(RATES.poshmark.rate)} but the buyer pays for the label. Put your numbers into the calculator above to see the ranking for your item.`,
    },
    {
      q: 'How much does Poshmark take from a $40 sale?',
      a: `Poshmark takes ${pctText(RATES.poshmark.rate)} on sales of ${usdText(RATES.poshmark.threshold)} or more, so ${money(posh.feeTotal)} on a $40 sale and you receive ${money(posh.payout)}. Under ${usdText(RATES.poshmark.threshold)} it charges a flat ${usdText(RATES.poshmark.flat)}. <a href="/fees/poshmark/">Poshmark fee details</a>.`,
    },
    {
      q: 'What is a max buy price?',
      a: `It is the most you can pay for an item and still make your minimum profit after fees, shipping and supplies. Switch the calculator to "Max buy", enter what similar items sell for, and you have a number to check against the price tag in the store.`,
    },
    {
      q: 'Why does the calculator ask for sales tax?',
      a: `${andList(PLATFORMS.filter((p) => p.feesIncludeTax).map((p) => p.name))} calculate part of their fees on the order total including the sales tax the buyer pays. The tax itself goes to the state, but the fee on it comes out of your payout. Set your typical rate under "Fine-tune fees".`,
    },
    {
      q: 'How do I price one item for several marketplaces?',
      a: `Use "List price" mode. Enter what you paid and the profit you want, and the calculator finds the lowest price on each marketplace that gets you there. On a $40 item you keep ${money(merc.payout)} on Mercari but ${money(posh.payout)} on Poshmark, so the same profit needs a different price on each.`,
    },
    {
      q: 'How current are these fees?',
      a: `Every fee was checked against the marketplaces' own help pages on the date shown under the calculator. When a platform changes its fees we update the numbers and log the change in our <a href="/fees/">fee guide</a>.`,
    },
  ]);

  const app = {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: `${config.name} Reseller Profit Calculator`,
    url: abs(config, '/'),
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Any',
    browserRequirements: 'Requires JavaScript',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    description: config.description,
  };
  const site = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: config.name,
    url: abs(config, '/'),
  };

  const body = `
<section class="hero">
<div class="wrap">
<p class="eyebrow">Free &middot; No sign-up &middot; Works offline</p>
<h1>Reseller profit calculator</h1>
<p class="lede">See what you would really keep on ${PLATFORMS.length} marketplaces after fees, shipping and cost, then decide if it is worth buying.</p>
${calculator()}
</div>
</section>

<section class="section" aria-labelledby="how-title">
<div class="wrap">
<h2 id="how-title">Three questions, answered in the aisle</h2>
<ol class="steps" role="list">
<li class="card"><h3>What will I make?</h3><p><strong>Profit</strong> mode ranks every marketplace by what you keep after fees, the label and your cost.</p></li>
<li class="card"><h3>What should I pay?</h3><p><strong>Max buy</strong> works backwards from the sale price to the most you can spend and still hit your minimum.</p></li>
<li class="card"><h3>What should I list it at?</h3><p><strong>List price</strong> finds the lowest price on each platform that clears your target, which is useful when crosslisting.</p></li>
</ol>
<p class="fineprint">Add ${esc(config.name)} to your home screen and it keeps working in stores with no signal.</p>
</div>
</section>

${crosslisters(config)}

<section class="section" aria-labelledby="changes-title">
<div class="wrap narrow">
<p class="eyebrow">Fee tracker</p>
<h2 id="changes-title">Recent marketplace fee changes</h2>
${feeChanges(4)}
<p><a class="more" href="/fees/">Compare all marketplace fees</a></p>
</div>
</section>

${trackerPromo(config)}
${newsletter(config)}
${questions.html}
`;

  return {
    path: '/',
    lastmod: FEES_VERIFIED,
    title: `Reseller Profit Calculator: eBay, Poshmark, Mercari & More | ${config.name}`,
    description: config.description,
    app: true,
    jsonld: [site, app, questions.jsonld],
    body,
  };
}
