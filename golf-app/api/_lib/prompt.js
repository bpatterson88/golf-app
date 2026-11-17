// The instructions sent to Claude with each scorecard photo.
export function buildPrompt(hint) {
  const clean = String(hint || "").slice(0, 120).replace(/"/g, "'").trim();
  const who = clean
    ? `The player says their scores are in this row: "${clean}". Use that row (match it to the initials or names written beside the rows, or the row position).`
    : `If several players are on the card, use the first player row that has scores written in.`;
  return `You are reading a photo of a golf scorecard. Return ONLY a JSON object, no other text, with these keys:
{"holes_played": 9 or 18, "hole_scores": [integer or null, one per hole played, in hole order], "pars": [integer or null, one per hole played, from the printed Par row] or null, "total_score": integer or null, "player_row_found": true or false, "course_name": string or null, "date": "YYYY-MM-DD" or null, "tees": string or null, "course_rating": number or null, "slope_rating": integer or null, "putts": integer or null}
Rules:
- ${who}
- holes_played: 9 if scores are written for only 9 holes (front or back nine, or a 9-hole course), 18 if written for 18 holes.
- hole_scores: that player's score on each hole, read carefully digit by digit; null for a hole you can't read. If only the back nine was played, list holes 10-18.
- total_score: that player's total for the holes played. Use a written total (e.g. in a 9TOT, OUT, IN or 18TOT column) if present; otherwise add the hole scores. Handwriting may be messy: check the written total against the sum of hole scores and prefer the sum if they clearly disagree.
- player_row_found: false if you could not find the row the player described.
- tees, course_rating and slope_rating: only if printed for the tee set played. Rating looks like 27.0-76.0 and slope like 55-155. Many short or par-3 courses print no rating or slope: then use null.
- putts only if a putts row is filled in for that player.
- Use null for anything not legible. Never guess a course name or date that isn't written on the card.`;
}

// Pull the JSON object out of Claude's reply, tolerating a sentence or a code fence around it.
export function parseReply(text) {
  if (typeof text !== "string") return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const start = body.indexOf("{"), end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(body.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
