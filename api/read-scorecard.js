// Reads a scorecard photo with the Claude API.
// 1. Checks the caller is signed in (their Supabase session token).
// 2. Enforces a per-person limit on photo reads in the last 24 hours.
// 3. Sends the photo to Claude and returns the scores as JSON.
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
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
            { type: "text", text: buildPrompt(body.hint) },
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
  res.status(200).json({ result });
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}
