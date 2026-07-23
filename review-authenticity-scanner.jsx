import { useState, useEffect, useRef, useCallback } from "react";
import { Search, ShieldCheck, ShieldAlert, ShieldQuestion, Loader2, ChevronDown, ChevronUp, Flag, Sparkles, AlertCircle, MapPin } from "lucide-react";

// ============================================================================
// DEPLOY-TIME CONFIG — set these two once, then visitors never see or need
// any API key. Both are meant to be public in the bundle:
//  - GOOGLE_MAPS_BROWSER_KEY: a Google Maps API key restricted (Google Cloud
//    Console -> Credentials -> your key -> Application restrictions) to HTTP
//    referrers = your actual deployed domain. Needs Places API (New), Maps
//    JavaScript API, and Maps Embed API enabled.
//  - WORKER_URL: the *.workers.dev URL from deploying the companion
//    review-analyzer-worker.js file (holds your real Google + Anthropic keys
//    server-side, and caches results per place).
// ============================================================================
const GOOGLE_MAPS_BROWSER_KEY = "PASTE_YOUR_DOMAIN_RESTRICTED_BROWSER_KEY_HERE";
const WORKER_URL = "PASTE_YOUR_WORKER_URL_HERE"; // e.g. https://review-analyzer.yourname.workers.dev

// ---------- Google Maps loader (client-side, autocomplete only — this part
// stays free and instant, same as before) ----------

