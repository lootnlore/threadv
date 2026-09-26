/**
 * HTML renderers for calculator results. Shared by the static builder (so
 * pages ship with real numbers before any JS runs) and the browser app (so
 * re-renders match the server output exactly). Output only contains numbers
 * and strings from fees.mjs, and everything passes through esc().
 */
import { MAX_CENTS, usdText, andList, orList } from './fees.mjs';

/** Calculator modes: tab label, helper text, fields hidden, and minimum-profit hint. */
export const MODES = {
  profit: {
    label: 'Profit',
    hint: 'Enter a price and what you paid to see what you would keep on each marketplace.',
    hidden: [],
    targetHint: 'Worth-it threshold',
  },
  maxbuy: {
    label: 'Max buy',
    hint: 'Enter what it sells for. You will see the most you can pay and still hit your minimum profit.',
    hidden: ['cost'],
    targetHint: 'Profit you want to keep',
  },
  price: {
    label: 'List price',
    hint: 'Enter what you paid. You will see the lowest list price on each marketplace that hits your minimum profit.',
    hidden: ['price'],
    targetHint: 'Profit you want to keep',
  },
};

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ESC[c]);

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** 1234 -> "$12.34", -320 -> "−$3.20" (true minus sign for readability). */
export function money(cents) {
  const s = usd.format(Math.abs(cents) / 100);
  return cents < 0 ? `−${s}` : s;
}

/** 0.6427 -> "64%", null -> "—". Large ROIs are grouped: 12,400%. */
export function percent(ratio) {
  if (ratio === null || !Number.isFinite(ratio)) return '—';
  const n = Math.round(ratio * 100);
  return `${n < 0 ? '−' : ''}${whole.format(Math.abs(n))}%`;
}

const tone = (cents) => (cents > 0 ? 'pos' : cents < 0 ? 'neg' : 'zero');

function breakdown(mode, r) {
  const line = (label, cents, cls = '') =>
    `<div class="bd-row${cls ? ` ${cls}` : ''}"><dt>${esc(label)}</dt><dd>${money(cents)}</dd></div>`;
  const rows = [line('Sale price', r.price)];
  if (r.ship) rows.push(line('+ Shipping charged', r.ship));
  for (const f of r.fees) rows.push(line(`\u2212 ${f.label}`, -f.cents, 'fee'));
  rows.push(line('= Payout', r.payout, 'subtotal'));
  if (r.shipping) rows.push(line('\u2212 Shipping label', -r.shipping));
  if (mode !== 'maxbuy' && r.cost) rows.push(line('\u2212 Item cost', -r.cost));
  if (r.other) rows.push(line('\u2212 Other costs', -r.other));
  if (mode === 'maxbuy') {
    rows.push(line('= Profit before item cost', r.profit, 'subtotal'));
    rows.push(line('\u2212 Your minimum profit', -r.minimum));
    rows.push(line('= Max buy price', r.maxCost, 'total'));
  } else {
    rows.push(line('= Profit', r.profit, 'total'));
  }
  const taxNote = r.taxInFees ? `<p class="bd-note">Includes fees on the buyer's ${money(r.tax)} sales tax, which ${esc(r.name)} charges on.</p>` : '';
  return `<dl>${rows.join('')}</dl>${taxNote}`;
}

