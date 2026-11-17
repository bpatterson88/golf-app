// Public settings the page needs to start. The Supabase anon key is meant to be public;
// row-level security in the database is what protects each person's data.
export default function handler(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) {
    res.status(500).json({ error: "Server is missing SUPABASE_URL or SUPABASE_ANON_KEY." });
    return;
  }
  res.setHeader("Cache-Control", "public, max-age=300");
  res.status(200).json({
    supabaseUrl,
    supabaseAnonKey,
    dailyPhotoLimit: Number(process.env.DAILY_PHOTO_LIMIT) || 10,
    photoReading: Boolean(process.env.ANTHROPIC_API_KEY),
  });
}
