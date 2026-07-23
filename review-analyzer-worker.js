/**
 * Review Authenticity Scanner — production backend (Cloudflare Worker, free tier)
 *
 * WHAT THIS DOES
 * Given a Google place_id, returns a cached authenticity score if one exists;
 * otherwise fetches the place + its 5 Google reviews + a photo, runs the
 * heuristic checks, asks Claude for a contextual read, combines the two into
 * one score, caches the whole thing for 21 days, and returns it. Because the
 * cache key is the PLACE (not the user), thousands of users looking up the
 * same popular restaurant only ever pay for one real analysis — everyone else
 * gets the cached result for free.
 *
 * WHY THE KEYS LIVE HERE AND NOT IN THE APP
 * A real multi-user product can't ask visitors to bring their own Google/
 * Anthropic API keys — nobody will do that. Instead, YOU (the app owner) hold
 * two keys, both server-side, never sent to any browser:
 *   - GOOGLE_SERVER_KEY: a Google Maps API key restricted to Places API (New)
 *     only, with NO HTTP-referrer restriction (fine, since it never leaves
 *     the server). Separate from the browser-facing key used for autocomplete
 *     in the frontend, which IS referrer-restricted to your domain.
 *   - ANTHROPIC_API_KEY: from console.anthropic.com. The magic key-less fetch
 *     that works inside a Claude.ai artifact preview does NOT work once this
 *     is deployed for real — this is what replaces it.
 *
 * SETUP (about 10 minutes, free at this scale)
 * 1. dash.cloudflare.com -> Workers & Pages -> Create -> Create Worker.
 *    Paste this file's contents in, replacing the default.
 * 2. Workers & Pages -> KV -> Create namespace, name it REVIEW_CACHE.
 *    Back on your Worker: Settings -> Bindings -> add KV namespace binding,
 *    variable name REVIEW_CACHE, pointing at that namespace.
 * 3. Settings -> Variables and Secrets -> add two encrypted secrets:
 *    GOOGLE_SERVER_KEY and ANTHROPIC_API_KEY.
 * 4. Deploy. Copy the *.workers.dev URL and put it in the frontend's
 *    WORKER_URL constant.
 * 5. Recommended, no code needed: in the Cloudflare dashboard, add a basic
 *    rate-limiting rule on this Worker's route (Security -> WAF -> Rate
 *    limiting rules) so nobody can hammer /analyze with junk place_ids and
 *    run up your Google/Anthropic bill.
 *
 * ENDPOINT
 *   GET /analyze?place_id=ChIJ...  ->  JSON: { place, reviews, heuristic, ai, combinedScore, cached }
 */

const CACHE_TTL_SECONDS = 21 * 24 * 60 * 60; // 21 days — reviews don't change minute to minute

// ---------- Heuristic engine (same logic as the prototype, ported here) ----------

const GENERIC_PHRASES = [
  "highly recommend",
  "best ever",
  "amazing service",
  "will definitely return",
  "exceeded my expectations",
  "five stars",
  "great experience",
  "friendly staff",
  "will come back",
  "top notch",
  "excellent service",
  "must visit",
  "hidden gem",
  "worth every penny",
  "changed my life",
  "life changing",
  "highly recommended",
  "super friendly",
];

function wordCount(t) {
  return (t || "").trim().split(/\s+/).filter(Boolean).length;
}

