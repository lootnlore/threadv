/**
 * Everything you need to change to make the site yours lives here.
 * After editing, run `npm run build` and deploy the `dist/` folder.
 *
 * Money checklist (see README.md for step-by-step setup):
 *   1. crosslisters[].url  -> your personal referral/affiliate links
 *   2. tracker.checkoutUrl -> your Gumroad / Lemon Squeezy / Payhip product link
 *   3. newsletter.action   -> your email provider's form endpoint
 */
import { PLATFORMS, andList } from './src/engine/fees.mjs';

// The brand. Set it here, or with SITE_NAME (CI passes the repository
// variable of that name to every job, so tests and deploys agree).
const name = process.env.SITE_NAME || 'ThreadVet';

export default {
  name,
  // Your live domain, no trailing slash. Used for canonical URLs, the sitemap and social cards.
  url: process.env.SITE_URL || 'https://threadvet.com',
  tagline: 'Vet every flip before you buy.',
  description: `Free reseller profit calculator. Compare real fees and profit on ${andList(PLATFORMS.map((p) => p.name))}.`,
  // Public contact address shown in the footer and legal pages. Leave empty to hide.
  contactEmail: process.env.CONTACT_EMAIL || '',

  // Crosslisting tools shown under the calculator. Swap `url` for your referral link:
  // each of these programs pays about 20% recurring commission on referred subscriptions.
  crosslisters: [
    {
      id: 'nifty',
      name: 'Nifty',
      url: 'https://nifty.ai/',
      blurb: 'AI crosslisting to Poshmark, eBay, Mercari, Depop and Etsy, plus sharing and offer automation.',
      perk: '7-day free trial',
    },
    {
      id: 'vendoo',
      name: 'Vendoo',
      url: 'https://www.vendoo.co/',
      blurb: 'Crosslisting with inventory management and sales analytics in one dashboard.',
      perk: '14-day free trial',
    },
    {
      id: 'listperfectly',
      name: 'List Perfectly',
      url: 'https://listperfectly.com/',
      blurb: 'Established crosslister with bulk editing and delisting across marketplaces.',
      perk: 'Discount on your first month',
    },
  ],

  // The paid spreadsheet. Upload ThreadVet-Reseller-Tracker.xlsx to a store that delivers
  // files automatically (Gumroad, Lemon Squeezy or Payhip), then paste the product link here.
  // Until then the buy button shows "Coming soon".
  tracker: {
    name: `${name} Reseller Tracker`,
    price: 19,
    checkoutUrl: process.env.TRACKER_CHECKOUT_URL || '',
  },

  // Fee-change alert signups. Any provider with a plain HTML form endpoint works
  // (Buttondown, MailerLite, Kit/ConvertKit, EmailOctopus). Leave empty to hide the form.
  newsletter: {
    action: process.env.NEWSLETTER_ACTION || '',
    emailField: 'email',
    // Signups on the tracker page (before it launches) carry this hidden field
    // so you can send the launch note to them only, as the privacy policy says.
    // Buttondown reads `tag`; for another provider use its tag/group field name.
    launchTag: { field: 'tag', value: 'tracker-launch' },
  },

  // Optional privacy-friendly analytics (no cookie banner needed). Set the domain to enable.
  analytics: {
    plausibleDomain: process.env.PLAUSIBLE_DOMAIN || '',
    // Manual-mode script: ThreadVet reports page views itself, without the #fragment.
    plausibleSrc: 'https://plausible.io/js/script.manual.js',
  },
};
