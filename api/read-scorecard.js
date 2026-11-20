// Reads a scorecard photo with the Claude API.
// 1. Checks the caller is signed in (their Supabase session token).
// 2. Enforces a per-person limit on photo reads in the last 24 hours.
// 3. Loads the player list and previously confirmed row labels, so Claude can guess who each row belongs to.
// 4. Sends the photo to Claude and returns every player row with a suggested app user per row.
// The Anthropic API key stays on the server and is never sent to the browser.
import { buildPrompt, parseReply } from "./_lib/prompt.js";

const MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Claude API per-image limit

function fail(res, status, code, message) {
  res.status(status).json({ error: message, code });
}

async function getUser(supabaseUrl, anonKey, token) {
  const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? u : null;
}

// Counts this person's photo reads in the last 24 hours, using their own token
// (row-level security limits the count to their rows).
async function countRecentReads(supabaseUrl, anonKey, token) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const r = await fetch(
    `${supabaseUrl}/rest/v1/photo_reads?select=id&created_at=gte.${encodeURIComponent(since)}`,
    { headers: { apikey: anonKey, Authorization: `Bearer ${token}`, Prefer: "count=exact", Range: "0-0" } },
  );
  if (!r.ok) throw new Error(`count failed: ${r.status}`);
  const range = r.headers.get("content-range") || "";
  const total = Number(range.split("/")[1]);
  return Number.isFinite(total) ? total : 0;
}

