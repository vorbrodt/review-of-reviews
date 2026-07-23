import { useState, useEffect, useRef, useCallback } from "react";
import { Search, ShieldCheck, ShieldAlert, ShieldQuestion, Loader2, ChevronDown, ChevronUp, Flag, Sparkles, AlertCircle, MapPin, Info } from "lucide-react";

// ============================================================================
// CONFIG — comes from environment variables (see frontend/.env.example).
// Locally this reads frontend/.env; when you deploy later, set the same two
// variables in whatever host you use (Vercel/Netlify/etc. all support this).
//  - VITE_GOOGLE_MAPS_BROWSER_KEY: a Google Maps API key restricted (Google
//    Cloud Console -> Credentials -> your key -> Application restrictions) to
//    HTTP referrers = your domain (use http://localhost:5173/* for now).
//    Needs Places API (New), Maps JavaScript API, and Maps Embed API enabled.
//  - VITE_WORKER_URL: your backend's URL. Defaults to the local wrangler dev
//    address so `npm run dev` in both folders talks to each other with zero
//    extra config.
// ============================================================================
const GOOGLE_MAPS_BROWSER_KEY = import.meta.env.VITE_GOOGLE_MAPS_BROWSER_KEY || "";
const WORKER_URL = import.meta.env.VITE_WORKER_URL || "http://localhost:8787";

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

// ---------- Verdict system: one consistent emerald / amber / rose scale used
// everywhere a score shows up (score cards, the seal, review flags) ----------

function verdict(score) {
  if (score >= 70) return { label: "Likely fake", ring: "ring-rose-200", text: "text-rose-700", bg: "bg-rose-50", solid: "bg-rose-600", border: "border-rose-200", Icon: ShieldAlert };
  if (score >= 40) return { label: "Mixed signals", ring: "ring-amber-200", text: "text-amber-700", bg: "bg-amber-50", solid: "bg-amber-500", border: "border-amber-200", Icon: ShieldQuestion };
  return { label: "Likely genuine", ring: "ring-emerald-200", text: "text-emerald-700", bg: "bg-emerald-50", solid: "bg-emerald-600", border: "border-emerald-200", Icon: ShieldCheck };
}