function loadGoogleMaps(apiKey) {
  return new Promise((resolve, reject) => {
    if (window.google?.maps?.importLibrary) {
      resolve();
      return;
    }
    const existing = document.getElementById("gmaps-loader-script");
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("load-failed")));
      return;
    }
    const script = document.createElement("script");
    script.id = "gmaps-loader-script";
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly&loading=async`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("load-failed"));
    document.head.appendChild(script);
  });
}

function parseMapsLink(raw) {
  const text = (raw || "").trim();
  if (!/maps\.(app\.goo\.gl)|goo\.gl\/maps|google\.[a-z.]+\/maps/i.test(text)) return null;
  if (/maps\.app\.goo\.gl|goo\.gl\/maps/i.test(text)) return { shortLink: true, name: null };
  const m = text.match(/\/maps\/place\/([^/@]+)/i);
  if (m) {
    try {
      return { shortLink: false, name: decodeURIComponent(m[1].replace(/\+/g, " ")) };
    } catch {
      return { shortLink: false, name: m[1].replace(/\+/g, " ") };
    }
  }
  return { shortLink: false, name: null };
}

function verdict(score) {
  if (score >= 70) return { label: "FLAGGED · LIKELY FAKE", color: "rose" };
  if (score >= 40) return { label: "MIXED SIGNALS", color: "amber" };
  return { label: "LIKELY GENUINE", color: "emerald" };
}

function ScoreCard({ label, score, sub }) {
  const v = verdict(score ?? 0);
  return (
    <div className="flex-1 min-w-[140px] bg-slate-900 border border-slate-800 rounded-sm p-4">
      <p className="text-[10px] uppercase tracking-widest text-slate-500 font-mono mb-2">{label}</p>
      <p className={`text-4xl font-mono font-semibold text-${v.color}-400`}>
        {score === null || score === undefined ? "—" : score}
        <span className="text-base text-slate-600">/100</span>
      </p>
      <p className={`text-xs mt-2 font-mono text-${v.color}-400`}>{sub}</p>
    </div>
  );
}

export default function ReviewAuthenticityScanner() {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const [linkNotice, setLinkNotice] = useState(null);

  const [status, setStatus] = useState("idle"); // idle | analyzing | done | error
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null); // { place, reviews, heuristic, ai, combinedScore, cached }
  const [reviewsExpanded, setReviewsExpanded] = useState(true);
  const [reviewDisplayLimit, setReviewDisplayLimit] = useState(20);

  const sessionTokenRef = useRef(null);
  const debounceRef = useRef(null);
  const requestIdRef = useRef(0);
  const userLocRef = useRef(null);

  // Load the Maps JS SDK once on mount — no more "add your key" gate.
  useEffect(() => {
    loadGoogleMaps(GOOGLE_MAPS_BROWSER_KEY)
      .then(() => window.google.maps.importLibrary("places"))
      .catch(() => setError("Google Maps failed to load. The app owner needs to check GOOGLE_MAPS_BROWSER_KEY."));
  }, []);

  useEffect(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          userLocRef.current = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        },
        () => {},
        { timeout: 4000 }
      );
    }
  }, []);

  const fetchSuggestions = useCallback(async (value) => {
    if (!value || value.trim().length < 3 || !window.google?.maps?.places) {
      setSuggestions([]);
      return;
    }
    const myId = ++requestIdRef.current;
    try {
      if (!sessionTokenRef.current) {
        sessionTokenRef.current = new window.google.maps.places.AutocompleteSessionToken();
      }
      const request = { input: value, sessionToken: sessionTokenRef.current };
      if (userLocRef.current) request.locationBias = { radius: 50000, center: userLocRef.current };
      const { suggestions: raw } = await window.google.maps.places.AutocompleteSuggestion.fetchAutocompleteSuggestions(request);
      if (myId !== requestIdRef.current) return;
      const mapped = (raw || [])
        .filter((s) => s.placePrediction)
        .map((s) => ({
          mainText: s.placePrediction.mainText?.text || s.placePrediction.text?.text || "",
          secondaryText: s.placePrediction.secondaryText?.text || "",
          placeId: s.placePrediction.placeId,
          raw: s,
        }));
      setSuggestions(mapped);
      setShowSuggestions(true);
      setHighlighted(-1);
    } catch {
      if (myId !== requestIdRef.current) return;
      setSuggestions([]);
    }
  }, []);

  const scheduleSuggestionFetch = useCallback(
    (value) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => fetchSuggestions(value), 250);
    },
    [fetchSuggestions]
  );

  function handleInputChange(value) {
    setQuery(value);
    setResult(null);
    setError(null);
    setStatus("idle");
    setReviewDisplayLimit(20);

    const parsed = parseMapsLink(value);
    if (parsed?.shortLink) {
      setLinkNotice("Short links can't be read directly in the browser — open it once and paste the full maps.google.com/... link, or just type the place name.");
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    if (parsed?.name) {
      setLinkNotice(`Detected "${parsed.name}" from the link — pick the right match below.`);
      setQuery(parsed.name);
      scheduleSuggestionFetch(parsed.name);
      return;
    }
    setLinkNotice(null);
    scheduleSuggestionFetch(value);
  }

  const selectSuggestion = useCallback(async (s) => {
    setShowSuggestions(false);
    setSuggestions([]);
    setQuery(s.mainText + (s.secondaryText ? `, ${s.secondaryText}` : ""));
    setError(null);
    setResult(null);
    setReviewDisplayLimit(20);

    try {
      setStatus("analyzing");

      // Terminate the autocomplete session with the free "IDs only" tier so the
      // typing you just did stays billed as a free session, not per-keystroke.
      // We don't need the data back — s.placeId already has what we need.
      const gPlace = s.raw.placePrediction.toPlace();
      gPlace.fetchFields({ fields: ["id"] }).catch(() => {});

      const res = await fetch(`${WORKER_URL}/analyze?place_id=${encodeURIComponent(s.placeId)}`);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `Backend returned HTTP ${res.status}`);

      setResult(data);
      setStatus("done");
    } catch (e) {
      setStatus("error");
      setError(e?.message || "Something went wrong analyzing this place.");
    }
  }, []);

  function handleKeyDown(e) {
    if (!showSuggestions || suggestions.length === 0) {
      if (e.key === "Enter") scheduleSuggestionFetch(query);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => Math.min(h + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      selectSuggestion(suggestions[highlighted >= 0 ? highlighted : 0]);
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  }

  const isLoading = status === "analyzing";
  const place = result?.place;
  const reviews = result?.reviews || [];
  const heuristic = result?.heuristic;
  const ai = result?.ai;
  const combinedScore = result?.combinedScore ?? null;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans">
      <div className="max-w-3xl mx-auto px-4 py-10">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-sm bg-amber-500 flex items-center justify-center text-slate-950 font-bold font-mono text-sm">RA</div>
          <div>
            <p className="text-[10px] uppercase tracking-widest text-slate-500 font-mono">Case File · Review Forensics</p>
            <h1 className="text-2xl font-semibold tracking-tight">Review Authenticity Scanner</h1>
          </div>
        </div>
        <p className="text-slate-400 text-sm mt-2 max-w-xl">
          Search for a place like you would in Google Maps, verify it's the right one, then get a combined heuristic + AI read on how trustworthy its reviews look.
        </p>
        <div className="mt-3 border border-amber-900/60 bg-amber-950/20 rounded-sm px-3 py-2 text-xs text-amber-300/90">
          Google's API returns each place's 5 most-relevant reviews — that's the real, current ceiling of the official API, at any price. Every score below is based on that sample.
        </div>

        {/* Search */}
        <div className="mt-6 relative">
          <div className="flex items-center gap-2 bg-slate-900 border border-slate-700 rounded-sm px-3 focus-within:ring-1 focus-within:ring-amber-500">
            <Search size={16} className="text-slate-500 shrink-0" />
            <input
              value={query}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 120)}
              onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
              placeholder="Type a place name, or paste a Google Maps link"
              className="flex-1 bg-transparent py-2.5 text-sm placeholder-slate-600 focus:outline-none"
            />
            {isLoading && <Loader2 size={16} className="animate-spin text-amber-400 shrink-0" />}
          </div>

          {linkNotice && <p className="text-xs text-slate-500 mt-1.5">{linkNotice}</p>}

          {showSuggestions && suggestions.length > 0 && (
            <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-slate-900 border border-slate-700 rounded-sm overflow-hidden shadow-xl">
              {suggestions.map((s, i) => (
                <button
                  key={i}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectSuggestion(s);
                  }}
                  className={`w-full text-left px-3 py-2.5 flex items-start gap-2 border-b border-slate-800 last:border-0 ${i === highlighted ? "bg-slate-800" : "hover:bg-slate-800/60"}`}
                >
                  <MapPin size={14} className="text-amber-400 mt-0.5 shrink-0" />
                  <span className="min-w-0">
                    <span className="block text-sm text-slate-100 truncate">{s.mainText}</span>
                    {s.secondaryText && <span className="block text-xs text-slate-500 truncate">{s.secondaryText}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {isLoading && (
          <p className="text-xs font-mono text-amber-400 mt-3 flex items-center gap-2">
            <Loader2 size={12} className="animate-spin" /> Analyzing...
          </p>
        )}

        {error && (
          <div className="mt-4 border border-rose-900 bg-rose-950/40 rounded-sm px-4 py-3 flex gap-2 text-sm text-rose-300">
            <AlertCircle size={16} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {place && (
          <div className="mt-6">
            {place.photoUri ? (
              <img src={place.photoUri} alt={place.name} className="w-full h-48 object-cover rounded-sm border border-slate-800" />
            ) : (
              <div className="w-full h-24 rounded-sm border border-slate-800 bg-slate-900/40 flex items-center justify-center text-xs text-slate-600">
                No photo available for this place
              </div>
            )}

            <iframe
              title="Location on Google Maps"
              className="w-full h-48 rounded-sm border border-slate-800 mt-2"
              loading="lazy"
              src={`https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(GOOGLE_MAPS_BROWSER_KEY)}&q=place_id:${encodeURIComponent(place.id)}`}
            />

            <div className="border border-slate-800 rounded-sm p-4 bg-slate-900/40 flex items-start justify-between mt-2">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold truncate">{place.name}</h2>
                <p className="text-sm text-slate-400">{place.address}</p>
                {place.editorialSummary && <p className="text-xs text-slate-500 mt-1 italic">{place.editorialSummary}</p>}
              </div>
              <div className="text-right shrink-0 ml-4">
                <p className="text-xl font-mono">{place.rating ?? "—"}★</p>
                <p className="text-xs text-slate-500 font-mono">{(place.userRatingCount ?? 0).toLocaleString()} Google ratings</p>
              </div>
            </div>

            {status === "done" && reviews.length === 0 && (
              <p className="text-sm text-slate-500 mt-4">{ai?.summary || "No reviews to analyze yet."}</p>
            )}

            {status === "done" && reviews.length > 0 && (
              <>
                <div className="relative mt-6">
                  <div className="flex flex-wrap gap-3">
                    <ScoreCard label="Heuristic Signal" score={heuristic?.score} sub={verdict(heuristic?.score ?? 0).label} />
                    <ScoreCard label="AI Read" score={ai?.score} sub={ai?.failed ? "UNAVAILABLE" : verdict(ai?.score ?? 0).label} />
                    <ScoreCard label="Combined" score={combinedScore} sub={combinedScore !== null ? verdict(combinedScore).label : ""} />
                  </div>
                  {combinedScore !== null && (
                    <div
                      className={`hidden sm:flex absolute -top-3 -right-3 rotate-6 border-4 border-double px-3 py-1 text-xs font-mono font-bold tracking-widest border-${verdict(combinedScore).color}-500 text-${verdict(combinedScore).color}-400 bg-slate-950`}
                    >
                      {verdict(combinedScore).label}
                    </div>
                  )}
                  {result?.cached && <p className="text-[10px] font-mono text-slate-600 mt-2">Served from cache — no fresh API calls made for this lookup.</p>}
                  {place.userRatingCount > 0 &&
                    (() => {
                      const pct = (reviews.length / place.userRatingCount) * 100;
                      const thin = pct < 5;
                      return (
                        <p className={`text-xs mt-2 ${thin ? "text-amber-400" : "text-slate-500"}`}>
                          {thin
                            ? `These 5 reviews are just ${pct < 0.1 ? "<0.1" : pct.toFixed(1)}% of ${place.userRatingCount.toLocaleString()} total — treat this score as a loose signal, not a verdict.`
                            : `These 5 reviews cover ${pct.toFixed(0)}% of this place's ${place.userRatingCount.toLocaleString()} total ratings — a meaningfully larger slice than usual.`}
                        </p>
                      );
                    })()}
                </div>

                {place.reviewSummary && (
                  <div className="mt-4 border border-slate-800 rounded-sm p-4 bg-slate-900/40">
                    <p className="text-[10px] uppercase tracking-widest text-slate-500 font-mono mb-2">Google's Review Summary (Gemini)</p>
                    <p className="text-sm text-slate-300">{place.reviewSummary}</p>
                  </div>
                )}

                {ai && (
                  <div className="mt-6 border border-slate-800 rounded-sm p-4 bg-slate-900/40">
                    <p className="text-[10px] uppercase tracking-widest text-slate-500 font-mono mb-2 flex items-center gap-2">
                      <Sparkles size={12} className="text-amber-400" /> AI Analyst Notes
                    </p>
                    <p className="text-sm text-slate-200">{ai.summary}</p>
                    <p className="text-sm text-slate-400 mt-2">{ai.notes}</p>
                  </div>
                )}

                {heuristic && heuristic.flags.length > 0 && (
                  <div className="mt-4 border border-slate-800 rounded-sm p-4 bg-slate-900/40">
                    <p className="text-[10px] uppercase tracking-widest text-slate-500 font-mono mb-3">Pattern Flags</p>
                    <div className="flex flex-wrap gap-2">
                      {heuristic.flags.map((f, i) => (
                        <span key={i} className="flex items-center gap-1.5 text-xs font-mono border border-amber-800 text-amber-300 bg-amber-950/40 rounded-sm px-2 py-1">
                          <Flag size={11} /> {f.label}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mt-6">
                  <button onClick={() => setReviewsExpanded((s) => !s)} className="flex items-center gap-2 text-xs uppercase tracking-widest text-slate-500 font-mono mb-1">
                    Reviews Examined ({reviews.length}) {reviewsExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                  <p className="text-xs text-slate-600 mb-3">Of {(place.userRatingCount ?? 0).toLocaleString()} total ratings on Google — official 5-review cap.</p>
                  {reviewsExpanded && (
                    <div className="space-y-3">
                      {reviews.slice(0, reviewDisplayLimit).map((r, i) => {
                        const hFlag = heuristic?.perReview?.[i];
                        const aiFlagged = ai?.suspicious_indices?.includes(i);
                        const flagged = hFlag?.dup || hFlag?.generic || hFlag?.short || aiFlagged;
                        return (
                          <div key={i} className={`border rounded-sm p-3 ${flagged ? "border-rose-900 bg-rose-950/20" : "border-slate-800 bg-slate-900/30"}`}>
                            <div className="flex items-center justify-between text-xs font-mono text-slate-500 mb-1">
                              <span>
                                {r.author} · {"★".repeat(Math.max(0, r.rating || 0))}
                                {"☆".repeat(Math.max(0, 5 - (r.rating || 0)))}
                              </span>
                              <span>{r.relativeTime}</span>
                            </div>
                            <p className="text-sm text-slate-200">{r.text || <em className="text-slate-500">No written text</em>}</p>
                            {flagged && (
                              <div className="flex flex-wrap gap-1.5 mt-2">
                                {hFlag?.dup && <span className="text-[10px] font-mono text-rose-300 border border-rose-800 rounded-sm px-1.5 py-0.5">near-duplicate</span>}
                                {hFlag?.generic && <span className="text-[10px] font-mono text-rose-300 border border-rose-800 rounded-sm px-1.5 py-0.5">generic phrasing</span>}
                                {hFlag?.short && <span className="text-[10px] font-mono text-rose-300 border border-rose-800 rounded-sm px-1.5 py-0.5">very short</span>}
                                {aiFlagged && <span className="text-[10px] font-mono text-rose-300 border border-rose-800 rounded-sm px-1.5 py-0.5">AI flagged</span>}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
