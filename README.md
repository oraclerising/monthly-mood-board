# Monthly Mood Board — Deployment Guide

This folder contains everything you need to deploy your mood board as a real web app that other people can use. Total cost: free tier on Vercel + Anthropic API usage (~$0.01–0.05 per user per month for typical use).

## What's in this folder

- `index.html` — Your mood board, modified to call a backend instead of the platform's Claude
- `api/claude.js` — A serverless function that securely proxies AI requests through your Anthropic API key
- `package.json` — Minimal config for Vercel

---

## Step 1 — Get an Anthropic API key (5 min)

1. Go to [console.anthropic.com](https://console.anthropic.com) and sign up
2. Add a payment method (you'll only pay for what's used — typically pennies)
3. Go to **API Keys** in the sidebar → **Create Key**
4. Copy the key (starts with `sk-ant-…`) — save it somewhere safe; you won't see it again
5. (Optional) Set a usage limit on the Anthropic dashboard so you can't accidentally rack up a bill

---

## Step 2 — Create a Vercel account (2 min)

1. Go to [vercel.com](https://vercel.com) and sign up (free, can use GitHub/Google login)
2. You don't need to install anything — we'll deploy via drag-and-drop

---

## Step 3 — Deploy this folder to Vercel (3 min)

**Easiest path: drag-and-drop**

1. Zip this entire `deploy/` folder on your computer
2. Go to [vercel.com/new](https://vercel.com/new)
3. Click **Browse** under "Deploy a Vercel template" or drag your zip onto the page
4. Vercel detects it's a static site with serverless functions automatically
5. Before clicking Deploy, expand **Environment Variables** and add:
   - **Name:** `ANTHROPIC_API_KEY`
   - **Value:** the key you copied in Step 1
6. Click **Deploy** — wait 30 seconds

You'll get a URL like `https://monthly-mood-board-abc123.vercel.app` — that's your live app! 🎉

**Alternative: via GitHub** (better for ongoing updates)

1. Push this folder to a GitHub repo
2. On [vercel.com/new](https://vercel.com/new), select **Import Git Repository**
3. Pick the repo, add the same env variable, deploy
4. Every git push will redeploy automatically

---

## Step 4 — Test it

Visit your Vercel URL. Try:
- ✅ Entering an intention and clicking **✦ Visualize** — should generate concept text + an AI image
- ✅ Entering birth info and clicking **✦ Generate Monthly Transits** — should populate the transits at the top
- ✅ **✦ Auto-Calculate from Birth Info** — should fill in chart placements

If any AI feature fails, check:
- The `ANTHROPIC_API_KEY` is set correctly in Vercel **Settings → Environment Variables**
- Your Anthropic account has credits / a payment method on file

---

## Step 5 — Custom domain (optional, ~$10/year)

1. Buy a domain on Namecheap, Cloudflare Registrar, or similar
2. In Vercel: **Project → Settings → Domains** → add your domain
3. Follow the DNS instructions Vercel provides

---

## Important: each user's data is local to their browser

This setup keeps it simple — each visitor's intentions and chart info live only in their own browser via localStorage. If they clear cookies, they lose it. Tell users to **Export** their data to a JSON file as a backup.

If you later want users to log in and sync across devices, you'd need to add:
- An auth provider (Clerk, Auth0, Supabase Auth)
- A database (Supabase, Neon, MongoDB Atlas — all have free tiers)
- A few more serverless functions to save/load user data

That's a bigger project — happy to help when you're ready.

---

## Cost expectations

- **Vercel free tier**: handles ~100GB bandwidth and 100GB-hours of serverless compute per month — easily enough for hundreds of users
- **Anthropic API** (Haiku model): roughly $0.001 per request. A user who generates transits once and visualizes 12 houses uses ~13 requests = ~1.3¢
- **100 active users × 13 requests/month = ~$1.30/month**

Set a budget alert in Anthropic's dashboard to be safe.

---

## What changed from the platform version

Only one thing: a small `<script>` shim at the top of `index.html` that intercepts `window.claude.complete(...)` calls and routes them through `/api/claude` (the serverless function) instead. Everything else is identical.

If you update the mood board on the platform later and want to redeploy, just:
1. Re-copy `Mood Board.html` over `deploy/index.html`
2. Re-add the shim script at the top (the one above `<script type="text/babel">`)
3. Redeploy
