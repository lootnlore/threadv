import { readFileSync } from 'node:fs';
import { esc } from '../engine/render.mjs';
import { PLATFORMS } from '../engine/fees.mjs';
import { abs } from './components.mjs';

// The header logo reuses the hanger path from the favicon, so the two can't drift.
const LOGO_PATH = readFileSync(new URL('../assets/icons/icon.svg', import.meta.url), 'utf8').match(/<path d="([^"]+)"/)[1];
const LOGO = `<svg class="logo-mark" viewBox="0 0 32 32" width="28" height="28" aria-hidden="true" focusable="false"><rect width="32" height="32" rx="8" class="logo-bg"/><path class="logo-fg" d="${LOGO_PATH}"/></svg>`;

/** Absolute URL for a site path. */

function csp(config) {
  const script = ["'self'"];
  const connect = ["'self'"];
  const form = ["'self'"];
  if (config.analytics.plausibleDomain) {
    const origin = new URL(config.analytics.plausibleSrc).origin;
    script.push(origin);
    connect.push(origin);
  }
  // Browsers apply form-action to redirects after the POST too, and email
  // providers often redirect to a confirmation page on another host, so with
  // a newsletter form any HTTPS destination is allowed (scripts stay locked).
  if (config.newsletter.action) form.push('https:');
  return [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src ${connect.join(' ')}`,
    `form-action ${form.join(' ')}`,
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; ');
}

function header(path, config) {
  const link = (href, label, extra = '') => {
    // "page" only for the page itself; "true" marks the section a sub-page belongs to.
    const current = path === href ? 'page' : href !== '/' && path.startsWith(href) ? 'true' : '';
    return `<a href="${href}"${extra}${current ? ` aria-current="${current}"` : ''}>${label}</a>`;
  };
  return `<header class="site-header">
<div class="wrap header-inner">
<a class="brand" href="/">${LOGO}<span>${esc(config.name)}</span></a>
<nav aria-label="Main">${link('/', 'Calculator', ' class="nav-home"')}${link('/fees/', 'Fees')}${link('/tracker/', 'Tracker')}</nav>
</div>
</header>`;
}

function footer(config) {
  const platformLinks = PLATFORMS.map((p) => `<li><a href="/fees/${p.id}/">${esc(p.name)} fees</a></li>`).join('');
  const contact = config.contactEmail
    ? `<li><a href="mailto:${esc(config.contactEmail)}">Contact</a></li>`
    : '';
  return `<footer class="site-footer">
<div class="wrap footer-grid">
<div class="footer-brand">
<a class="brand" href="/">${LOGO}<span>${esc(config.name)}</span></a>
<p>${esc(config.tagline)} Free tools for resellers who want to know their numbers.</p>
</div>
<nav aria-label="Fee guides"><h2>Fee guides</h2><ul>${platformLinks}</ul></nav>
<nav aria-label="Site"><h2>${esc(config.name)}</h2><ul>
<li><a href="/">Profit calculator</a></li>
<li><a href="/fees/">All marketplace fees</a></li>
<li><a href="/tracker/">${esc(config.tracker.name)}</a></li>
<li><a href="/privacy/">Privacy</a></li>
<li><a href="/terms/">Terms &amp; disclosures</a></li>${contact}
</ul></nav>
</div>
<div class="wrap footer-legal">
<p>Some links are affiliate links. If you sign up through them we may earn a commission, at no extra cost to you. Fee figures are estimates. Always confirm with the marketplace.</p>
<p>${esc(config.name)} is independent and not affiliated with any marketplace named on this site. All trademarks belong to their owners. &copy; ${new Date().getUTCFullYear()} ${esc(config.name)}.</p>
</div>
</footer>`;
}

/**
 * Wrap page content in the full HTML document.
 * page: { path, title, description, body, jsonld?, ogType?, noindex?, app? }
 * assets: { v, css, app, modules[] } versioned URLs from the builder.
 */
export function layout(page, config, assets) {
  const url = abs(config, page.path);
  const title = page.title;
  const jsonld = (page.jsonld ?? [])
    .map((obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`)
    .join('\n');
  const analytics = config.analytics.plausibleDomain
    ? `<script defer src="${assets.analytics}"></script>\n<script defer data-domain="${esc(config.analytics.plausibleDomain)}" src="${esc(config.analytics.plausibleSrc)}"></script>`
    : '';
  const app = page.app
    ? `${assets.modules.map((m) => `<link rel="modulepreload" href="${m}">`).join('\n')}\n<script type="module" src="${assets.app}"></script>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp(config)}">
<title>${esc(title)}</title>
<meta name="description" content="${esc(page.description)}">
${page.noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${esc(url)}">`}
<meta name="theme-color" content="#0b6b58" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f1513" media="(prefers-color-scheme: dark)">
<meta property="og:type" content="${page.ogType ?? 'website'}">
<meta property="og:site_name" content="${esc(config.name)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(page.description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(abs(config, '/assets/og.png'))}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(config.name)} reseller profit calculator">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/assets/icons/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/icons/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="stylesheet" href="${assets.css}">
<script defer src="${assets.offline}"></script>
${app}
${analytics}
${jsonld}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${header(page.path, config)}
<main id="main">
${page.body}
</main>
${footer(config)}
</body>
</html>
`;
}
