# Review of Reviews

Looks up a place the way you would in Google Maps, then scores how trustworthy its reviews look using a mix of pattern-based heuristics and a Claude AI read.

## How it's split

- **`review-authenticity-scanner.jsx`** — the frontend. Live autocomplete (Google Maps JS SDK, client-side, free with session tokens), a photo + embedded map so the user can confirm it's the right place, then calls the backend for the actual analysis.
- **`review-analyzer-worker.js`** — the backend (a Cloudflare Worker). Given a `place_id`, it:
  1. Returns a cached result if this place was analyzed in the last 21 days.
  2. Otherwise fetches the place + its 5 Google reviews + a photo server-side, runs the heuristic checks, asks Claude for a contextual read, combines both into one score, caches it, and returns it.

Caching is keyed by **place**, not by user — thousands of people looking up the same popular restaurant only ever trigger one real analysis.

## Why it's split this way

- Google's Places API caps every place at its 5 most-relevant reviews, at any price — confirmed against the full current parameter list (`languageCode`, `regionCode`, `sessionToken` — none affect review count). No official workaround exists for arbitrary (non-owned) places.
- A real multi-user product can't ask visitors for their own API keys. The Worker holds both a Google key and an Anthropic key server-side; the frontend only carries a domain-restricted browser key for autocomplete + the map embed.
- The Claude-with-no-key trick only works inside a Claude.ai artifact preview — a real deployed site needs a real Anthropic API key, which is why that call lives in the Worker.

## Deploy steps

**Worker** (see the full header comment in `review-analyzer-worker.js` for detail):
1. Cloudflare dashboard → Workers & Pages → Create Worker → paste in the file.
2. Create a KV namespace named `REVIEW_CACHE`, bind it to the Worker under that same name.
3. Add two encrypted secrets: `GOOGLE_SERVER_KEY` (Places API (New), no referrer restriction) and `ANTHROPIC_API_KEY`.
4. Deploy, copy the `*.workers.dev` URL.
5. Recommended: add a Cloudflare rate-limiting rule on `/analyze` (dashboard only, no code) so nobody can run up your bill with junk place IDs.

**Frontend** (`review-authenticity-scanner.jsx`):
1. Fill in `GOOGLE_MAPS_BROWSER_KEY` (a *separate* key, restricted by HTTP referrer to your real domain; needs Places API (New), Maps JavaScript API, Maps Embed API) and `WORKER_URL` (from above) at the top of the file.
2. Deploy as a normal React app (Vite, Next, CRA, whatever you're already using).

## Cost, roughly

With caching, each *new* place costs about 1–2¢ (Google's side is free at reasonable volume; Claude Haiku 4.5 on 5 short reviews runs a fraction of a cent). Repeat lookups of the same place are free. Real spend scales with distinct places searched, not with number of users.

## Known things to double-check once you have live keys

- `review-analyzer-worker.js`'s parsing of Google's raw REST response (`extractReviews`, `editorialSummary`, `reviewSummary`) is my best reading of documented field shapes — I haven't been able to test it against a live key myself.
- `reviewSummary` (Google's Gemini-generated summary of reviewer sentiment) is currently only live in English for India/UK/US and Japanese for Japan — it'll be `null` everywhere else for now.
- Scraping-based alternatives (Outscraper, SerpApi, etc.) were considered and intentionally dropped in favor of the official 5-review API, for both cost-at-scale and Google ToS reasons.