/** 1 -> "1st", 2 -> "2nd", 11 -> "11th", 22 -> "22nd". */
export function ordinal(n) {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${(!teen && { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10]) || 'th'}`;
}

/** A rank in words: "4th", or "Tied 4th" when another result shares it. */
const rankWords = (rank, tied) => `${tied ? 'Tied ' : ''}${ordinal(rank)}`;

function figureFor(mode, r) {
  if (mode === 'maxbuy') {
    return r.maxCost >= 0
      ? `<span class="figure pos">${money(r.maxCost)}</span>`
      : `<span class="figure neg msg">Can’t hit target</span>`;
  }
  if (mode === 'price') {
    return r.unreachable ? '<span class="figure zero msg">Out of range</span>' : `<span class="figure">${money(r.price)}</span>`;
  }
  return `<span class="figure ${tone(r.profit)}">${money(r.profit)}</span>`;
}

function subFor(mode, r) {
  const segs = (...parts) => parts.map((t) => `<span class="seg">${t}</span>`).join(' \u00b7 ');
  if (mode === 'price') {
    return r.unreachable
      ? `No list price under ${usdText(MAX_CENTS / 100)} reaches this profit.`
      : segs(`Fees ${money(r.feeTotal)}`, `Payout ${money(r.payout)}`, `Profit ${money(r.profit)}`);
  }
  const fees = `Fees ${money(r.feeTotal)} (${percent(r.feeRate)})`;
  if (mode === 'maxbuy') return segs(fees, `Payout ${money(r.payout)}`);
  return segs(fees, `Payout ${money(r.payout)}`, `ROI ${percent(r.roi)}`);
}

/**
 * The ranked <li> rows, from rankedRows() (the same rows renderVerdict gets,
 * so the list and the verdict share one ranking). Each row is a <details>
 * whose summary is the headline, so tapping anywhere on a result opens its
 * fee breakdown. `focus` pins and highlights one platform (fee pages).
 */
export function renderResults(mode, ranked, { focus } = {}) {
  const rows = [...ranked];
  // On a platform's own fee page, pin it first but keep its true rank.
  const pinned = rows.findIndex(({ r }) => r.id === focus);
  if (pinned > 0) rows.unshift(...rows.splice(pinned, 1));
  return rows
    .map(({ r, rank, tied, best }) => {
      const cls = ['result', best && 'is-best', r.id === focus && 'is-focus'].filter(Boolean).join(' ');
      // The rank is the badge's number (tied results share it), read aloud
      // before the name. When very large text hides the badges, a tag after
      // the name says it instead ("Tied 4th"), like the Best tag.
      const badge = rank === null ? '<span class="rank" aria-hidden="true">\u2013</span>' : `<span class="rank">${rank}</span>`;
      // A fee page's own marketplace says why it comes first, out of rank order.
      const tag = [
        best ? '<span class="tag tag-best">Best</span>' : rank !== null ? `<span class="tag tag-rank">${rankWords(rank, tied)}</span>` : '',
        r.id === focus ? '<span class="tag tag-page">This page</span>' : '',
      ]
        .filter(Boolean)
        .join(' ');
      // Spaces between the parts (not drawn in the grid) keep plain text apart: "4 Mercari $21.00".
      const head = `<span class="result-main">${badge} <span class="pname">${esc(r.short)}${tag && ` ${tag}`}</span> ${figureFor(mode, r)}</span>
<span class="result-sub">${subFor(mode, r)}<wbr></span>`; // <wbr>: the disclosure chevron may wrap too
      const body = r.unreachable
        ? `<div class="result-head">${head}</div>`
        : `<details><summary>${head}</summary><div class="breakdown">${breakdown(mode, r)}</div></details>`;
      return `<li class="${cls}" data-id="${esc(r.id)}">${body}</li>`;
    })
    .join('');
}

/**
 * One-line decision at the top of the results, from rankedRows(). Returns
 * { tone, html }. `input` is the normalized input (cents).
 */
export function renderVerdict(mode, ranked, input) {
  const out = (tone, html) => ({ tone, html: `<span>${html}</span>` });
  const target = money(input.target);
  // The top results, as the list ranks them: every platform tied for first is named.
  const winners = ranked.filter((row) => row.rank === 1);
  if (!winners.length) {
    return out('bad', `<strong>Out of range.</strong> No platform reaches ${target} profit with these costs.`);
  }
  const top = winners[0].r;
  const names = winners.map((row) => esc(row.r.name));
  const good = winners[0].best; // the Best badge's own test
  if (mode === 'maxbuy') {
    return good
      ? out('good', `<strong>Pay up to ${money(top.maxCost)}</strong> to make ${target} selling on ${orList(names)} at ${money(input.price)}.`)
      : out('bad', `<strong>Pass.</strong> At a ${money(input.price)} sale you can’t clear ${target} on any platform, even if the item is free.`);
  }
  if (mode === 'price') {
    return out('good', `<strong>List at ${money(top.price)}</strong> on ${orList(names)}, the lowest price that clears ${target} after fees and costs.`);
  }
  if (good) {
    const roi = top.roi === null ? '' : ` (${percent(top.roi)} ROI)`;
    return out('good', `<strong>Worth it.</strong> Best on ${andList(names)}: ${money(top.profit)} profit${roi}.`);
  }
  if (top.profit < input.target) {
    return out('bad', `<strong>Pass.</strong> Best case is ${money(top.profit)} on ${orList(names)}, under your ${target} minimum.`);
  }
  return out('bad', `<strong>No profit.</strong> At best you break even on ${orList(names)}.`);
}
