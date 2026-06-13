# H2 Budget — iOS app (Expo)

A focused native app for H2 Budget: see your **weekly + monthly allowances**
at a glance and **categorize Chase/Amex** transactions on the go. It talks to
the same backend as the web app, so the numbers always match.

## What's here

- **Allowances tab** — the "stupid important" screen: this week's weekly
  spend vs planned, and this month's monthly spend vs planned, each with a
  progress bar and over/under. Pull to refresh.
- **Categorize tab** — recent Chase/Amex charges, "Needs a category" first;
  tap a row, pick a category, done.
- Clean corporate look (navy + white cards), Clerk sign-in, no extra fetch.

## Run it on your iPhone (free, ~10 min)

You do **not** need an Apple Developer account or a Mac for this part.

1. **Install dependencies** (in this folder):
   ```
   npm install
   npx expo install   # pins RN/Expo native versions correctly
   ```
2. **Add your Clerk key.** Open `app.json` → `expo.extra.clerkPublishableKey`
   and paste the **same `CLERK_PUBLISHABLE_KEY`** the web app uses (starts
   with `pk_`). Confirm `apiBaseUrl` points at your deployed backend
   (default: `https://hubele-budget.replit.app`).
3. **Start it:**
   ```
   npx expo start
   ```
4. On your iPhone, install **Expo Go** from the App Store, then scan the QR
   code in the terminal. The app opens on your phone. Sign in with your H2
   Budget email + password.

> If sign-in says "additional verification required," sign in once on the web
> first (or switch Clerk to email+password), then retry.

## Going to the App Store + the home-screen widget (later)

The **widget** is the only part that needs the paid path:

- An **Apple Developer account** ($99/yr).
- An **EAS build** (`npx eas build -p ios`) — Expo compiles it in the cloud,
  no Mac required.
- The widget itself is a WidgetKit target added via `expo-apple-targets`.

The allowances + categorize app above works fully via Expo Go **without** any
of that — the developer account is only required for a real installed build
(and therefore the widget) and/or App Store / TestFlight distribution.

## Notes

- The backend's `requireAuth` accepts the Clerk session token; the API client
  (`lib/api.ts`) attaches it as a `Bearer` header on every call.
- Allowance math (`lib/allowances.ts`) mirrors the web: weekly = current
  Sun–Sat, monthly = current calendar month; reimbursable + transfers excluded.
