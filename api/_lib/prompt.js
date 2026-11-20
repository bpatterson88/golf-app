// The instructions sent to Claude with each scorecard photo.
// roster: { me: "Ben", others: ["Tim", "Andrew", "Max"], aliases: { Ben: ["B"], ... }, learned: { "tc": "Tim", ... } }
export function buildPrompt(roster) {
  const clean = (s) => String(s || "").replace(/["\n\r]/g, "'").slice(0, 60).trim();
  const me = clean(roster && roster.me);
  const others = ((roster && roster.others) || []).map(clean).filter(Boolean);
  const aliases = (roster && roster.aliases) || {};
  const learned = (roster && roster.learned) || {};
  const describe = (name) => {
    const a = (aliases[name] || []).map(clean).filter(Boolean);
    return a.length ? `${name} (also written as: ${a.join(", ")})` : name;
  };
  const learnedLines = Object.entries(learned).slice(0, 60).map(([label, name]) => `"${clean(label)}" = ${clean(name)}`);
  const rosterText = [
    `- The person who uploaded this photo${me ? ` is ${describe(me)}` : ""}. Use "Me" for their row.`,
    others.length ? `- Other players who use this app: ${others.map(describe).join("; ")}.` : "- No other players use this app.",
    learnedLines.length ? `- Row labels confirmed on earlier cards: ${learnedLines.join("; ")}. These are strong evidence.` : "",
  ].filter(Boolean).join("\n");

  return `You are reading a photo of a golf scorecard that may have several players on it. Return ONLY a JSON object, no other text, with these keys:
{"holes_played": 9 or 18, "pars": [integer or null, one per hole played, from the printed Par row] or null, "yardages": [integer or null, one per hole played, from the printed yardage row for the tees played] or null, "course_name": string or null, "date": "YYYY-MM-DD" or null, "tees": string or null, "course_rating": number or null, "slope_rating": integer or null,
 "players": [{"label": string, "hole_scores": [integer or null, one per hole played, in hole order], "total_score": integer or null, "putts": integer or null, "guess": string or null}]}
Who is on the card:
${rosterText}
Rules:
- players: one entry per player row that has at least one score written in, top to bottom. Skip printed rows like Hole, Par, Handicap/HCP and Yardage.
- label: the name or initials written beside that row, exactly as written. If nothing is written, use "Row 1", "Row 2" and so on by position.
- guess: which app player this row belongs to. Use "Me" for the uploader, or exactly one of the other players' names listed above. Match on names, nicknames, initials and the confirmed labels. Use null when the label doesn't clearly match anyone, for example a guest. Never use the same guess for two rows.
- holes_played: 9 if scores are written for only 9 holes (front or back nine, or a 9-hole course), 18 if written for 18 holes.
- hole_scores: that player's score on each hole, read carefully digit by digit; null for a hole you can't read. If only the back nine was played, list holes 10-18.
- total_score: that player's total for the holes played. Use a written total (e.g. in a 9TOT, OUT, IN or 18TOT column) if present; otherwise add the hole scores. Handwriting may be messy: check the written total against the sum of hole scores and prefer the sum if they clearly disagree.
- yardages: hole lengths in yards from the printed yardage row for the tee set played (rows are often named by tee color, like Blue, White or Red). If there are several yardage rows and you can't tell which tees were played, use the row whose name matches "tees"; if that's unclear too, use null. Convert meters to yards only if the card is clearly in meters (multiply by 1.094 and round). Never put the total (OUT, IN or TOT) in the per-hole list.
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
