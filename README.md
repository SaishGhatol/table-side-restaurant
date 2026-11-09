# Table-side restaurant system

Guests scan a QR code at their table and order, call the waiter, play games, split the bill and pay.
Staff get a live floor map and a kitchen display. Zero dependencies — just Node 18+.

```
node server.js          # PORT=3000 STAFF_PIN=1234 by default
```

| Screen | URL | Who |
|---|---|---|
| Customer | `/t/<table>` (e.g. `/t/5`) | guests (via QR) |
| Floor map | `/floor` | waiters — approve guests, help alerts, one-tap "Send to kitchen", cash/bank confirmation |
| Kitchen display | `/kitchen` | cooks — live tickets, timers (amber 8 min, red 15 min), per-station filter |
| QR codes | `/qr` | print one per table |

Staff screens ask for the PIN (`STAFF_PIN`, default `1234` — change it).

## Look and feel
Colours, fonts and spacing are variables at the top of `public/common.css` (warm paper background, ink text, one deep-green accent,
serif headings). Change `--brand` and `--bg` to re-colour every screen. All icons are one small custom line-icon set in `public/icons.js`
(`icon('bell')`, 24px grid, 1.6px stroke); there are no emoji in the interface. The kitchen screen is deliberately dark for reading at a distance.

## Floor plan
`/floor` shows the restaurant as a plan: zones (window side, main hall, patio), kitchen, bar, restrooms, entrance, and every
table drawn as a round / square / long table with its chairs. Table colour = status, a bell rings on tables that need help, and the
quick button under each table ("Approve", "Send to kitchen", "I'm on it") works without opening anything. Tap a table for its orders and bill.
"Grid" switches to a plain card grid (default on phones).

**Match it to your real room:** tap **Edit layout** → drag tables where they really are, tap a table to pick its shape and number of seats.
Changes save instantly to `data/layout.json` and show on every screen. **Reset to default** restores the sample layout.
Zones and fixtures (kitchen, bar, door, restrooms) live in the same file — edit their `x/y/w/h/label` there and reload.

## Flow
0. **Scan and get approved.** Guests scan the table QR. That sends the waiter a request ("Table 5 wants to join", with a sound and an amber
   marker on the floor map). The waiter taps **Approve** once and the guests can order. There is no code to remember or type.
   Until a waiter approves, the QR only shows the menu: no ordering, paying, games, Wi-Fi password or other guests' orders.
   A guest who is already approved can also wave a friend in from their own phone.
1. Guest orders → order is `pending` and the table lights up on the floor map (with a beep).
2. Waiter taps **Send to kitchen** → ticket appears on the kitchen display, split by station.
3. Cooks tap lines / **Done** → when every line is done, the table turns green ("ready to serve").
4. **Call waiter** → table flashes red on the floor map until a waiter taps "I'm on it".
5. Pay: everything / split equally / pick items / custom amount, tip, then card / Apple Pay / Google Pay / bank transfer / cash.
   Cash and bank transfer need a waiter to confirm; the table closes when the bill hits zero. Then a receipt (on WhatsApp if the guest typed their number on the Pay tab), a thank-you with the restaurant's location to share, and a 1–5★ review.

## Games
The guest's **Play** tab has five games:
- **Noughts & crosses**, **Connect four** and **Rock, paper, scissors** (first to two rounds): two players, against anyone approved at this table or another table.
  Start one and it waits in the lobby ("Waiting for a player"); the other guest taps **Join**. Rock-paper-scissors choices stay hidden on the server until both players have chosen.
  Leaving a game in progress counts as a win for the opponent (no reward). A genuine win earns `rewards.gameWin` points (25 by default), up to 3 wins per day per guest.
- **Dish memory** (match pairs of menu photos) and **Food quiz** (5 random questions about Indian food): solo, run on the guest's phone, no points.
Quiz questions are the `QUIZ` list near the top of the Play section in `public/customer.html`; the two-player rules are in `server.js` (search `GAME_TYPES`).

## Menu, photos and your own restaurant
The sample menu is a typical North + South Indian restaurant (89 dishes and 5 combos, ₹ prices, 5% GST, veg/non-veg marks, allergens incl. mustard, half/full sizes, combos).
It is original sample data, not copied from any real restaurant. Everything is in `data/menu.json`: name, tagline, currency (`currency`, `currencyCode`, `locale`),
tax (`taxName`, `taxRate`), table count, Wi-Fi, kitchen stations, rewards, and the items. Restart the server after editing.