function jaccard(a, b) {
  const sa = new Set((a || "").toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const sb = new Set((b || "").toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  sa.forEach((w) => {
    if (sb.has(w)) inter++;
  });
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : inter / union;
}

function runHeuristics(reviews) {
  const flags = [];
  const perReview = reviews.map(() => ({ dup: false, generic: false, short: false }));
  let score = 0;

  let dupPairs = 0;
  for (let i = 0; i < reviews.length; i++) {
    for (let j = i + 1; j < reviews.length; j++) {
      if (jaccard(reviews[i].text, reviews[j].text) > 0.45) {
        dupPairs++;
        perReview[i].dup = true;
        perReview[j].dup = true;
      }
    }
  }
  if (dupPairs > 0) {
    const pts = Math.min(40, dupPairs * 20);
    score += pts;
    flags.push({ label: `${dupPairs} pair${dupPairs > 1 ? "s" : ""} of near-duplicate review text`, weight: pts });
  }

  let genericCount = 0;
  reviews.forEach((r, i) => {
    const t = (r.text || "").toLowerCase();
    if (GENERIC_PHRASES.filter((p) => t.includes(p)).length >= 2) {
      genericCount++;
      perReview[i].generic = true;
    }
  });
  if (genericCount > 0) {
    const pts = Math.min(20, genericCount * 10);
    score += pts;
    flags.push({ label: `${genericCount} review${genericCount > 1 ? "s" : ""} stacked with generic marketing phrases`, weight: pts });
  }

  const extreme = reviews.filter((r) => r.rating === 5 || r.rating === 1).length;
  const ratio = reviews.length ? extreme / reviews.length : 0;
  if (ratio > 0.8 && reviews.length >= 3) {
    score += 15;
    flags.push({ label: `${Math.round(ratio * 100)}% of reviews are extreme (1★ or 5★), little middle ground`, weight: 15 });
  }

  const times = reviews
    .map((r) => (r.publishTime ? new Date(r.publishTime).getTime() : null))
    .filter(Boolean)
    .sort((a, b) => a - b);
  let burst = false;
  for (let i = 0; i < times.length - 1; i++) {
    if (times[i + 1] - times[i] < 1000 * 60 * 60 * 48) burst = true;
  }
  if (burst) {
    score += 15;
    flags.push({ label: "Multiple reviews posted within 48 hours of each other", weight: 15 });
  }

  let shortCount = 0;
  reviews.forEach((r, i) => {
    if (wordCount(r.text) < 8) {
      shortCount++;
      perReview[i].short = true;
    }
  });
  if (shortCount >= 2) {
    const pts = Math.min(10, shortCount * 5);
    score += pts;
    flags.push({ label: `${shortCount} reviews are under 8 words`, weight: pts });
  }

  return { score: Math.min(100, score), flags, perReview };
}

// ---------- Google Places (New) REST calls — server-to-server, no CORS involved ----------

function extractReviews(googleJson) {
  // The raw REST response keeps LocalizedText fields nested as {text, languageCode},
  // unlike the JS client library which flattens them. Reviews here need `.text.text`.
  return (googleJson.reviews || []).map((r) => ({
    author: r.authorAttribution?.displayName || "Anonymous",
    rating: r.rating ?? null,
    text: r.text?.text || "",
    relativeTime: r.relativePublishTimeDescription || "",
    publishTime: r.publishTime || null,
  }));
}

async function fetchPlace(placeId, key) {
  // reviewSummary and editorialSummary both live in the same Enterprise + Atmosphere
  // SKU as `reviews`, so adding them here costs nothing extra — you're already
  // paying for that tier. reviewSummary is Gemini's synthesis of what reviewers say
  // (drawing on Google's full internal review set, not just the 5 shown here), but
  // it's currently only live in English for India/UK/US and Japanese for Japan — it
  // will be null/absent everywhere else for now, so treat it as a bonus, not a given.
  const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: {
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "id,displayName,formattedAddress,rating,userRatingCount,photos,reviews,reviewSummary,editorialSummary",
    },
  });
  if (!res.ok) throw new Error(`Google Place Details failed: HTTP ${res.status}`);
  return res.json();
}

