# Review of Reviews

Looks up a place the way you would in Google Maps, then scores how trustworthy its reviews look using a mix of pattern-based heuristics and a Claude AI read.

## How it's split

```
review-of-reviews/
├── backend/    Cloudflare Worker — holds API keys, fetches + caches + analyzes
└── frontend/   React (Vite) app — search box, photo/map verification, results
```

- **`backend/review-analyzer-worker.js`** — given a `place_id`, returns a cached result if this place was analyzed in the last 21 days; otherwise fetches the place + its 5 Google reviews + a photo server-side, runs the heuristic checks, asks Claude, combines both into one score, caches it, returns it. Caching is keyed by **place**, not by user, so many people looking up the same restaurant only ever trigger one real analysis.
- **`frontend/src/App.jsx`** — live autocomplete (client-side, free), a photo + embedded map so you can confirm it's the right place, then calls the backend above for the actual analysis.

Why it's split this way, and why Google's 5-review cap is unavoidable, is covered at the bottom under [Known limits](#known-limits).

---

## Prerequisites

Before any of this will actually *do* anything, you need three real accounts — local dev talks to real external APIs, nothing here is mocked:

1. **Node.js 18 or newer** — [nodejs.org](https://nodejs.org). Check with `node -v`.
2. **A Google Cloud project with billing enabled**, and a Maps Platform API key. In Google Cloud Console, enable: **Places API (New)**, **Maps JavaScript API**, **Maps Embed API**. You'll actually make two keys from this project (see below) — one for the browser, one for the backend.
3. **An Anthropic API key** — [console.anthropic.com](https://console.anthropic.com).

You'll also want **git** installed if you're cloning fresh onto a new machine:

```bash
git clone git@github.com:vorbrodt/review-of-reviews.git
cd review-of-reviews
```

---

## Local setup — backend

Open a terminal:

```bash
cd backend
npm install -D wrangler
cp .dev.vars.example .dev.vars
```

Open `.dev.vars` in any text editor and fill in:

```
GOOGLE_SERVER_KEY=your-google-key-here
ANTHROPIC_API_KEY=your-anthropic-key-here
```

For `GOOGLE_SERVER_KEY`, make a **second** API key in the same Google Cloud project (Credentials → Create Credentials → API key), restricted to **Places API (New)** only, with **no** HTTP referrer restriction — this one never reaches a browser, so that's fine.

Now start it:

```bash
npm run dev
```

The first time, wrangler may open a browser tab asking you to log into a free Cloudflare account — that's normal and doesn't deploy anything, it's just how wrangler identifies itself locally. Once running, you'll see something like:

```
⎔ Starting local server...
[wrangler] Ready on http://localhost:8787
```

Leave this terminal running. Sanity-check it in another terminal (this is Google's own docs example place ID, so it's a safe one to test with):

```bash
curl "http://localhost:8787/analyze?place_id=ChIJj61dQgK6j4AR4GeTYWZsKWw"
```

You should get back a JSON blob with `place`, `reviews`, `heuristic`, `ai`, and `combinedScore`. If you get an error instead, see [Troubleshooting](#troubleshooting).

---

## Local setup — frontend

Open a **second** terminal (keep the backend one running):

```bash
cd frontend
npm install react react-dom lucide-react
npm install -D vite @vitejs/plugin-react tailwindcss @tailwindcss/vite
cp .env.example .env
```

Open `.env` and fill in:

```
VITE_GOOGLE_MAPS_BROWSER_KEY=your-browser-key-here
VITE_WORKER_URL=http://localhost:8787
```

For `VITE_GOOGLE_MAPS_BROWSER_KEY`, make a **third** key (or reuse your first one) in the same Google Cloud project, restricted to HTTP referrers `http://localhost:5173/*` for now — you'll widen this to your real domain when you deploy later. This key needs **Places API (New)**, **Maps JavaScript API**, and **Maps Embed API** enabled.

Now start it:

```bash
npm run dev
```

Vite will print a local address, normally:

```
➜  Local:   http://localhost:5173/
```

---

## Try it

With both terminals running, open `http://localhost:5173` in a browser. Type a few letters of a real place name — you should see a live dropdown (this part talks directly to Google, not your backend). Pick one, and the app should call your local backend and show the photo, map, scores, and reviews within a few seconds the first time (longer on a cache miss, since that's when it's actually calling Google + Claude), and instantly on any repeat lookup of the same place.

---

## Troubleshooting

- **Blank page / no styling at all** — Tailwind isn't wired up. Confirm `vite.config.js` includes the `tailwindcss()` plugin and `src/index.css` has `@import "tailwindcss";`, then stop and restart `npm run dev`.
- **Search box shows no suggestions** — open the browser console. Usually a Google Maps key issue: confirm `VITE_GOOGLE_MAPS_BROWSER_KEY` is set in `frontend/.env` (and you restarted `npm run dev` after adding it — Vite only reads `.env` on startup), and that Places API (New) + Maps JavaScript API are enabled with billing on.
- **"Failed to fetch" after picking a place** — the backend terminal isn't running, or crashed. Check it's still showing `Ready on http://localhost:8787`.
- **Wrangler errors about the KV namespace** — run this once, then paste the `id` it prints into `backend/wrangler.toml`:
  ```bash
  npx wrangler kv namespace create REVIEW_CACHE
  ```
- **401/403 from Google or Anthropic, visible in the backend terminal's logs** — double-check `backend/.dev.vars` has no quotes or extra spaces around the keys, and restart `npm run dev` after editing it.

---

## Deploying for real (later)

When you're ready:

**Backend:** Cloudflare dashboard → Workers & Pages → Create Worker → paste in `review-analyzer-worker.js`. Create a real KV namespace named `REVIEW_CACHE` and bind it. Add `GOOGLE_SERVER_KEY` and `ANTHROPIC_API_KEY` as encrypted secrets (`npx wrangler secret put GOOGLE_SERVER_KEY`, or via the dashboard). Deploy, copy the `*.workers.dev` URL. Worth adding a Cloudflare rate-limiting rule on `/analyze` at that point (dashboard only, no code) so nobody can run up your bill with junk place IDs.

**Frontend:** widen your browser key's HTTP referrer restriction to your real domain, set `VITE_GOOGLE_MAPS_BROWSER_KEY` and `VITE_WORKER_URL` (now the real Worker URL) as environment variables on whatever host you deploy to (Vercel/Netlify/Cloudflare Pages all support this the same way), then `npm run build` and deploy the `dist/` folder.

## Cost, roughly

With caching, each *new* place costs about 1–2¢ (Google's side is free at reasonable volume; Claude Haiku 4.5 on 5 short reviews runs a fraction of a cent). Repeat lookups of the same place are free. Real spend scales with distinct places searched, not with number of users.

## Known limits

- Google's Places API caps every place at its 5 most-relevant reviews, at any price — confirmed against the full current parameter list (`languageCode`, `regionCode`, `sessionToken` — none affect review count). No official workaround exists for places you don't own.
- `reviewSummary` (Google's Gemini-generated summary of reviewer sentiment, shown when available) is currently only live in English for India/UK/US and Japanese for Japan — `null` everywhere else for now.
- Scraping-based alternatives (Outscraper, SerpApi, etc.) were considered and intentionally dropped in favor of the official 5-review API, for both cost-at-scale and Google ToS reasons.
- `review-analyzer-worker.js`'s parsing of Google's raw REST response is my best reading of documented field shapes — worth a quick sanity check (like the `curl` test above) the first time you run it against real keys.
