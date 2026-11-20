// Lets a signed-in person ask Claude about their own scores.
// 1. Checks the caller is signed in (their Supabase session token).
// 2. Enforces a per-person limit on messages in the last 24 hours.
// 3. Loads that person's rounds with their own token (row-level security means only theirs).
// 4. Sends the rounds and the recent conversation to Claude and returns the reply.

const MAX_MESSAGES = 12;      // recent turns sent to Claude
const MAX_CHARS = 2000;       // per message
const THEMES = new Set(["agent", "clubhouse", "baby"]);

// The voice is part of the theme: commit to it in every reply. Numbers and facts stay exact.
const TONES = {
  agent: (codename) => `Voice: you are HQ, a cold, clipped intelligence handler debriefing a field operative. Address them as ${codename ? `Agent ${codename}` : "Agent"}. Fully commit to the spy framing in every reply: rounds are missions or operations, courses are the field or the target site, holes are objectives, bad holes are compromised objectives, birdies are clean kills, the scorecard is the dossier or the file. Short, terse sentences. Dry, faintly menacing professionalism. Occasionally open with a status line like "Debrief follows." or close with an order like "Report back after your next operation." Never break character, never use emoji.`,
  baby: () => `Voice: you are a sweet, gushing helper talking to a little baby golfer, matching the app's baby theme. Fully commit in every reply: baby talk ("wittle", "tummy-time", "itty-bitty", "big boy/big girl"), lots of praise, gentle cooing, and a few emoji like 🍼 🧸 💕 ⭐. Treat every bad score as a brave try and every good one as a huge milestone. Teasing must stay affectionate, never mean. The numbers you give must still be correct.`,
  clubhouse: () => `Voice: you are the head professional at an old private members' club, speaking to a member. Fully commit in every reply: polished, dry, quietly confident, with a touch of old-club formality ("I'd suggest", "a respectable effort", "the back nine was less kind to you"). Understated wit, never gushing, no exclamation marks, no emoji, no golf-pun clichés.`,
};

function fail(res, status, code, message) {
  res.status(status).json({ error: message, code });
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

async function getUser(supabaseUrl, anonKey, token) {
  const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? u : null;
}

async function countRecentMessages(supabaseUrl, anonKey, token) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const r = await fetch(
    `${supabaseUrl}/rest/v1/chat_messages?select=id&created_at=gte.${encodeURIComponent(since)}`,
    { headers: { apikey: anonKey, Authorization: `Bearer ${token}`, Prefer: "count=exact", Range: "0-0" } },
  );
  if (!r.ok) throw new Error(`count failed: ${r.status}`);
  const total = Number((r.headers.get("content-range") || "").split("/")[1]);
  return Number.isFinite(total) ? total : 0;
}