async function fetchPhotoUri(photoName, key) {
  // skipHttpRedirect=true returns JSON with a temporary, key-free photoUri instead
  // of a redirect — safe to hand straight to the browser as an <img src>.
  try {
    const res = await fetch(`https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=900&skipHttpRedirect=true&key=${key}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.photoUri || null;
  } catch {
    return null;
  }
}

// ---------- Claude ----------

async function runAIAnalysis(placeName, address, reviews, anthropicKey) {
  const reviewBlock = reviews
    .map(
      (r, i) =>
        `[${i}] rating:${r.rating} author:"${r.author}" time:"${r.relativeTime || "unknown"}" text:"${(r.text || "").replace(/"/g, "'").slice(0, 600)}"`
    )
    .join("\n");

  const prompt = `You are a fraud-detection analyst. Below are ${reviews.length} Google Maps reviews for "${placeName}" (${address || "address unknown"}). Assess how likely it is that some of these reviews are fake, incentivized, or bot-generated. Respond with ONLY a raw JSON object, no markdown, no code fences, matching this schema exactly:
{"score": <integer 0-100>, "summary": "<one or two sentence overview>", "suspicious_indices": [<up to 5 integers referencing the [i] indices above, can be empty>], "notes": "<short reasoning, max 3 sentences>"}

Reviews:
${reviewBlock}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      // Haiku 4.5 ($1/$5 per million tokens) — a handful of short reviews is a
      // simple-enough classification task that a cheaper model handles well.
      // Swap to "claude-sonnet-5" if you want a qualitatively deeper read.
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

// ---------- HTTP plumbing ----------

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(), "Content-Type": "application/json" } });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors() });

    const url = new URL(request.url);
    if (url.pathname !== "/analyze") {
      return json({ error: "Not found. Use /analyze?place_id=..." }, 404);
    }

    const placeId = url.searchParams.get("place_id");
    if (!placeId) return json({ error: "Missing place_id" }, 400);
    if (!env.GOOGLE_SERVER_KEY || !env.ANTHROPIC_API_KEY) {
      return json({ error: "Worker is missing GOOGLE_SERVER_KEY or ANTHROPIC_API_KEY secrets" }, 500);
    }

    const cacheKey = `place:${placeId}`;
    const cached = await env.REVIEW_CACHE.get(cacheKey, { type: "json" });
    if (cached) return json({ ...cached, cached: true });

    try {
      const googleData = await fetchPlace(placeId, env.GOOGLE_SERVER_KEY);
      const reviews = extractReviews(googleData);
      const placeInfo = {
        id: placeId,
        name: googleData.displayName?.text || "Unknown place",
        address: googleData.formattedAddress || "",
        rating: googleData.rating ?? null,
        userRatingCount: googleData.userRatingCount ?? 0,
        photoUri: null,
        // Bonus fields, same billing tier as reviews — null when Google hasn't
        // generated one for this place/region yet (see fetchPlace() note above).
        reviewSummary: googleData.reviewSummary?.text?.text || null,
        editorialSummary: googleData.editorialSummary?.text || null,
      };

      if (googleData.photos && googleData.photos.length > 0) {
        placeInfo.photoUri = await fetchPhotoUri(googleData.photos[0].name, env.GOOGLE_SERVER_KEY);
      }

      let result;
      if (reviews.length === 0) {
        result = {
          place: placeInfo,
          reviews: [],
          heuristic: { score: 0, flags: [], perReview: [] },
          ai: { score: 0, summary: "This place has no reviews yet.", suspicious_indices: [], notes: "", failed: false },
          combinedScore: null,
          cached: false,
        };
      } else {
        const heuristic = runHeuristics(reviews);
        let ai;
        try {
          ai = await runAIAnalysis(placeInfo.name, placeInfo.address, reviews, env.ANTHROPIC_API_KEY);
        } catch (aiErr) {
          ai = { score: 0, summary: "AI analysis unavailable right now.", suspicious_indices: [], notes: String(aiErr?.message || aiErr), failed: true };
        }
        const combinedScore = ai.failed ? null : Math.round(heuristic.score * 0.45 + ai.score * 0.55);
        result = { place: placeInfo, reviews, heuristic, ai, combinedScore, cached: false };
      }

      // Respond immediately; let the cache write finish in the background.
      ctx.waitUntil(env.REVIEW_CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS }));
      return json(result);
    } catch (e) {
      return json({ error: String(e?.message || e) }, 502);
    }
  },
};
