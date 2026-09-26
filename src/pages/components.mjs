import { esc, renderResults, renderVerdict, MODES } from '../engine/render.mjs';
import { DEFAULTS, normalizeInputs, rank, rankedRows } from '../engine/calc.mjs';
import { PLATFORMS, EBAY_CATEGORIES, ETSY_OFFSITE, FEES_VERIFIED, RATES, pctText, usdText } from '../engine/fees.mjs';
import { MILEAGE_YEAR } from '../data/mileage.mjs';

/** Absolute URL on this site, for canonical links and structured data. */
export const abs = (config, path) => `${config.url}${path}`;

/**
 * Date text for YYYY-MM-DD (or YYYY-MM for a whole month), read at UTC noon so
 * no timezone can shift the day. 'long': September 25, 2026. 'short': Sep 25,
 * 2026 or Jan 2025. 'day': September 25.
 */
export function formatDate(iso, style = 'long') {
  const monthOnly = iso.length === 7;
  return new Date(`${monthOnly ? `${iso}-01` : iso}T12:00:00Z`).toLocaleDateString('en-US', {
    month: style === 'short' ? 'short' : 'long',
    ...(monthOnly ? {} : { day: 'numeric' }),
    ...(style === 'day' ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  });
}

export const verifiedLabel = formatDate(FEES_VERIFIED);

/** Recent fee changes, newest first. Shown on the home and fee hub pages. `date` is YYYY-MM-DD, or YYYY-MM when only the month is known. */
export const FEE_CHANGES = [
  { date: '2026-09-21', platform: 'whatnot', text: 'Whatnot switches to volume tiers. 8% stays standard under $15k per four weeks; top public tiers drop to 4.5% for fashion.' },
  { date: '2026-08-04', platform: 'tiktok', text: 'TikTok Shop raises its standard US referral fee from 6% to 8%.' },
  { date: '2026-05-20', platform: 'grailed', text: 'Grailed cuts commission to 6% (minimum $1.99) on sales under $120.' },
  { date: '2026-03-23', platform: 'depop', text: 'Depop sets a 12% fee on items sold through Boosted Listings.' },
  { date: '2025-01', platform: 'mercari', text: 'Mercari drops the seller payment processing fee. Sellers pay a flat 10%.' },
];

function moneyField(name, label, hint) {
  const hidden = MODES.profit.hidden.includes(name) ? ' hidden' : '';
  return `<div class="field" data-field="${name}"${hidden}>
<label for="f-${name}">${label}</label>
<div class="input-wrap"><span class="affix" aria-hidden="true">$</span><input id="f-${name}" name="${name}" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="${DEFAULTS[name]}" aria-describedby="h-${name}"></div>
<p class="hint" id="h-${name}">${hint}</p>
</div>`;
}

function pctField(name, label, hint, { hidden = false } = {}) {
  return `<div class="field" data-field="${name}"${hidden ? ' hidden' : ''}>
<label for="f-${name}">${label}</label>
<div class="input-wrap"><input id="f-${name}" name="${name}" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="${DEFAULTS[name]}" aria-describedby="h-${name}"><span class="affix affix-end" aria-hidden="true">%</span></div>
<p class="hint" id="h-${name}">${hint}</p>
</div>`;
}

function select(name, label, options) {
  const opts = Object.entries(options)
    .map(([value, o]) => `<option value="${value}"${value === DEFAULTS[name] ? ' selected' : ''}>${esc(o.label)}</option>`)
    .join('');
  return `<div class="field field-wide" data-field="${name}"><label for="f-${name}">${label}</label><select id="f-${name}" name="${name}">${opts}</select></div>`;
}

/**
 * The calculator widget, pre-rendered with default results so the page is
 * useful (and indexable) before JavaScript loads. `focus` highlights one
 * platform on its fee page.
 */
export function calculator({ focus } = {}) {
  const input = normalizeInputs(DEFAULTS);
  const rows = rankedRows('profit', rank('profit', input), input.target);
  const verdict = renderVerdict('profit', rows, input);
  const tabs = Object.entries(MODES).map(
    ([id, { label }], i) =>
      `<button type="button" role="tab" id="tab-${id}" data-mode="${id}" aria-controls="calc-panel" aria-selected="${i === 0}"${i === 0 ? '' : ' tabindex="-1"'}>${label}</button>`,
  ).join('');
  const platformBoxes = PLATFORMS.map(
    (p) =>
      `<label class="check"><input type="checkbox" name="platform" value="${p.id}" checked> ${esc(p.name)}</label>`,
  ).join('');

  return `<section class="calc" id="calculator" aria-label="Reseller profit calculator" data-calc${focus ? ` data-focus="${focus}"` : ''}>
<div class="calc-input">
<div class="modes" role="tablist" aria-label="What do you want to know?">${tabs}</div>
<div class="calc-panel" id="calc-panel" role="tabpanel" aria-labelledby="tab-profit">
<form class="calc-form" method="dialog" autocomplete="off">
<p class="mode-hint" data-hint>${MODES.profit.hint}</p>
<div class="fields">
${moneyField('price', 'Sell price', 'What it will sell for')}
${moneyField('cost', 'You paid', 'Item cost')}
${moneyField('ship', 'Shipping charged', '$0 if shipping is free')}
${moneyField('label', 'Your label cost', 'Postage you pay')}
${moneyField('target', 'Minimum profit', MODES.profit.targetHint)}
</div>
<details class="tune">
<summary>Fine-tune fees</summary>
<div class="fields">
${pctField('taxRate', 'Buyer sales tax', 'Some platforms charge fees on tax. Typical US rates are 6 to 10%.')}
${moneyField('other', 'Supplies &amp; other costs', 'Mailers, tape, credits')}
${select('ebayCategory', 'eBay category', EBAY_CATEGORIES)}
${pctField('ebayCustomRate', 'eBay category rate', 'Final value fee for your category', { hidden: true })}
${pctField('ebayAdRate', 'eBay Promoted Listings', 'Your ad rate, 0 if not promoted')}
${select('etsyOffsite', 'Etsy Offsite Ads', ETSY_OFFSITE)}
${pctField('whatnotRate', 'Whatnot commission', `${pctText(RATES.whatnot.commission)} standard, lower at high volume`)}
${pctField('tiktokRate', 'TikTok Shop fee', `${pctText(RATES.tiktok.referral)} referral, plus any creator commission`)}
<label class="check check-wide"><input type="checkbox" name="depopBoost" value="true"> Sold through a Depop boost (${pctText(RATES.depop.boost)} fee)</label>
</div>
<fieldset class="platforms"><legend>Marketplaces to compare</legend><div class="check-grid">${platformBoxes}</div></fieldset>
<button type="button" class="btn btn-ghost btn-small" data-reset>Reset to defaults</button>
</details>
<button type="submit" class="btn btn-primary see-results" hidden>See results</button>
</form>
</div>
</div>
<div class="calc-output">
<noscript><p class="shared-note">Turn on JavaScript to use your own numbers. The results below are for the example shown.</p></noscript>
<p class="shared-note" data-shared-note hidden>Viewing a shared result. Your saved settings are untouched. <a href="./">Use my settings</a></p>
<div class="verdict verdict-${verdict.tone}" data-verdict tabindex="-1">${verdict.html}</div>
<p class="visually-hidden" role="status" data-verdict-live></p>
<ul class="results" role="list" data-results aria-label="Results by marketplace">${renderResults('profit', rows, { focus, target: input.target })}</ul>
<div class="calc-foot">
<p>Fees verified ${verifiedLabel}. <a href="/fees/">How each fee is calculated</a></p>
<button type="button" class="btn btn-ghost btn-small" data-share hidden>Copy link to this result</button>
<span class="visually-hidden" role="status" data-share-status></span>
</div>
</div>
</section>`;
}

export function crosslisters(config) {
  const cards = config.crosslisters
    .map(
      (c) => `<li class="card tool">
<h3>${esc(c.name)}</h3>
<p>${esc(c.blurb)}</p>
<p class="tool-perk">${esc(c.perk)}</p>
<a class="btn btn-secondary" href="${esc(c.url)}" rel="sponsored noopener" target="_blank">Try ${esc(c.name)}<span class="visually-hidden"> (opens in a new tab)</span></a>
</li>`,
    )
    .join('');
  return `<section class="section" aria-labelledby="xl-title">
<div class="wrap">
<p class="eyebrow">Selling on three or more of these?</p>
<h2 id="xl-title">Stop retyping every listing</h2>
<p class="lede">A crosslister copies one listing to every marketplace and delists it everywhere when it sells, so the platform with the best payout is always an option.</p>
<ul class="tool-grid" role="list">${cards}</ul>
<p class="fineprint">Affiliate links. We may earn a commission if you subscribe, at no extra cost to you.</p>
</div>
</section>`;
}

export function trackerPromo(config) {
  return `<section class="section section-tint" aria-labelledby="tp-title">
<div class="wrap promo">
<div>
<p class="eyebrow">For your whole inventory</p>
<h2 id="tp-title">Track every flip from haul to payout</h2>
<p class="lede">The ${esc(config.tracker.name)} is a spreadsheet that works out fees and profit for every sale, shows your best platforms and slowest stock, and adds up expenses and mileage for tax time.</p>
<a class="btn btn-primary" href="/tracker/">See what&rsquo;s inside &middot; ${usdText(config.tracker.price)}</a>
</div>
<ul class="checklist" role="list">
<li>Standard fees for all ${PLATFORMS.length} marketplaces built in, plus an Actual fees column for promoted or boosted sales</li>
<li>Monthly profit, sell-through and days-to-sell dashboard</li>
<li>Expense and mileage logs with ${MILEAGE_YEAR} IRS rates</li>
<li>Works in Excel and Google Sheets</li>
</ul>
</div>
</section>`;
}

const ALERTS_LEDE = 'Marketplaces change fees several times a year. Get one short email when they do, with what it means for your prices.';

/** The email signup. The privacy policy lists what it is used for: fee alerts and the tracker launch note. */
export function newsletter(config, { heading = 'Get fee-change alerts', lede = ALERTS_LEDE, id = 'alerts', tag } = {}) {
  if (!config.newsletter.action) return '';
  const hidden = tag?.field ? `\n<input type="hidden" name="${esc(tag.field)}" value="${esc(tag.value)}">` : '';
  return `<section class="section" aria-labelledby="${id}-title" id="${id}">
<div class="wrap narrow center">
<h2 id="${id}-title">${esc(heading)}</h2>
<p class="lede">${esc(lede)}</p>
<form class="signup" action="${esc(config.newsletter.action)}" method="post" target="_blank">
<label class="visually-hidden" for="${id}-email">Email address</label>
<input id="${id}-email" name="${esc(config.newsletter.emailField)}" type="email" autocomplete="email" required placeholder="you@example.com">${hidden}
<button class="btn btn-primary" type="submit">Subscribe</button>
</form>
<p class="fineprint">No spam. Unsubscribe any time.</p>
</div>
</section>`;
}

export function feeChanges(limit = FEE_CHANGES.length) {
  const items = FEE_CHANGES.slice(0, limit)
    .map(
      (c) =>
        `<li><time datetime="${c.date}">${formatDate(c.date, 'short')}</time><p>${esc(c.text)} <a href="/fees/${c.platform}/">Details</a></p></li>`,
    )
    .join('');
  return `<ol class="timeline" role="list">${items}</ol>`;
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&rsquo;': '\u2019', '&middot;': '\u00b7' };
/** HTML answer -> plain text for structured data. */
const plainText = (html) => html.replace(/<[^>]+>/g, '').replace(/&[#a-z0-9]+;/g, (e) => ENTITIES[e] ?? e);

/**
 * FAQ markup plus matching FAQPage structured data. Answers are trusted HTML
 * (they may contain links), so callers escape any data they put in them.
 */
export function faq(items, headingId = 'faq-title', heading = 'Questions resellers ask') {
  const html = `<section class="section" aria-labelledby="${headingId}">
<div class="wrap narrow">
<h2 id="${headingId}">${esc(heading)}</h2>
<div class="faq">${items
    .map((q) => `<details><summary>${esc(q.q)}</summary><p>${q.a}</p></details>`)
    .join('')}</div>
</div>
</section>`;
  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((q) => ({
      '@type': 'Question',
      name: q.q,
      acceptedAnswer: { '@type': 'Answer', text: plainText(q.a) },
    })),
  };
  return { html, jsonld };
}

export function breadcrumbs(config, trail) {
  const html = `<nav class="crumbs" aria-label="Breadcrumb"><ol>${trail
    .map((t, i) =>
      i === trail.length - 1
        ? `<li><span aria-current="page">${esc(t.name)}</span></li>`
        : `<li><a href="${t.path}">${esc(t.name)}</a></li>`,
    )
    .join('')}</ol></nav>`;
  const jsonld = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((t, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: t.name,
      item: abs(config, t.path),
    })),
  };
  return { html, jsonld };
}