**Photos:** each dish uses `public/img/<id>.jpg` (shown automatically; combos reuse their first dish's photo). They are openly licensed
(CC BY / CC BY-SA / CC0) from Wikimedia Commons; author and licence for every photo are in `public/img/credits.json` and listed at `/credits.html`
(linked from the guest's Perks tab) — keep that page if you keep the photos. **For your real restaurant, replace them with your own photos**
(same file names) — don't copy photos from Zomato, Swiggy, Google or other restaurants' sites; they are copyrighted.

## Google reviews
After paying, every guest can leave feedback in the app and, separately, tap **Write a Google review**: it opens your Google review form
and copies their note so they can paste it. Set it up by putting your Google **Place ID** in `data/menu.json` → `"googlePlaceId"`
(find it with Google's "Place ID Finder"). Without a Place ID the button is hidden.

What this deliberately does **not** do: post anything to Google on a guest's behalf (Google offers no API for that — reviews must be written from the guest's own account),
or show the Google button only to happy guests (Google's policy forbids selective review requests, and it can get a listing's reviews removed).
In-app feedback goes to the restaurant; the Google button is shown to everyone, whatever their rating.

## Real payments (Stripe Checkout)
It is off until you set environment variables; without them the app runs in **demo mode** (card / Apple Pay / Google Pay
are marked paid instantly, no charge, receipts only saved to `data/receipts/`). The startup log says which mode you are in.

| Variable | What |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_…` while testing, `sk_live_…` for real money |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` from the webhook endpoint below |
| `CURRENCY_CODE` | ISO code Stripe charges in, e.g. `pkr`, `inr`, `usd` (or `currencyCode` in `menu.json`). **Required** — online payments stay off without it. Must be a currency your Stripe account supports. |
| `PUBLIC_URL` | public **https** address of this server, e.g. `https://order.myrestaurant.com` (Stripe redirects guests back here) |

PowerShell example:
```powershell
$env:STRIPE_SECRET_KEY="sk_test_..."; $env:STRIPE_WEBHOOK_SECRET="whsec_..."; $env:CURRENCY_CODE="usd"
$env:PUBLIC_URL="https://your-tunnel-or-domain";
node server.js
```

Setup steps:
1. Stripe Dashboard → Developers → Webhooks → add endpoint `https://<PUBLIC_URL>/api/stripe/webhook` for
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`.
   Copy its signing secret into `STRIPE_WEBHOOK_SECRET`. (Local testing: `stripe listen --forward-to localhost:3000/api/stripe/webhook`.)
2. Apple Pay / Google Pay need no extra setup: Stripe's hosted page shows them automatically on supported phones.
3. Pay with Stripe's test card `4242 4242 4242 4242` in test mode to try the whole flow before going live.

How it works: the guest taps Pay → server creates a Checkout Session for exactly that share + tip → guest pays on Stripe's page
(card data never touches this server) → Stripe calls the webhook **and** the guest is redirected back. In both cases the server
re-fetches the session from Stripe and only confirms when it is `paid` with the exact amount/currency, so a forged request cannot
mark a bill paid. Cash and bank transfer still need a waiter to confirm on the floor map.

## PDF receipts
Every confirmed payment has a one-page **PDF receipt** (till-roll size): restaurant and address, table, date and receipt number, the items, GST, tip, the guest's share and the total paid, plus a thank-you and the location.
- **Guest:** the receipt screen after paying has **Download PDF receipt** (and, on phones that support it, **Share PDF**, which opens the share sheet so WhatsApp is one tap away).
  Only the device that paid can download it (`/api/payment/<id>/receipt.pdf?cid=…`); staff PIN also works.
- **Restaurant:** a copy of every PDF is saved in `data/receipts/<payment id>.pdf` (no phone numbers on it).
- Someone who paid for *chosen items* gets just those items; everyone else gets the whole table bill with their share highlighted.
- The PDF uses the built-in Courier font, so the rupee sign is printed as **Rs.**
- **On WhatsApp:** set `WHATSAPP_ATTACH_PDF=1` and the PDF is attached to the WhatsApp message (see the template note below).

## Receipt, thank-you and location on WhatsApp
On the Pay tab, in the field where an email address used to be, the guest can type a phone number. A line under the field says what happens ("we will send your receipt and a thank-you on WhatsApp: one message, and your number is not saved"); typing the number is the guest's permission. No number, no message.
When the payment is confirmed (for cash/bank, when the waiter taps *Received*) the server sends **one** WhatsApp message through Meta's WhatsApp Business Cloud API:
a thank-you, a one-line receipt, and the restaurant's location link. The number is used for that single message and then dropped (it is never written to the saved receipt, and the guest only ever sees it masked).

Local numbers get the restaurant's country code (`phoneCountryCode` in `data/menu.json`, `"91"` for India); numbers starting with `+` or `00` keep their own.

**Switching it on** (needs a Meta developer app with a WhatsApp Business number):
| Variable | What |
|---|---|
| `WHATSAPP_TOKEN` | permanent access token of a system user |
| `WHATSAPP_PHONE_ID` | the sending number's *Phone number ID* (not the number itself) |
| `WHATSAPP_TEMPLATE` | approved template name, default `visit_thanks` |
| `WHATSAPP_LANG` | template language code, default `en` |

Because the restaurant starts the conversation, WhatsApp only allows an **approved message template**. Create one named `visit_thanks` in WhatsApp Manager with this body (4 variables, in this order):

> Hi {{1}}, thank you for dining with us at {{2}}! Your receipt: {{3}} We hope to see you again. Find us and share us with friends and family: {{4}}

(Meta may classify it as *Marketing* rather than *Utility*; that affects price, not whether it works.)
**To attach the PDF** (`WHATSAPP_ATTACH_PDF=1`) the template needs a **Header of type "Document"** (for the sample, upload any PDF, e.g. one receipt); the body text stays the same.
The app uploads each receipt to WhatsApp and puts it in that header. If the template has a Document header and `WHATSAPP_ATTACH_PDF` is off (or the other way round) WhatsApp rejects the message; `node tools/whatsapp-check.js` tells you.
Template changes need Meta's approval, so keep the variable order. Until the settings above are set, the guest gets the receipt on screen plus a
**"Send the receipt to my WhatsApp"** button (a normal WhatsApp link, sent from their own phone), and everything else still works.

### Setup checklist (your restaurant number: 96732 23756)
The app only needs two values from Meta, a **token** and the **Phone number ID** of the number. You never put the phone number itself in the app.
1. **Decide how the number is used.** WhatsApp Business Platform (Cloud API) needs a number that is not tied to a normal personal WhatsApp account.
   - If 96732 23756 is already on **personal WhatsApp**, it must be freed first (the Cloud API will take it over), or use a different SIM for receipts.
   - If it is on the **WhatsApp Business app**, Meta's *coexistence* option lets the same number keep working in the app and on the API (it has conditions, e.g. an up-to-date Business app). Pick that option explicitly when connecting; the normal sign-up flow moves the number to API-only. Check Meta's current rules before you start.
   - The number must be able to receive an SMS or voice call for the one-time code.
2. In **business.facebook.com** create (or open) your Business account, then at **developers.facebook.com** create an app of type *Business* and add the **WhatsApp** product.
3. In WhatsApp → **API Setup**, *Add phone number*, enter 96732 23756, choose a display name (Meta reviews it), and verify with the code. Copy the **Phone number ID** and the **WhatsApp Business Account ID**.
   (The "test number" Meta gives you at the start can only message up to 5 numbers you verify. It is fine for trying, not for real guests.)
4. In **Business Settings → Users → System users**, create a system user, give it your app and WhatsApp account, and generate a token with the `whatsapp_business_messaging` permission. (The 24-hour token shown on the API Setup page expires; use a system-user token.)
5. In **WhatsApp Manager → Message templates**, create `visit_thanks` (language English) with the text above. If you want the PDF attached, add a **Document** header (see below) and set `WHATSAPP_ATTACH_PDF=1` in `.env`. Submit it and wait for *Approved*.
6. Copy `.env.example` to `.env` and fill in `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_WABA_ID` (`WHATSAPP_EXPECTED_NUMBER` is already 919673223756).
7. Check it: `node tools/whatsapp-check.js`. It confirms the token works, that the Phone number ID really belongs to 96732 23756 (and not Meta's test number), that the template is approved and has the 4 variables.
   To receive one real test message on your own phone: `node tools/whatsapp-check.js --send 98xxxxxxxx`.
8. Start the app (`node server.js`); the startup log should say `WhatsApp receipts: on`. Pay a test bill with a phone number typed in.

**Share with friends and family** works with no setup: after paying, the guest taps *Share with friends & family* and WhatsApp opens with a ready message and the location.
Set the location in `data/menu.json`: `address` (and optionally `mapsUrl` to use your own Google Maps link; otherwise one is built from the address and `googlePlaceId`). The sample address is a placeholder: replace it.

Privacy: keep the notice under the field, send only what it says, and never reuse the numbers for marketing. Outside India check your local messaging rules.

## What if someone saved the QR and orders from home?
They can scan it from anywhere, but it does nothing until a waiter approves, and the waiter sees who is asking and for which table.
- Not approved → ordering, paying, games and the Wi-Fi password are refused. The floor map shows the request; a waiter who knows nobody is there taps **Decline**.
- A declined phone can't ask again for a minute, one network can only send 8 requests per 10 minutes per table, a device 5, and each table keeps at most 12 pending requests. Unanswered requests disappear after 20 minutes.
- Open table → a new device that asks to join still needs approval (from the waiter, or from a guest already seated), so a stranger can't slip onto a real party's bill.
- Paying the bill (or staff tapping **Close table**) ends the sitting: every approval is revoked and the old QR is useless again. **Remove all devices** does the same without closing the table.
- Orders still wait for a waiter's "Send to kitchen" tap, so nothing reaches the kitchen unreviewed.
- Reviews require a paid bill (one per payment); game-win rewards are capped at 3 per day per device.

## Known limits
- Approval is only as good as the waiter's judgement: if they approve a request from someone who is not there, that device is in until the table is closed.
- Behind a reverse proxy set `TRUST_PROXY=1` so rate limits use the guest's real IP instead of the proxy's.
- After the bill is paid the table is closed; a guest who wants more food scans again and a waiter approves again (one tap).
- State is in memory + `data/state.json` (single restaurant, single server process).
- Tip is added on top of the bill share as a separate Stripe line item; it is not split by Stripe fees or taxes.
- Refunds are done in the Stripe Dashboard; the app does not track them.
