import { esc } from '../engine/render.mjs';
import { PLATFORMS } from '../engine/fees.mjs';
import { formatDate } from './components.mjs';

export const LEGAL_UPDATED = '2026-09-25';
const UPDATED = formatDate(LEGAL_UPDATED);

function contactLine(config) {
  return config.contactEmail
    ? `Questions? Email <a href="mailto:${esc(config.contactEmail)}">${esc(config.contactEmail)}</a>.`
    : 'Questions? Use the contact details in your purchase receipt or newsletter emails.';
}

function page(config, path, title, description, content) {
  return {
    path,
    lastmod: LEGAL_UPDATED,
    title: `${title} | ${config.name}`,
    description,
    body: `<div class="wrap narrow prose legal">
<h1>${esc(title)}</h1>
<p class="fineprint">Last updated ${UPDATED}</p>
${content}
</div>`,
  };
}

export function privacy(config) {
  const name = esc(config.name);
  const analytics = config.analytics.plausibleDomain
    ? '<p>We use Plausible Analytics to count page views. It does not use cookies, does not collect personal data, and only gives us aggregate numbers such as which pages are popular. It is sent the page address without the part after the <code>#</code>, so it never sees the numbers you type.</p>'
    : '<p>We do not use analytics or tracking cookies.</p>';
  return page(
    config,
    '/privacy/',
    'Privacy policy',
    `How ${config.name} handles your data: calculations stay in your browser, no accounts, no tracking cookies.`,
    `<h2>The short version</h2>
<p>${name} has no accounts. The calculator runs entirely in your browser, and the numbers you type are never sent to us.</p>
<h2>What stays on your device</h2>
<p>Your "Fine-tune fees" settings and chosen marketplaces are saved in your browser's local storage so they are there next time. Clearing your browser data removes them. The page also caches itself on your device so the calculator works offline.</p>
<p>The address bar keeps your current numbers after the <code>#</code> sign so you can bookmark or share a result. Browsers never send that part of an address to a web server, so it does not reach us or our logs.</p>
<h2>Server logs</h2>
<p>Like almost every website, our web server keeps standard access logs (IP address, page requested, browser type and time) to keep the site secure and fix problems. Logs are deleted automatically after 14 days.</p>
<h2>Analytics</h2>
${analytics}
<h2>Email alerts</h2>
<p>If you subscribe to fee-change alerts, your email address is stored by our email provider and used only to send those alerts. Every email has an unsubscribe link.</p>
<h2>Purchases</h2>
<p>Tracker purchases are processed by our store provider. We receive your email address and order details so we can deliver the file and support you. We never see or store card numbers.</p>
<h2>Affiliate links</h2>
<p>When you click a link to a partner such as a crosslisting tool, that partner may set a cookie to record the referral under its own privacy policy.</p>
<h2>Children</h2>
<p>${name} is not directed at children under 13 and we do not knowingly collect their information.</p>
<h2>Changes</h2>
<p>If this policy changes we will update the date above. ${contactLine(config)}</p>`,
  );
}

export function terms(config) {
  const name = esc(config.name);
  return page(
    config,
    '/terms/',
    'Terms & disclosures',
    `Terms of use, fee accuracy disclaimer, affiliate disclosure and license for ${config.name} tools and downloads.`,
    `<h2>Estimates, not guarantees</h2>
<p>${name}'s calculators estimate marketplace fees and profit from each marketplace's published fee schedule. Marketplaces change their fees, run promotions and apply category or account-specific rates, so your actual fees may differ. Always confirm important numbers with the marketplace. Nothing on this site is financial, legal or tax advice.</p>
<h2>Affiliate disclosure</h2>
<p>Some links on ${name}, including links to crosslisting tools, are affiliate links. If you sign up or buy through them we may earn a commission at no extra cost to you. Affiliate relationships never change the fee numbers the calculator shows.</p>
<h2>Trademarks</h2>
<p>${name} is independent and is not affiliated with, endorsed by or sponsored by ${PLATFORMS.map((p) => esc(p.company ?? p.name)).join(', ')} or any other company named on this site. All trademarks belong to their owners and are used only to identify their services.</p>
<h2>Digital products</h2>
<p>When you buy the ${esc(config.tracker.name)} you get a license to use it for your own reselling business, including on multiple devices. You may not resell, share or redistribute the file or modified copies of it. Problems with your download? Contact us and we will make it right.</p>
<h2>Using the site</h2>
<p>You may use ${name}'s free tools for personal and commercial reselling. Please do not scrape the site at high volume or attempt to disrupt it. The site is provided "as is" without warranties of any kind, and to the extent the law allows, ${name} is not liable for losses arising from its use.</p>
<h2>Changes</h2>
<p>We may update these terms and will change the date above when we do. ${contactLine(config)}</p>`,
  );
}

export function notFound(config) {
  return {
    path: '/404.html',
    title: `Page not found | ${config.name}`,
    description: 'This page does not exist. Try the free reseller profit calculator or the marketplace fee guide instead.',
    noindex: true,
    body: `<div class="wrap narrow center not-found">
<p class="eyebrow">404</p>
<h1>That page sold already</h1>
<p class="lede">We could not find what you were looking for. Try one of these instead:</p>
<p class="cta-row center"><a class="btn btn-primary" href="/">Profit calculator</a><a class="btn btn-ghost" href="/fees/">Marketplace fees</a></p>
</div>`,
  };
}

/** Shown by the service worker for pages that were never cached, when offline. */
export function offline(config) {
  return {
    path: '/offline.html',
    title: `You are offline | ${config.name}`,
    description: `You are offline. The ${config.name} profit calculator still works without a connection.`,
    noindex: true,
    body: `<div class="wrap narrow center not-found">
<p class="eyebrow">No connection</p>
<h1>You are offline</h1>
<p class="lede">This page has not been saved on your device yet, but the calculator works without a signal.</p>
<p class="cta-row center"><a class="btn btn-primary" href="/">Open the calculator</a></p>
</div>`,
  };
}