async function logMessage(supabaseUrl, anonKey, token) {
  const r = await fetch(`${supabaseUrl}/rest/v1/chat_messages`, {
    method: "POST",
    headers: { apikey: anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: "{}",
  });
  if (!r.ok) throw new Error(`log failed: ${r.status}`);
}

async function loadRounds(supabaseUrl, anonKey, token) {
  const cols = "played_on,course,tees,holes,score,rating,slope,putts,hole_scores,pars,yardages";
  const r = await fetch(`${supabaseUrl}/rest/v1/rounds?select=${cols}&order=played_on.asc&limit=500`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`rounds failed: ${r.status}`);
  return r.json();
}

function describeRounds(rounds) {
  if (!rounds.length) return "This player has no rounds logged yet.";
  const arr = (a) => (Array.isArray(a) ? a.map(v => (v == null ? "-" : v)).join(" ") : "-");
  const lines = rounds.map(r => [
    r.played_on,
    `${r.course}${r.tees ? ` (${r.tees} tees)` : ""}`,
    `${r.holes} holes`,
    `score ${r.score}`,
    `rating ${r.rating ?? "-"}`,
    `slope ${r.slope ?? "-"}`,
    `putts ${r.putts ?? "-"}`,
    `hole scores ${arr(r.hole_scores)}`,
    `pars ${arr(r.pars)}`,
    `yards ${arr(r.yardages)}`,
  ].join(" | "));
  return `This player's rounds, oldest first (${rounds.length} total; "-" means not recorded):\n${lines.join("\n")}`;
}

function systemPrompt(rounds, theme, codename) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: process.env.APP_TIMEZONE || "America/Los_Angeles" });
  return [
    "You are the assistant inside a small golf score-tracking app used by a few friends. You talk with one signed-in player about their own golf scores.",
    `Today's date is ${today}.`,
    "Answer from the round data below. Do arithmetic carefully. If the data doesn't contain what's needed (for example no course rating or slope, or no hole-by-hole scores), say so plainly instead of guessing.",
    "The app's handicap index follows the World Handicap System and only counts 18-hole rounds that have both a course rating and slope.",
    "You can only see this player's rounds, not anyone else's.",
    "Keep answers short: usually 2 to 5 sentences, or a short list when comparing things. Plain text only, no headings or tables.",
    "Stay in the voice below for the whole conversation, including when giving bad news or saying the data can't answer something.",
    (TONES[theme] || TONES.clubhouse)(codename),
    "",
    describeRounds(rounds),
  ].join("\n");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return fail(res, 405, "method_not_allowed", "Use POST.");

  const { SUPABASE_URL, SUPABASE_ANON_KEY, ANTHROPIC_API_KEY } = process.env;
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
  const limit = Number(process.env.DAILY_CHAT_LIMIT) || 50;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return fail(res, 500, "not_configured", "Server is missing Supabase settings.");
  if (!ANTHROPIC_API_KEY) return fail(res, 503, "chat_off", "Chat isn't set up on this server.");

  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return fail(res, 401, "unauthorized", "Sign in to chat.");
  let user;
  try { user = await getUser(SUPABASE_URL, SUPABASE_ANON_KEY, token); } catch { user = null; }
  if (!user) return fail(res, 401, "unauthorized", "Your sign-in has expired. Sign in again.");

  // Validate the conversation.
  const body = typeof req.body === "string" ? safeJson(req.body) : req.body;
  const raw = body && Array.isArray(body.messages) ? body.messages.slice(-MAX_MESSAGES) : null;
  const messages = raw && raw
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
  while (messages && messages.length && messages[0].role !== "user") messages.shift();
  if (!messages || !messages.length || messages[messages.length - 1].role !== "user") return fail(res, 400, "bad_request", "Send a message.");
  const theme = THEMES.has(body.theme) ? body.theme : "clubhouse";
  const codename = typeof body.codename === "string" ? body.codename.replace(/[^A-Za-z ]/g, "").slice(0, 20) : "";

  // Daily limit.
  try {
    const used = await countRecentMessages(SUPABASE_URL, SUPABASE_ANON_KEY, token);
    if (used >= limit) return fail(res, 429, "daily_limit", `You've used all ${limit} messages for the last 24 hours. Try again tomorrow.`);
    await logMessage(SUPABASE_URL, SUPABASE_ANON_KEY, token);
  } catch (e) {
    console.error("chat limit check", e);
    return fail(res, 500, "limit_check_failed", "Couldn't check your message limit. Try again.");
  }

  let rounds;
  try { rounds = await loadRounds(SUPABASE_URL, SUPABASE_ANON_KEY, token); }
  catch (e) { console.error("chat rounds", e); return fail(res, 500, "rounds_failed", "Couldn't load your rounds. Try again."); }

  // Ask Claude with streaming on, and pass the reply text through as it arrives.
  // Response body is newline-delimited JSON: {"t":"text chunk"} lines, then {"done":true} or {"error":"..."}.
  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 16000, stream: true, system: systemPrompt(rounds, theme, codename), messages }),
    });
  } catch (e) {
    console.error("anthropic fetch", e);
    return fail(res, 502, "upstream_error", "Couldn't get an answer. Try again.");
  }
  if (!upstream.ok || !upstream.body) {
    const data = await upstream.json().catch(() => null);
    console.error("anthropic error", upstream.status, data);
    if (upstream.status === 429 || upstream.status === 529) return fail(res, 503, "busy", "Claude is busy right now. Try again in a minute.");
    return fail(res, 502, "upstream_error", "Couldn't get an answer. Try again.");
  }

  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  let sentText = false, failed = false;
  try {
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf("\n\n")) !== -1) {
        const event = buf.slice(0, cut); buf = buf.slice(cut + 2);
        const line = event.split("\n").find(l => l.startsWith("data:"));
        if (!line) continue;
        let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
        if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta" && ev.delta.text) {
          send({ t: ev.delta.text }); sentText = true;
        } else if (ev.type === "message_delta" && ev.delta && ev.delta.stop_reason === "max_tokens") {
          console.warn("chat reply cut off at max_tokens");
        } else if (ev.type === "error") {
          console.error("anthropic stream error", ev.error);
          failed = true;
        }
      }
    }
  } catch (e) {
    console.error("anthropic stream", e);
    failed = true;
  }
  if (failed || !sentText) send({ error: sentText ? "The answer was cut off. Try again." : "Couldn't get an answer. Try again." });
  else send({ done: true });
  res.end();
}
