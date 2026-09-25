/**
 * IRS standard mileage rates for business use, in dollars per mile, oldest
 * first. The tracker page and the tracker spreadsheet (product/build_tracker.py)
 * both read this list: when the IRS announces a new rate, add it at the end,
 * update the tracker page date, and rebuild both.
 */
export const IRS_MILEAGE_SOURCE = 'https://www.irs.gov/tax-professionals/standard-mileage-rates';

export const IRS_MILEAGE_RATES = [
  { from: '2025-01-01', rate: 0.7, label: 'IRS business rate, 2025' },
  { from: '2026-01-01', rate: 0.725, label: 'IRS business rate, Jan 1 - Jun 30, 2026' },
  { from: '2026-07-01', rate: 0.76, label: 'IRS business rate, Jul 1 - Dec 31, 2026' },
];

/** The year of the newest rate, e.g. '2026' ("with 2026 IRS rates"). */
export const MILEAGE_YEAR = IRS_MILEAGE_RATES.at(-1).from.slice(0, 4);
