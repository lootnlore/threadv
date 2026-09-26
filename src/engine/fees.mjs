/**
 * Marketplace fee schedules for US sellers.
 *
 * This file is the single source of truth for every number the site shows:
 * the calculator, the fee guide pages, and the worked examples are all
 * computed from it. When a marketplace changes its fees, update the platform
 * below, bump FEES_VERIFIED, and run `npm test`.
 *
 * All money is in integer cents. Rates are fractions (0.136 = 13.6%).
 * Every platform exposes:
 *   fees(order)         -> [{ label, cents }]      line items charged by the platform
 *   breakpoints(order)  -> [cents]                 sale prices where a fee jumps (only if any)
 *   sellerPaysShipping  -> whether the shipping inputs apply on this platform
 *   options             -> its own Fine-tune settings (keys of the calculator input's opts)
 *   feesIncludeTax      -> whether any fee is charged on the buyer's sales tax
 *   company             -> the owner, where it differs from the name (legal notices)
 *   rows                -> [fee, rate, charged on] for the fee table and FAQ. "Charged on" is
 *                          '-' (nothing to add), "Per <unit>" (a per-unit charge, never
 *                          repeating a "per" in the fee or rate), or what the rate applies to.
 *
 * `order` = { price, ship, tax, opts } where price/ship/tax are cents and
 * opts holds the per-platform settings produced by normalizeInputs().
 */

export const FEES_VERIFIED = '2026-09-25';

export const MAX_CENTS = 10_000_000; // $100,000 ceiling for any money input or price search

/**
 * Every rate the fee rules below use, in plain units: fractions for
 * percentages (0.136 = 13.6%) and dollars for money. The calculator and the
 * paid spreadsheet (product/build_tracker.py reads this through Node) share
 * these numbers, so a marketplace fee change is made here, once.
 */