function ScoreCard({ label, score, sub }) {
  const v = verdict(score ?? 0);
  return (
    <div className={`flex-1 min-w-[140px] bg-white border ${v.border} rounded-xl p-4 shadow-sm`}>
      <p className="text-[11px] uppercase tracking-widest text-slate-400 font-medium mb-2">{label}</p>
      <p className="text-4xl font-mono font-semibold text-slate-900">
        {score === null || score === undefined ? "—" : score}
        <span className="text-base text-slate-300">/100</span>
      </p>
      <p className={`text-xs mt-2 font-medium ${v.text}`}>{sub}</p>
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
    if (!GOOGLE_MAPS_BROWSER_KEY) {
      setError("VITE_GOOGLE_MAPS_BROWSER_KEY is not set — copy frontend/.env.example to frontend/.env, add your key, and restart `npm run dev`.");
      return;
    }
    loadGoogleMaps(GOOGLE_MAPS_BROWSER_KEY)
      .then(() => window.google.maps.importLibrary("places"))
      .catch(() => setError("Google Maps failed to load — check that VITE_GOOGLE_MAPS_BROWSER_KEY is valid and Places API (New) + Maps JavaScript API are enabled."));
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
  const combinedVerdict = combinedScore !== null ? verdict(combinedScore) : null;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-2xl mx-auto px-5 py-5 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-slate-900 flex items-center justify-center shrink-0 ring-4 ring-amber-100">
            <ShieldCheck size={20} className="text-amber-400" />
          </div>
          <div>
            <h1 className="text-xl font-serif font-semibold tracking-tight text-slate-900">Review Authenticity Scanner</h1>
            <p className="text-xs text-slate-500 mt-0.5">Verified reading of Google reviews, backed by AI</p>
          </div>
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-5 py-8">
        <p className="text-slate-600 text-sm leading-relaxed">
          Search for a place like you would in Google Maps, confirm it's the right one, then get a combined signal from pattern analysis and an AI read on how trustworthy its reviews look.
        </p>

        <div className="mt-4 flex gap-2.5 bg-slate-100 border border-slate-200 rounded-xl px-3.5 py-3 text-xs text-slate-600 leading-relaxed">
          <Info size={15} className="text-slate-400 shrink-0 mt-0.5" />
          <span>Google's API returns each place's 5 most-relevant reviews — the real, current ceiling of the official API, at any price. Every score below is based on that sample.</span>
        </div>

        {/* Search */}
        <div className="mt-6 relative">
          <div className="flex items-center gap-2.5 bg-white border border-slate-300 rounded-xl px-4 shadow-sm focus-within:ring-2 focus-within:ring-amber-400 focus-within:border-amber-400 transition-shadow">
            <Search size={17} className="text-slate-400 shrink-0" />
            <input
              value={query}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 120)}
              onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
              placeholder="Type a place name, or paste a Google Maps link"
              className="flex-1 bg-transparent py-3 text-[15px] text-slate-900 placeholder-slate-400 focus:outline-none"
            />
            {isLoading && <Loader2 size={17} className="animate-spin text-amber-500 shrink-0" />}
          </div>

          {linkNotice && <p className="text-xs text-slate-500 mt-1.5 px-1">{linkNotice}</p>}

          {showSuggestions && suggestions.length > 0 && (
            <div className="absolute z-10 top-full left-0 right-0 mt-1.5 bg-white border border-slate-200 rounded-xl overflow-hidden shadow-lg">
              {suggestions.map((s, i) => (
                <button
                  key={i}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectSuggestion(s);
                  }}
                  className={`w-full text-left px-4 py-3 flex items-start gap-2.5 border-b border-slate-100 last:border-0 ${i === highlighted ? "bg-amber-50" : "hover:bg-slate-50"}`}
                >
                  <MapPin size={15} className="text-amber-500 mt-0.5 shrink-0" />
                  <span className="min-w-0">
                    <span className="block text-sm text-slate-900 font-medium truncate">{s.mainText}</span>
                    {s.secondaryText && <span className="block text-xs text-slate-500 truncate">{s.secondaryText}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {isLoading && (
          <p className="text-sm text-amber-600 mt-4 flex items-center gap-2 font-medium">
            <Loader2 size={14} className="animate-spin" /> Analyzing...
          </p>
        )}

        {error && (
          <div className="mt-4 border border-rose-200 bg-rose-50 rounded-xl px-4 py-3 flex gap-2.5 text-sm text-rose-700">
            <AlertCircle size={17} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {place && (
          <div className="mt-8">
            {place.photoUri ? (
              <img src={place.photoUri} alt={place.name} className="w-full h-52 object-cover rounded-xl border border-slate-200 shadow-sm" />
            ) : (
              <div className="w-full h-24 rounded-xl border border-slate-200 bg-slate-100 flex items-center justify-center text-xs text-slate-400">
                No photo available for this place
              </div>
            )}

            <iframe
              title="Location on Google Maps"
              className="w-full h-48 rounded-xl border border-slate-200 shadow-sm mt-3"
              loading="lazy"
              src={`https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(GOOGLE_MAPS_BROWSER_KEY)}&q=place_id:${encodeURIComponent(place.id)}`}
            />

            <div className="border border-slate-200 rounded-xl p-4 bg-white shadow-sm flex items-start justify-between mt-3">
              <div className="min-w-0">
                <h2 className="text-lg font-serif font-semibold text-slate-900 truncate">{place.name}</h2>
                <p className="text-sm text-slate-500">{place.address}</p>
                {place.editorialSummary && <p className="text-xs text-slate-500 mt-1.5 italic">{place.editorialSummary}</p>}
              </div>
              <div className="text-right shrink-0 ml-4">
                <p className="text-xl font-mono font-semibold text-slate-900">{place.rating ?? "—"}★</p>
                <p className="text-xs text-slate-500">{(place.userRatingCount ?? 0).toLocaleString()} ratings</p>
              </div>
            </div>

            {status === "done" && reviews.length === 0 && (
              <p className="text-sm text-slate-500 mt-4">{ai?.summary || "No reviews to analyze yet."}</p>
            )}

            {status === "done" && reviews.length > 0 && (
              <>
                {/* Verdict seal + score cards */}
                <div className="mt-8 flex flex-col sm:flex-row gap-5 items-start">
                  {combinedVerdict && (
                    <div className="shrink-0 mx-auto sm:mx-0">
                      <div className={`w-28 h-28 rounded-full ${combinedVerdict.bg} ring-4 ${combinedVerdict.ring} flex flex-col items-center justify-center border ${combinedVerdict.border}`}>
                        <combinedVerdict.Icon size={26} className={combinedVerdict.text} />
                        <span className={`text-2xl font-mono font-bold ${combinedVerdict.text} leading-tight mt-0.5`}>{combinedScore}</span>
                      </div>
                      <p className={`text-center text-xs font-semibold mt-2 ${combinedVerdict.text}`}>{combinedVerdict.label}</p>
                    </div>
                  )}
                  <div className="flex-1 w-full grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <ScoreCard label="Heuristic signal" score={heuristic?.score} sub={verdict(heuristic?.score ?? 0).label} />
                    <ScoreCard label="AI read" score={ai?.score} sub={ai?.failed ? "Unavailable" : verdict(ai?.score ?? 0).label} />
                  </div>
                </div>

                <div className="mt-3 space-y-1.5">
                  {result?.cached && <p className="text-xs text-slate-500">Served from cache — no fresh API calls made for this lookup.</p>}
                  {place.userRatingCount > 0 &&
                    (() => {
                      const pct = (reviews.length / place.userRatingCount) * 100;
                      const thin = pct < 5;
                      return (
                        <p className={`text-xs ${thin ? "text-amber-600" : "text-slate-500"}`}>
                          {thin
                            ? `These 5 reviews are just ${pct < 0.1 ? "<0.1" : pct.toFixed(1)}% of ${place.userRatingCount.toLocaleString()} total — treat this score as a loose signal, not a verdict.`
                            : `These 5 reviews cover ${pct.toFixed(0)}% of this place's ${place.userRatingCount.toLocaleString()} total ratings — a meaningfully larger slice than usual.`}
                        </p>
                      );
                    })()}
                </div>

                {place.reviewSummary && (
                  <div className="mt-5 border border-slate-200 rounded-xl p-4 bg-white shadow-sm">
                    <p className="text-[11px] uppercase tracking-widest text-slate-400 font-medium mb-2">Google's review summary</p>
                    <p className="text-sm text-slate-700 leading-relaxed">{place.reviewSummary}</p>
                  </div>
                )}

                {ai && (
                  <div className="mt-4 border border-slate-200 rounded-xl p-4 bg-white shadow-sm">
                    <p className="text-[11px] uppercase tracking-widest text-slate-400 font-medium mb-2 flex items-center gap-1.5">
                      <Sparkles size={13} className="text-amber-500" /> AI analyst notes
                    </p>
                    <p className="text-sm text-slate-800 leading-relaxed">{ai.summary}</p>
                    <p className="text-sm text-slate-500 mt-2 leading-relaxed">{ai.notes}</p>
                  </div>
                )}

                {heuristic && heuristic.flags.length > 0 && (
                  <div className="mt-4 border border-slate-200 rounded-xl p-4 bg-white shadow-sm">
                    <p className="text-[11px] uppercase tracking-widest text-slate-400 font-medium mb-3">Pattern flags</p>
                    <div className="flex flex-wrap gap-2">
                      {heuristic.flags.map((f, i) => (
                        <span key={i} className="flex items-center gap-1.5 text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded-full px-3 py-1">
                          <Flag size={11} /> {f.label}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mt-6">
                  <button onClick={() => setReviewsExpanded((s) => !s)} className="flex items-center gap-2 text-xs uppercase tracking-widest text-slate-500 font-semibold py-1.5 -mx-1 px-1 mb-1">
                    Reviews examined ({reviews.length}) {reviewsExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                  <p className="text-xs text-slate-500 mb-3">Of {(place.userRatingCount ?? 0).toLocaleString()} total ratings on Google — official 5-review cap.</p>
                  {reviewsExpanded && (
                    <div className="space-y-2.5">
                      {reviews.slice(0, reviewDisplayLimit).map((r, i) => {
                        const hFlag = heuristic?.perReview?.[i];
                        const aiFlagged = ai?.suspicious_indices?.includes(i);
                        const flagged = hFlag?.dup || hFlag?.generic || hFlag?.short || aiFlagged;
                        return (
                          <div key={i} className={`border rounded-xl p-4 shadow-sm ${flagged ? "border-rose-200 bg-rose-50/60" : "border-slate-200 bg-white"}`}>
                            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-xs text-slate-500 mb-1.5">
                              <span className="font-medium text-slate-600 min-w-0 truncate">
                                {r.author} · <span className="text-amber-500">{"★".repeat(Math.max(0, r.rating || 0))}</span>
                                {"☆".repeat(Math.max(0, 5 - (r.rating || 0)))}
                              </span>
                              <span className="shrink-0">{r.relativeTime}</span>
                            </div>
                            <p className="text-sm text-slate-800 leading-relaxed">{r.text || <em className="text-slate-400">No written text</em>}</p>
                            {flagged && (
                              <div className="flex flex-wrap gap-1.5 mt-2.5">
                                {hFlag?.dup && <span className="text-[11px] font-medium text-rose-700 bg-rose-100 rounded-full px-2.5 py-0.5">near-duplicate</span>}
                                {hFlag?.generic && <span className="text-[11px] font-medium text-rose-700 bg-rose-100 rounded-full px-2.5 py-0.5">generic phrasing</span>}
                                {hFlag?.short && <span className="text-[11px] font-medium text-rose-700 bg-rose-100 rounded-full px-2.5 py-0.5">very short</span>}
                                {aiFlagged && <span className="text-[11px] font-medium text-rose-700 bg-rose-100 rounded-full px-2.5 py-0.5">AI flagged</span>}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      {reviews.length > reviewDisplayLimit && (
                        <button onClick={() => setReviewDisplayLimit(reviews.length)} className="text-xs font-semibold text-amber-600 underline py-2 px-1 -mx-1">
                          Show all {reviews.length} reviews
                        </button>
                      )}
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
