import { esc } from '../engine/render.mjs';
import { PLATFORMS, andList, usdText, percentOf } from '../engine/fees.mjs';
import { IRS_MILEAGE_RATES, MILEAGE_YEAR } from '../data/mileage.mjs';
import { faq, breadcrumbs, newsletter, formatDate, abs } from './components.mjs';

/** Date the tracker page content last changed (sitemap lastmod). */
const TRACKER_UPDATED = '2026-09-25';

/** "the 2026 IRS business rates: 72.5¢ per mile from January 1 and 76¢ from July 1" */
function mileageText() {
  const rates = IRS_MILEAGE_RATES.filter((r) => r.from.startsWith(MILEAGE_YEAR));
  // Dollars per mile as cents: 0.725 -> 72.5 (percentOf is the same x100, rounded).
  const parts = rates.map((r, i) => `${percentOf(r.rate)}&cent;${i === 0 ? ' per mile' : ''} from ${formatDate(r.from, 'day')}`);
  return `the ${MILEAGE_YEAR} IRS business rate${rates.length > 1 ? 's' : ''}: ${andList(parts)}`;
}

function buyButton(config) {
  const { checkoutUrl, price } = config.tracker;
  if (checkoutUrl) {
    return `<a class="btn btn-primary btn-large" href="${esc(checkoutUrl)}" rel="noopener">Get the tracker &middot; ${usdText(price)}</a>`;
  }
  return `<span class="btn btn-primary btn-large is-disabled" aria-disabled="true">Coming soon &middot; ${usdText(price)}</span>`;
}

export function tracker(config) {
  const t = config.tracker;
  const questions = faq(
    [
      {
        q: 'Do I need Microsoft Excel?',
        a: 'No. The file works in Excel 2016 or newer (Windows and Mac) and in Google Sheets. To use Google Sheets, upload the file to Google Drive and open it with Sheets.',
      },
      {
        q: 'Which marketplaces does it cover?',
        a: `${PLATFORMS.map((p) => p.name).join(', ')}, plus an "Other" row for local sales or any platform you add. Fee rates live on one tab, so you can edit them yourself.`,
      },
      {
        q: 'What happens when a marketplace changes its fees?',
        a: 'Update the rate on the Fees tab and new sales use it. For exact records, type the fee from your payout into the "Actual fees" column and the tracker uses that number instead of the estimate.',
      },
      {
        q: 'Is this tax advice?',
        a: 'No. The tracker organizes your sales, expenses and mileage into totals you can hand to a tax professional or tax software. It does not file anything or give tax advice.',
      },
      {
        q: 'How do I get the file?',
        a: 'Checkout is handled by our store provider. You get a download link right after purchase, and you can re-download it from your receipt email.',
      },
    ],
    'tfaq-title',
    'Tracker questions',
  );

  const crumbs = breadcrumbs(config, [
    { name: 'Home', path: '/' },
    { name: t.name, path: '/tracker/' },
  ]);

  const product = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: t.name,
    description: 'Spreadsheet for resellers that tracks inventory, marketplace fees, profit, expenses and mileage. Works in Excel and Google Sheets.',
    image: abs(config, '/assets/og.png'),
    brand: { '@type': 'Brand', name: config.name },
    offers: {
      '@type': 'Offer',
      price: t.price.toFixed(2),
      priceCurrency: 'USD',
      availability: t.checkoutUrl ? 'https://schema.org/InStock' : 'https://schema.org/PreOrder',
      url: abs(config, '/tracker/'),
    },
  };

  const body = `
<div class="wrap">
${crumbs.html}
</div>
<section class="hero hero-product">
<div class="wrap product">
<div>
<p class="eyebrow">Excel &amp; Google Sheets &middot; One-time ${usdText(t.price)}</p>
<h1>${esc(t.name)}</h1>
<p class="lede">Log what you buy and what you sell. The tracker works out marketplace fees and profit on every item, shows which platforms and sources actually pay, and has your expense and mileage totals ready at tax time.</p>
<div class="cta-row">${buyButton(config)}<a class="btn btn-ghost" href="#inside">What&rsquo;s inside</a></div>
<p class="fineprint">One-time purchase. No subscription, no account.</p>
</div>
<figure class="sheet-preview" aria-label="Preview of the tracker dashboard">
<div class="sheet-bar"><span></span><span></span><span></span><b>Dashboard</b></div>
<table>
<thead><tr><th scope="col">Month</th><th scope="col">Sales</th><th scope="col" class="opt">Fees</th><th scope="col">Profit</th></tr></thead>
<tbody>
<tr><th scope="row">Jul</th><td>$1,842</td><td class="opt">$231</td><td class="pos">$1,047</td></tr>
<tr><th scope="row">Aug</th><td>$2,315</td><td class="opt">$288</td><td class="pos">$1,356</td></tr>
<tr><th scope="row">Sep</th><td>$2,760</td><td class="opt">$341</td><td class="pos">$1,629</td></tr>
</tbody>
</table>
<figcaption>Sample numbers. Your dashboard fills in from your own sales.</figcaption>
</figure>
</div>
</section>

<section class="section" id="inside" aria-labelledby="inside-title">
<div class="wrap">
<h2 id="inside-title">What&rsquo;s inside</h2>
<ul class="feature-grid" role="list">
<li class="card"><h3>Inventory &amp; sales log</h3><p>One row per item: where you sourced it, what you paid, where it sold and for how much. Fees, profit, ROI and days to sell fill in automatically.</p></li>
<li class="card"><h3>Dashboard</h3><p>Monthly sales, fees and profit, a breakdown by marketplace, sell-through rate, and the value of unsold inventory.</p></li>
<li class="card"><h3>Expenses</h3><p>Categorized business expenses (supplies, shipping, software, sourcing trips) with yearly totals by category.</p></li>
<li class="card"><h3>Mileage</h3><p>Log sourcing and post office trips. Deductions use ${mileageText()}.</p></li>
<li class="card"><h3>Editable fee table</h3><p>Every marketplace's standard rate in one place, matching this site. Change a number and the whole workbook updates. Promoted, boosted or special-category sales take the exact fee from your payout.</p></li>
<li class="card"><h3>Start Here guide</h3><p>A one-page walkthrough with an example row, so you are logging sales in five minutes.</p></li>
</ul>
<div class="center">${buyButton(config)}</div>
</div>
</section>

${questions.html}
${config.tracker.checkoutUrl ? '' : newsletter(config, {
   heading: 'Get notified when the tracker launches',
   lede: 'One email when it is ready, then the same short fee-change alerts every subscriber gets.',
   id: 'launch',
   tag: config.newsletter.launchTag,
 })}
`;

  return {
    path: '/tracker/',
    lastmod: TRACKER_UPDATED,
    // The product name usually carries the brand already: don't repeat it.
    title: `${t.name}: Profit, Fee & Tax Spreadsheet${t.name.includes(config.name) ? '' : ` | ${config.name}`}`,
    description: `Spreadsheet for resellers: automatic fees and profit for ${PLATFORMS.length} marketplaces, monthly dashboard, expense and mileage logs. Excel and Google Sheets. ${usdText(t.price)} one-time.`,
    jsonld: [crumbs.jsonld, product, questions.jsonld],
    body,
  };
}