export const RATES = {
  ebay: {
    fvf: 0.136, // most categories, up to fvfCap
    fvfCap: 7500,
    fvfOver: 0.0235,
    handbagsFvf: 0.15, // women's bags & handbags, up to handbagsCap
    handbagsCap: 2000,
    handbagsOver: 0.09,
    mediaFvf: 0.153, // books, movies & music, up to fvfCap
    orderFee: 0.4,
    orderFeeSmall: 0.3,
    smallOrderMax: 10,
  },
  poshmark: { rate: 0.2, flat: 2.95, threshold: 15 },
  mercari: { rate: 0.1 },
  depop: { proc: 0.033, procFixed: 0.45, boost: 0.12 },
  etsy: { listing: 0.2, txn: 0.065, proc: 0.03, procFixed: 0.25, offsite: 0.15, offsiteReduced: 0.12, offsiteReducedFrom: 10000, offsiteCap: 100 },
  whatnot: { commission: 0.08, proc: 0.029, procFixed: 0.3 },
  facebook: { rate: 0.1, min: 0.8 },
  grailed: { threshold: 120, lowRate: 0.06, min: 1.99, rate: 0.09, proc: 0.0349, procFixed: 0.49 },
  tiktok: { referral: 0.08 },
};
const R = RATES;
/** Dollars from RATES -> integer cents. */
const c = (dollars) => Math.round(dollars * 100);
/** 0.136 -> 13.6: a RATES fraction as a percent number, without float noise. */
export const percentOf = (fraction) => Math.round(fraction * 10_000) / 100;
/** 0.136 -> "13.6%", 2000 -> "$2,000", 0.45 -> "$0.45": for prose built from RATES. */
export const pctText = (fraction) => `${percentOf(fraction)}%`;
export const usdText = (dollars) => `$${dollars.toLocaleString('en-US', { minimumFractionDigits: dollars % 1 ? 2 : 0 })}`;
/** ['eBay', 'Etsy', 'Depop'] -> "eBay, Etsy and Depop" (house style: no serial comma). */
const joinList = (conj) => (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} ${conj} ${items.at(-1)}` : (items[0] ?? ''));
export const andList = joinList('and');
export const orList = joinList('or');
const tierText = (rate, cap, over) => `${pctText(rate)} up to ${usdText(cap)}, ${pctText(over)} above`;

/**
 * Round a cent amount half-up the way a person (or Excel) would on paper.
 * Binary floats turn 4500 * 0.075 into 337.49999999999994; trimming to 6
 * decimals first recovers the exact decimal product (rates here have at
 * most 4 decimals), so exact half cents always round up.
 */
export const roundCents = (x) => Math.round(Number(x.toFixed(6)));

const pct = (cents, rate) => roundCents(cents * rate);

/** Apply marginal tiers: [[capCents, rate], ...] with the last cap = Infinity. */
export function tiered(cents, tiers) {
  let fee = 0;
  let floor = 0;
  for (const [cap, rate] of tiers) {
    if (cents <= floor) break;
    fee += (Math.min(cents, cap) - floor) * rate;
    floor = cap;
  }
  return roundCents(fee);
}

/**
 * Smallest sale price (cents) in [lo, hi] for which `pred(price)` is true,
 * assuming pred is monotone there (false ... false true ... true). Returns
 * null if pred is false even at hi.
 */
export function firstPriceWhere(pred, hi = MAX_CENTS, lo = 0) {
  if (!pred(hi)) return null;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (pred(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export const EBAY_CATEGORIES = {
  most: {
    label: 'Most (incl. clothing)',
    name: 'most categories',
    tiers: [[c(R.ebay.fvfCap), R.ebay.fvf], [Infinity, R.ebay.fvfOver]],
    summary: tierText(R.ebay.fvf, R.ebay.fvfCap, R.ebay.fvfOver),
  },
  handbags: {
    label: "Women's bags & handbags",
    name: "women's bags & handbags",
    tiers: [[c(R.ebay.handbagsCap), R.ebay.handbagsFvf], [Infinity, R.ebay.handbagsOver]],
    summary: tierText(R.ebay.handbagsFvf, R.ebay.handbagsCap, R.ebay.handbagsOver),
  },
  media: {
    label: 'Books, movies & music',
    name: 'books, movies & music',
    tiers: [[c(R.ebay.fvfCap), R.ebay.mediaFvf], [Infinity, R.ebay.fvfOver]],
    summary: tierText(R.ebay.mediaFvf, R.ebay.fvfCap, R.ebay.fvfOver),
  },
  custom: {
    label: 'Other category (enter rate)',
    tiers: null,
    summary: 'Your category rate',
  },
};

// Labels stay short enough for a phone-width dropdown ("$10k+/yr").
const offsiteAds = (rate, who) => ({ label: who ? `Offsite Ads ${pctText(rate)} (${who})` : `Offsite Ads sale (${pctText(rate)})`, rate });
export const ETSY_OFFSITE = {
  none: { label: 'No Offsite Ads sale', rate: 0 },
  standard: offsiteAds(R.etsy.offsite),
  reduced: offsiteAds(R.etsy.offsiteReduced, `$${R.etsy.offsiteReducedFrom / 1000}k+/yr`),
};

const ebayTotal = (o) => o.price + o.ship + o.tax;

export const PLATFORMS = [
  {
    id: 'ebay',
    options: ['ebayCategory', 'ebayCustomRate', 'ebayAdRate'], // its Fine-tune settings
    feesIncludeTax: true,
    name: 'eBay',
    sellerPaysShipping: true,
    headline: `${pctText(R.ebay.fvf)} of the order total + ${usdText(R.ebay.orderFee)} per order`,
    fees(o) {
      const total = ebayTotal(o);
      const cat = EBAY_CATEGORIES[o.opts.ebayCategory] ?? EBAY_CATEGORIES.most;
      const fvf = cat.tiers ? tiered(total, cat.tiers) : pct(total, o.opts.ebayCustomRate);
      const items = [
        { label: 'Final value fee', cents: fvf },
        { label: 'Per-order fee', cents: total <= c(R.ebay.smallOrderMax) ? c(R.ebay.orderFeeSmall) : c(R.ebay.orderFee) },
      ];
      if (o.opts.ebayAdRate > 0) {
        items.push({ label: 'Promoted Listings ad fee', cents: pct(total, o.opts.ebayAdRate) });
      }
      return items;
    },
    breakpoints(o) {
      // The per-order fee steps from $0.30 to $0.40 once the order total passes $10.
      const p = firstPriceWhere((price) => ebayTotal({ ...o, price, tax: o.taxFor(price) }) > c(R.ebay.smallOrderMax));
      return p === null ? [] : [p];
    },
    rows: [
      // One row per category with built-in rates, tiers included (the calculator applies them).
      ...Object.values(EBAY_CATEGORIES)
        .filter((cat) => cat.tiers)
        .map((cat) => [`Final value fee, ${cat.name}`, cat.summary, 'Item + shipping + sales tax']),
      [
        'Per-order fee',
        `${usdText(R.ebay.orderFeeSmall)} if the order is ${usdText(R.ebay.smallOrderMax)} or less, otherwise ${usdText(R.ebay.orderFee)}`,
        '-',
      ],
      ['Promoted Listings (optional)', 'Your chosen ad rate', 'Item + shipping + sales tax'],
    ],
    notes: [
      'Rates shown are for sellers without an eBay Store subscription. Store subscribers pay lower rates in some categories.',
      'eBay charges its percentage on the whole order, including the sales tax the buyer pays, which is why the calculator asks for a tax rate.',
      'Sneakers, trading cards, jewelry and watches have their own rates. Pick "Other category" and enter your rate.',
    ],
    sources: [
      { label: 'eBay: Selling fees', url: 'https://www.ebay.com/help/selling/fees-credits-invoices/selling-fees?id=4822' },
      { label: 'eBay Seller Center: Seller fees', url: 'https://www.ebay.com/sellercenter/selling/start-selling-on-ebay/seller-fees' },
    ],
  },
  {
    id: 'poshmark',
    name: 'Poshmark',
    sellerPaysShipping: false,
    headline: `Flat ${usdText(R.poshmark.flat)} under ${usdText(R.poshmark.threshold)}, ${pctText(R.poshmark.rate)} at ${usdText(R.poshmark.threshold)} and up`,
    fees(o) {
      const r = R.poshmark;
      return [{ label: 'Poshmark commission', cents: o.price < c(r.threshold) ? c(r.flat) : pct(o.price, r.rate) }];
    },
    breakpoints() {
      return [c(R.poshmark.threshold)];
    },
    rows: [
      [`Commission (under ${usdText(R.poshmark.threshold)})`, `${usdText(R.poshmark.flat)} flat`, 'Per sale'],
      [`Commission (${usdText(R.poshmark.threshold)} and up)`, pctText(R.poshmark.rate), 'Sale price'],
      ['Shipping', 'Paid by the buyer (prepaid label)', '-'],
    ],
    notes: [
      'The buyer pays for the prepaid shipping label, so your shipping inputs are ignored for Poshmark.',
      'If you offer discounted shipping, the discount comes out of your earnings.',
    ],
    sources: [
      { label: 'Poshmark: What are the fees for selling?', url: 'https://support.poshmark.com/s/article/297755057?language=en_US' },
      { label: 'Poshmark fee policy', url: 'https://poshmark.com/fee_policy' },
    ],
  },
  {
    id: 'mercari',
    name: 'Mercari',
    sellerPaysShipping: true,
    headline: `${pctText(R.mercari.rate)} of the item + shipping, no processing fee`,
    fees(o) {
      return [{ label: 'Selling fee', cents: pct(o.price + o.ship, R.mercari.rate) }];
    },
    rows: [
      ['Selling fee', pctText(R.mercari.rate), 'Item + buyer-paid shipping'],
      ['Payment processing', 'None for sellers (buyers pay it)', '-'],
      ['Instant Pay (optional)', '$3', 'Per transfer'],
    ],
    notes: [
      'Mercari removed the seller payment processing fee in January 2025. Buyers now pay a separate fee.',
      'Standard direct-deposit payouts are free. Instant Pay costs extra and is not included here.',
    ],
    sources: [{ label: 'Mercari: Fees on Mercari', url: 'https://www.mercari.com/us/help_center/article/169/' }],
  },
  {
    id: 'depop',
    options: ['depopBoost'], // its Fine-tune settings
    feesIncludeTax: true,
    name: 'Depop',
    sellerPaysShipping: true,
    headline: `0% selling fee (US) + ${pctText(R.depop.proc)} + ${usdText(R.depop.procFixed)} processing`,
    fees(o) {
      const r = R.depop;
      const items = [{ label: 'Payment processing', cents: pct(o.price + o.ship + o.tax, r.proc) + c(r.procFixed) }];
      if (o.opts.depopBoost) items.push({ label: 'Boosted listing fee', cents: pct(o.price + o.ship, r.boost) });
      return items;
    },
    rows: [
      ['Selling fee', '0% for US sellers', '-'],
      ['Payment processing', `${pctText(R.depop.proc)} + ${usdText(R.depop.procFixed)}`, 'Item + shipping + sales tax'],
      ['Boosted listing (optional)', pctText(R.depop.boost), 'Item + shipping, only if the boosted listing sells'],
    ],
    notes: [
      'Depop dropped its selling fee for US sellers. The only required fee is payment processing.',
      'Boosting is optional. Turn it on under "Fine-tune fees" if the item sold through a boost.',
    ],
    sources: [{ label: 'Depop: Seller fees and charges', url: 'https://depophelp.zendesk.com/hc/en-gb/articles/360001791127-Seller-fees-and-charges' }],
  },
  {
    id: 'etsy',
    options: ['etsyOffsite'], // its Fine-tune settings
    feesIncludeTax: true,
    name: 'Etsy',
    sellerPaysShipping: true,
    headline: `${usdText(R.etsy.listing)} listing + ${pctText(R.etsy.txn)} transaction + ${pctText(R.etsy.proc)} + ${usdText(R.etsy.procFixed)} processing`,
    fees(o) {
      const r = R.etsy;
      const items = [
        { label: 'Listing fee', cents: c(r.listing) },
        { label: 'Transaction fee', cents: pct(o.price + o.ship, r.txn) },
        { label: 'Payment processing', cents: pct(o.price + o.ship + o.tax, r.proc) + c(r.procFixed) },
      ];
      const offsite = ETSY_OFFSITE[o.opts.etsyOffsite] ?? ETSY_OFFSITE.none;
      if (offsite.rate > 0) {
        items.push({ label: 'Offsite Ads fee', cents: Math.min(pct(o.price + o.ship, offsite.rate), c(r.offsiteCap)) });
      }
      return items;
    },
    rows: [
      ['Listing fee', usdText(R.etsy.listing), 'Per listing (renews when it sells)'],
      ['Transaction fee', pctText(R.etsy.txn), 'Item + shipping'],
      ['Payment processing', `${pctText(R.etsy.proc)} + ${usdText(R.etsy.procFixed)}`, 'Order total incl. sales tax'],
      [
        'Offsite Ads (sometimes)',
        `${pctText(R.etsy.offsite)} (${pctText(R.etsy.offsiteReduced)} for sellers with ${usdText(R.etsy.offsiteReducedFrom)}+ a year), max ${usdText(R.etsy.offsiteCap)}`,
        'Item + shipping',
      ],
    ],
    notes: [
      'Etsy only allows vintage items (20+ years old), handmade goods and craft supplies. Most modern resale does not qualify.',
      'Offsite Ads fees only apply when a sale comes from an Etsy ad on another site.',
    ],
    sources: [{ label: 'Etsy: Fees & Payments Policy', url: 'https://www.etsy.com/legal/fees/' }],
  },
  {
    id: 'whatnot',
    options: ['whatnotRate'], // its Fine-tune settings
    feesIncludeTax: true,
    name: 'Whatnot',
    sellerPaysShipping: true,
    headline: `${pctText(R.whatnot.commission)} commission + ${pctText(R.whatnot.proc)} + ${usdText(R.whatnot.procFixed)} processing`,
    fees(o) {
      return [
        { label: 'Commission', cents: pct(o.price, o.opts.whatnotRate) },
        { label: 'Payment processing', cents: pct(o.price + o.ship + o.tax, R.whatnot.proc) + c(R.whatnot.procFixed) },
      ];
    },
    rows: [
      ['Commission', `${pctText(R.whatnot.commission)} for most categories (lower at high volume)`, 'Sale price only'],
      ['Payment processing', `${pctText(R.whatnot.proc)} + ${usdText(R.whatnot.procFixed)}`, 'Item + shipping + sales tax'],
    ],
    notes: [
      'From September 21, 2026, Whatnot lowers commission for sellers with more than $15,000 in sales per four weeks (down to 4.5% for fashion at the top public tier). Set your rate under "Fine-tune fees".',
      'Electronics (5%) and coins (4%) have lower base commission.',
    ],
    sources: [
      { label: 'Whatnot: Seller fees', url: 'https://help.whatnot.com/hc/en-us/articles/4847069165965-Whatnot-seller-fees' },
      { label: 'Whatnot: Fees & commissions', url: 'https://help.whatnot.com/hc/en-us/sections/44398189207565-Fees-commissions' },
    ],
  },
  {
    id: 'facebook',
    name: 'Facebook Marketplace',
    company: 'Meta',
    short: 'Facebook', // results list: "Marketplace" is too long a word beside a figure on small phones
    sellerPaysShipping: true,
    headline: `${pctText(R.facebook.rate)} per shipped order (min ${usdText(R.facebook.min)}), local pickup free`,
    fees(o) {
      return [{ label: 'Selling fee (shipped)', cents: Math.max(c(R.facebook.min), pct(o.price + o.ship, R.facebook.rate)) }];
    },
    rows: [
      ['Selling fee (shipped orders)', `${pctText(R.facebook.rate)}, minimum ${usdText(R.facebook.min)}`, 'Item + shipping'],
      ['Local pickup', 'Free', '-'],
    ],
    notes: [
      'The fee only applies to shipped orders that use Marketplace checkout. Local cash sales are free.',
      `Payment processing is included in the ${pctText(R.facebook.rate)}.`,
    ],
    sources: [{ label: 'Meta: Get paid for selling with shipping', url: 'https://www.facebook.com/help/449101635835192' }],
  },
  {
    id: 'grailed',
    name: 'Grailed',
    sellerPaysShipping: true,
    headline: `${pctText(R.grailed.lowRate)} under ${usdText(R.grailed.threshold)} (min ${usdText(R.grailed.min)}), ${pctText(R.grailed.rate)} at ${usdText(R.grailed.threshold)}+, plus ${pctText(R.grailed.proc)} + ${usdText(R.grailed.procFixed)}`,
    fees(o) {
      const r = R.grailed;
      const commission = o.price < c(r.threshold) ? Math.max(c(r.min), pct(o.price, r.lowRate)) : pct(o.price, r.rate);
      return [
        { label: 'Commission', cents: commission },
        { label: 'Payment processing', cents: pct(o.price + o.ship, r.proc) + c(r.procFixed) },
      ];
    },
    breakpoints() {
      return [c(R.grailed.threshold)];
    },
    rows: [
      [`Commission (under ${usdText(R.grailed.threshold)})`, `${pctText(R.grailed.lowRate)}, minimum ${usdText(R.grailed.min)}`, 'Sale price'],
      [`Commission (${usdText(R.grailed.threshold)} and up)`, pctText(R.grailed.rate), 'Sale price'],
      ['Payment processing (US)', `${pctText(R.grailed.proc)} + ${usdText(R.grailed.procFixed)}`, 'Item + shipping'],
    ],
    notes: [
      'Grailed cut commission to 6% on sales under $120 on May 20, 2026.',
      'Assumes you ship with a Grailed label. If you buy your own label, Grailed counts shipping as part of the sale price.',
      'International buyers are charged 4.99% + $0.49 processing.',
    ],
    sources: [
      { label: 'Grailed: What are the fees?', url: 'https://support.grailed.com/hc/en-us/articles/30282580172045-What-are-the-fees' },
      { label: 'Grailed: Payment processing fee', url: 'https://support.grailed.com/hc/en-us/articles/30299544492301-Does-Grailed-charge-a-payment-processing-fee' },
    ],
  },
  {
    id: 'tiktok',
    options: ['tiktokRate'], // its Fine-tune settings
    name: 'TikTok Shop',
    company: 'TikTok',
    sellerPaysShipping: true,
    headline: `${pctText(R.tiktok.referral)} referral fee in most categories`,
    fees(o) {
      // Charged on what the customer pays (item + shipping) before tax.
      return [{ label: 'Referral fee', cents: pct(o.price + o.ship, o.opts.tiktokRate) }];
    },
    rows: [
      ['Referral fee', `${pctText(R.tiktok.referral)} in most categories (since Aug 4, 2026)`, 'Item + buyer-paid shipping, before tax'],
      ['Creator affiliate commission (optional)', 'Rate you set, often 10-20%', 'Item price'],
    ],
    notes: [
      'TikTok Shop raised its standard US referral fee from 6% to 8% on August 4, 2026. Some beauty and electronics categories are higher, so check your category in Seller Center.',
      'If a creator sells your item, their affiliate commission comes on top. For a close estimate, add it to the referral rate under "Fine-tune fees".',
    ],
    sources: [{ label: 'TikTok Shop: Referral fees by category', url: 'https://seller-us.tiktok.com/university/essay?knowledge_id=5988482086864682' }],
  },
];

export const PLATFORM_BY_ID = Object.fromEntries(PLATFORMS.map((p) => [p.id, p]));