async function logRead(supabaseUrl, anonKey, token) {
  const r = await fetch(`${supabaseUrl}/rest/v1/photo_reads`, {
    method: "POST",
    headers: { apikey: anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: "{}",
  });
  if (!r.ok) throw new Error(`log failed: ${r.status}`);
}

// Reads a table the signed-in person can see. Returns [] if it doesn't exist yet or fails,
// so photo reading still works before the tagging tables are set up.
async function readTable(supabaseUrl, anonKey, token, path) {
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/${path}`, { headers: { apikey: anonKey, Authorization: `Bearer ${token}` } });
    if (!r.ok) return [];
    const v = await r.json();
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

export const normLabel = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 40);

// Learned labels: for each label, the user most often confirmed for it (ties go to the most recent).
export function learnedMap(labels) {
  const by = new Map();
  for (const l of labels) {
    const key = `${l.label}\u0000${l.user_id}`;
    const cur = by.get(key) || { label: l.label, user_id: l.user_id, n: 0, at: "" };
    cur.n++; if ((l.updated_at || "") > cur.at) cur.at = l.updated_at || "";
    by.set(key, cur);
  }
  const best = new Map();
  for (const v of by.values()) {
    const b = best.get(v.label);
    if (!b || v.n > b.n || (v.n === b.n && v.at > b.at)) best.set(v.label, v);
  }
  return new Map([...best].map(([label, v]) => [label, v.user_id]));
}

// Turn Claude's per-row guesses into user ids. A confirmed label beats Claude's guess.
// Each user ends up on at most one row.
export function assignRows(rows, { meId, players, learned }) {
  const byName = new Map(players.map(p => [String(p.name).toLowerCase(), p.user_id]));
  const known = new Set(players.map(p => p.user_id)); known.add(meId);
  const taken = new Set();
  const pick = rows.map(r => {
    const fromLabel = learned.get(normLabel(r.label));
    if (fromLabel && known.has(fromLabel)) return { id: fromLabel, source: "learned" };
    const g = typeof r.guess === "string" ? r.guess.trim().toLowerCase() : "";
    if (g === "me") return { id: meId, source: "claude" };
    if (g && byName.has(g)) return { id: byName.get(g), source: "claude" };
    return { id: null, source: null };
  });
  // Learned matches claim their user first, then Claude's guesses in row order.
  for (const pass of ["learned", "claude"]) {
    pick.forEach((p) => {
      if (p.source !== pass || !p.id) return;
      if (taken.has(p.id)) { p.id = null; p.source = null; } else taken.add(p.id);
    });
  }
  return pick;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return fail(res, 405, "method_not_allowed", "Use POST.");

  const { SUPABASE_URL, SUPABASE_ANON_KEY, ANTHROPIC_API_KEY } = process.env;
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
  const limit = Number(process.env.DAILY_PHOTO_LIMIT) || 10;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return fail(res, 500, "not_configured", "Server is missing Supabase settings.");
  if (!ANTHROPIC_API_KEY) return fail(res, 503, "photo_reading_off", "Photo reading isn't set up on this server.");

  // Who is asking?
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return fail(res, 401, "unauthorized", "Sign in to read scorecards.");
  let user;
  try { user = await getUser(SUPABASE_URL, SUPABASE_ANON_KEY, token); } catch { user = null; }
  if (!user) return fail(res, 401, "unauthorized", "Your sign-in has expired. Sign in again.");

  // Validate the photo.
  const body = typeof req.body === "string" ? safeJson(req.body) : req.body;
  const image = body && body.image;
  const mediaType = body && body.mediaType;
  if (typeof image !== "string" || !MEDIA_TYPES.has(mediaType)) return fail(res, 400, "bad_image", "Send a JPEG, PNG, WebP or GIF photo.");
  if (Math.floor(image.length * 3 / 4) > MAX_IMAGE_BYTES) return fail(res, 413, "image_too_large", "That photo is too large. Try a smaller one.");

  // Daily limit.
  try {
    const used = await countRecentReads(SUPABASE_URL, SUPABASE_ANON_KEY, token);
    if (used >= limit) return fail(res, 429, "daily_limit", `You've used all ${limit} photo reads for the last 24 hours. Enter the score by hand, or try again tomorrow.`);
    await logRead(SUPABASE_URL, SUPABASE_ANON_KEY, token);
  } catch (e) {
    console.error("limit check", e);
    return fail(res, 500, "limit_check_failed", "Couldn't check your photo-read limit. Try again.");
  }

  // Who could be on the card.
  const [players, labels] = await Promise.all([
    readTable(SUPABASE_URL, SUPABASE_ANON_KEY, token, "players?select=user_id,name,aliases"),
    readTable(SUPABASE_URL, SUPABASE_ANON_KEY, token, "row_labels?select=label,user_id,updated_at&limit=2000"),
  ]);
  const meRow = players.find(p => p.user_id === user.id);
  const nameOf = new Map(players.map(p => [p.user_id, p.name]));
  nameOf.set(user.id, "Me");
  const learned = learnedMap(labels);
  const roster = {
    me: meRow ? meRow.name : "",
    others: players.filter(p => p.user_id !== user.id).map(p => p.name),
    aliases: Object.fromEntries(players.map(p => [p.name, Array.isArray(p.aliases) ? p.aliases : []])),
    learned: Object.fromEntries([...learned].filter(([, id]) => nameOf.has(id)).map(([label, id]) => [label, nameOf.get(id)])),
  };

  // Ask Claude.
  let reply;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 16000,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
            { type: "text", text: buildPrompt(roster) },
          ],
        }],
      }),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      console.error("anthropic error", r.status, data);
      if (r.status === 429 || r.status === 529) return fail(res, 503, "busy", "Photo reading is busy right now. Try again in a minute.");
      if (r.status === 400) return fail(res, 400, "bad_image", "That photo couldn't be read. Try a different photo.");
      return fail(res, 502, "upstream_error", "Photo reading failed. Try again.");
    }
    reply = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  } catch (e) {
    console.error("anthropic fetch", e);
    return fail(res, 502, "upstream_error", "Photo reading failed. Try again.");
  }

  const result = parseReply(reply);
  if (!result) return fail(res, 502, "unreadable_reply", "Couldn't understand the reading. Try the photo again.");
  // Clean up the rows and attach a suggested user to each.
  const holes = result.holes_played === 9 ? 9 : 18;
  const ints = (a) => (Array.isArray(a) ? a.slice(0, holes).map(v => (Number.isInteger(v) && v > 0 && v < 30 ? v : null)) : null);
  const rows = (Array.isArray(result.players) ? result.players : [])
    .filter(p => p && typeof p === "object")
    .slice(0, 8)
    .map((p, i) => ({
      label: (typeof p.label === "string" && p.label.trim() ? p.label.trim() : `Row ${i + 1}`).slice(0, 40),
      hole_scores: ints(p.hole_scores),
      total_score: Number.isInteger(p.total_score) ? p.total_score : null,
      putts: Number.isInteger(p.putts) ? p.putts : null,
      guess: p.guess,
    }))
    .filter(r => (r.hole_scores && r.hole_scores.some(v => v != null)) || r.total_score != null);
  // Every yardage row on the card. The app picks one by the tees played, or asks.
  const toInt = (v) => (typeof v === "string" ? parseInt(v.replace(/[^\d]/g, ""), 10) : v);
  const toNum = (v) => { const n = typeof v === "string" ? parseFloat(v) : v; return Number.isFinite(n) ? n : null; };
  result.tee_sets = (Array.isArray(result.tee_sets) ? result.tee_sets : [])
    .filter(t => t && typeof t === "object")
    .slice(0, 8)
    .map((t, i) => {
      const yd = Array.isArray(t.yardages) ? t.yardages.slice(0, holes).map(v => { const n = toInt(v); return Number.isInteger(n) && n >= 40 && n <= 750 ? n : null; }) : [];
      const rating = toNum(t.course_rating), slope = toInt(t.slope_rating);
      return {
        name: (typeof t.name === "string" && t.name.trim() ? t.name.trim() : `Tees ${i + 1}`).slice(0, 30),
        yardages: yd.some(v => v != null) ? yd : null,
        course_rating: rating != null && rating >= 20 && rating <= 85 ? rating : null,
        slope_rating: Number.isInteger(slope) && slope >= 55 && slope <= 155 ? slope : null,
      };
    })
    .filter(t => t.yardages);
  const teeName = typeof result.tees === "string" ? result.tees.trim().toLowerCase() : "";
  const played = (teeName && result.tee_sets.find(t => t.name.toLowerCase() === teeName))
    || (result.tee_sets.length === 1 ? result.tee_sets[0] : null);
  result.yardages = played ? played.yardages : null;
  const picks = assignRows(rows, { meId: user.id, players, learned });
  result.players = rows.map((r, i) => ({ label: r.label, hole_scores: r.hole_scores, total_score: r.total_score, putts: r.putts, user_id: picks[i].id, matched_by: picks[i].source }));
  res.status(200).json({ result });
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}
