# ThreadVet

**Free reseller profit calculator + marketplace fee guide, built to earn money over time.**

ThreadVet answers the three questions every reseller asks in the thrift-store aisle:

- **Profit:** what will I actually keep on eBay, Poshmark, Mercari, Depop, Etsy, Whatnot, Facebook Marketplace, Grailed and TikTok Shop?
- **Max buy:** what is the most I can pay for this and still make my minimum?
- **List price:** what do I list it at on each platform to clear my target?

It works offline once visited (installable to a phone's home screen), loads in well under a second, and ships as a plain static site you can host on your Spaceship VPS.

## Why this niche

- US secondhand apparel grew 19% in 2025, its fastest growth since 2021, and tariffs are pushing even more shoppers to resale ([ThredUp 2026 Resale Report](https://www.thredup.com/resale)).
- Marketplace fees keep changing: Grailed (May 2026), TikTok Shop (Aug 2026) and Whatnot (Sep 2026) all changed their fees this year. Sellers search for current numbers every time, which is steady search traffic for a site that keeps them accurate.
- Crosslisting tools pay **20% recurring** commission on referrals ([Nifty](https://docs.nifty.ai/subscriptions/referrals-and-discounts), [Vendoo](https://www.vendoo.co/referral-program), [List Perfectly](https://listperfectly.com/referral-program/)). Every reseller who compares platforms is a crosslisting prospect.

## How it makes money

| Stream | Where it lives | Your setup step |
| --- | --- | --- |
| Crosslister referrals (about 20% of each subscription, monthly) | "Stop retyping every listing" section on the home and fee pages | Join the three referral programs and paste your links into `site.config.mjs` |
| **ThreadVet Reseller Tracker** spreadsheet, $19 one-time | `/tracker/` sales page | Upload the file to Gumroad, Lemon Squeezy or Payhip and paste the product link |
| Fee-change alert email list | Signup form on home, fee and tracker pages | Paste a newsletter form endpoint (Buttondown, MailerLite, Kit) |
| Display ads (later) | Add once organic traffic is steady | Nothing yet |

Be realistic: a new site usually takes 3 to 6 months to rank in Google. The fee pages are built for that (one page per marketplace, updated data, FAQ and breadcrumb structured data). The fastest early traffic comes from sharing the calculator where resellers already hang out: r/Flipping, r/poshmark, r/Depop, reseller Facebook groups, and short "is this worth flipping?" videos on TikTok.

## Launch checklist

1. **Point your domain at the VPS.** In Spaceship's DNS settings for your domain, add an `A` record for `@` and one for `www`, both set to your VPS IP address.
2. **Set up the server once:** see [Deploy to your Spaceship VPS](#deploy-to-your-spaceship-vps).
3. **Fill in `site.config.mjs`** (or the matching environment variables): your domain, contact email, referral links, tracker checkout link and newsletter endpoint. `npm run build` prints anything still missing.
4. **Deploy:** `SSH_KEY=~/.ssh/threadvet_deploy VPS_HOST=<your VPS IP> ./deploy/deploy.sh`.
5. **Register with Google Search Console** and submit `https://<your domain>/sitemap.xml`.
6. **Share it** in the reseller communities above.

## Run it locally

Needs Node 22 or newer. There are no dependencies to install.

```bash
npm test         # engine + build tests
npm run serve    # build, then preview at http://localhost:8080
npm run build    # write the deployable site to dist/

# Browser tests (sharing, saved settings, validation, offline). Needs Chromium:
npm i --no-save playwright-core && npm run test:e2e
```

## Configuration

Everything is in [`site.config.mjs`](site.config.mjs). Values can also come from environment variables, which is how the automatic deploy passes them:

| Setting | Env var | What it does |
| --- | --- | --- |
| `name` | `SITE_NAME` | The brand shown across the site, app manifest and spreadsheet (the tracker is named after it). After changing it, run `node scripts/gen-images.mjs` so the social card matches (`npm test` reminds you). If you use the env var, also add it as a repository variable for CI |
| `url` | `SITE_URL` | Your live domain, e.g. `https://threadvet.com`. Used in canonical URLs, sitemap and social cards |
| `contactEmail` | `CONTACT_EMAIL` | Shown in the footer and legal pages |
| `crosslisters[].url` | (edit the file) | Your referral links |
| `tracker.name`, `tracker.price` | (edit the file) | Product name (site and spreadsheet) and price in dollars, e.g. `19` or `24.50` |
| `tracker.checkoutUrl` | `TRACKER_CHECKOUT_URL` | Store product link (https). Until set, the buy button says "Coming soon" |
| `newsletter.action` | `NEWSLETTER_ACTION` | Form endpoint, e.g. `https://buttondown.com/api/emails/embed-subscribe/<you>`. Hidden until set |
| `newsletter.launchTag` | (edit the file) | Hidden field that marks tracker-page signups, so the launch note goes to them only. Defaults to Buttondown's `tag` field |
| `analytics.plausibleDomain` | `PLAUSIBLE_DOMAIN` | Optional cookie-free analytics |

The Content Security Policy is generated from this config, so analytics and newsletter domains are allowed automatically.

## Deploy to your Spaceship VPS

These steps assume an Ubuntu or Debian VPS. If your VPS runs a control panel (cPanel, CyberPanel, Plesk) or Apache, skip the setup script and upload the contents of `dist/` to that site's document root instead.

**1. Create a deploy key on your computer** (the server's deploy user only accepts keys):

```bash
ssh-keygen -t ed25519 -f ~/.ssh/threadvet_deploy -N ""
cp ~/.ssh/threadvet_deploy.pub deploy/deploy_key.pub     # picked up by the setup script; git-ignored
```

**2. One-time server setup** (installs nginx, HTTPS via Let's Encrypt, the `deploy` user and your key):

```bash
ssh root@<VPS IP> 'rm -rf /root/threadvet-deploy'        # fresh copy each time you re-run setup
scp -r deploy root@<VPS IP>:/root/threadvet-deploy
ssh root@<VPS IP> 'DOMAIN=threadvet.com EMAIL=you@example.com bash /root/threadvet-deploy/setup-vps.sh'
```

The HTTPS certificate covers both `threadvet.com` and `www.threadvet.com`, so both DNS records from step 1 must exist. On a subdomain without a `www` record (for example `calc.example.com`), add `WWW=0`.

**3. Deploy** (runs the tests, builds, uploads to a new release folder, then switches over with no downtime; the last 5 releases are kept for rollback):

```bash
SSH_KEY=~/.ssh/threadvet_deploy VPS_HOST=<VPS IP> ./deploy/deploy.sh
```

**Roll back** to the previous release (or pick one) instantly:

```bash
SSH_KEY=~/.ssh/threadvet_deploy VPS_HOST=<VPS IP> ./deploy/rollback.sh          # previous release
SSH_KEY=~/.ssh/threadvet_deploy VPS_HOST=<VPS IP> ./deploy/rollback.sh --list   # see all kept releases
```

**Automatic deploys (optional).** In GitHub, go to Settings, then Secrets and variables, then Actions:

- Secrets: `VPS_SSH_KEY` (contents of `~/.ssh/threadvet_deploy`) and `VPS_KNOWN_HOSTS` (output of `ssh-keyscan -p <SSH port> <VPS_HOST>`, using exactly the same host you put in `VPS_HOST`; CI refuses any other host key)
- Variables: `VPS_HOST` and `SITE_URL`; `SITE_NAME` if you renamed the site that way; `VPS_PORT` and `VPS_USER` if they differ from 22 and `deploy`; any of `CONTACT_EMAIL`, `TRACKER_CHECKOUT_URL`, `NEWSLETTER_ACTION`, `PLAUSIBLE_DOMAIN`; and finally `DEPLOY_ENABLED` = `true`

After that, every push to `main` is tested and deployed automatically.

## The Reseller Tracker (paid product)

`product/build_tracker.py` generates the spreadsheet customers buy: an inventory and sales log with automatic fees, profit, ROI and days to sell; a dashboard (monthly profit and chart, results by marketplace and by source, tax-time summary); expense and mileage logs with the current IRS rates; and an editable fee table. It works in Excel 2016+ and Google Sheets.

```bash
pip install openpyxl
python3 product/build_tracker.py     # -> product/dist/ThreadVet-Reseller-Tracker.xlsx
python3 product/verify_tracker.py    # proves every fee formula matches the website engine (needs LibreOffice)
```

**This repository is public**, so the generated `.xlsx` is git-ignored and must never be committed. Consider making the repository private (GitHub, then Settings, then Change visibility).

## Keeping fees current

All fee numbers come from one file, [`src/engine/fees.mjs`](src/engine/fees.mjs), with a source link for every platform. When a marketplace changes its fees:

1. Update the numbers in `RATES` (and the platform's descriptions) in `src/engine/fees.mjs`, and bump `FEES_VERIFIED`.
2. Add the change to `FEE_CHANGES` in `src/pages/components.mjs` (it appears on the site's fee timeline).
3. Run `npm test`. If it reports that the social card is out of date (the new rates changed its example profits), run `node scripts/gen-images.mjs` (needs `npm i --no-save playwright-core`) and commit the new images.
4. Deploy. Rebuild the spreadsheet with `python3 product/verify_tracker.py`: it reads the same `RATES`, marketplace list and default tax rate, checks every formula against the website, and writes a fresh file to upload to your store.
5. Sending a short email to your fee-alert list is good for traffic.

When the IRS announces a new mileage rate, add it to [`src/data/mileage.mjs`](src/data/mileage.mjs), then rebuild the site and the spreadsheet: both quote that list.

## Project structure

```
site.config.mjs          your settings (domain, links, checkout, newsletter)
src/engine/fees.mjs      marketplace fee schedules: the single source of truth
src/engine/calc.mjs      profit, max-buy and list-price math (integer cents)
src/engine/render.mjs    result HTML shared by the build and the browser
src/data/mileage.mjs     IRS mileage rates (tracker page and spreadsheet)
src/pages/*.mjs          page templates (home, fee hub, 9 fee pages, tracker, legal, 404)
src/assets/              stylesheet, calculator script, service worker, icons
scripts/build.mjs        static site generator (no dependencies)
scripts/serve.mjs        local preview server
scripts/gen-images.mjs   app icons, favicon and social card (og.png) from icon.svg and the engine
test/                    engine and build-output tests; test/e2e/ browser tests
deploy/                  nginx config, VPS setup, zero-downtime deploy and rollback scripts
product/                 the paid spreadsheet generator and its verification
```

## Quality bar

- `npm test` checks every fee formula against hand-computed values, proves the list-price search finds the exact lowest price (brute force across random settings and every fee cliff), and checks the built site for broken links, metadata, structured data, asset hashing and template leaks.
- `npm run test:e2e` drives a real browser through sharing links, saved settings, input validation, keyboard use, no-JavaScript rendering and offline mode. CI runs it on every push.
- `python3 product/verify_tracker.py` proves the spreadsheet's fees, payout and profit match the website engine to the cent on 420 sales across all marketplaces.
- Lighthouse scores 100 for performance, accessibility, best practices and SEO on mobile and desktop; axe reports no accessibility violations in light or dark mode; every page passes html-validate (`npx html-validate@11 "dist/**/*.html"`, rules in `.htmlvalidate.json`; CI runs it).
- The deploy files were tested against real nginx and SSH: caching, redirects, security headers, 404s, release switching, pruning and rollback safety.
- No cookies and no trackers by default, a strict Content Security Policy, and real results even before JavaScript loads (they are pre-rendered).
