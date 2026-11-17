# Golf Scores — setup guide

A small web app for logging golf rounds, with sign-in, private per-person data,
and scorecard photo reading through the Claude API.

- **Hosting + photo function:** Vercel (free Hobby plan)
- **Sign-in + database:** Supabase (free plan)
- **Photo reading:** Anthropic Claude API (pay per use, your key)

Plan for about 20–30 minutes. You'll need three accounts: Supabase, Vercel and Anthropic.

---

## 1. Create the database (Supabase)

1. Sign up at <https://supabase.com> and create a **new project**. Pick a region near you and save the database password somewhere safe.
2. When it's ready, open **SQL Editor → New query**, paste the whole contents of `supabase/schema.sql`, and click **Run**. You should see "Success".
3. Make it invite-only: open **Authentication → Sign In / Providers** (called "Providers" in some versions) and turn **off** "Allow new users to sign up". Leave the **Email** provider on.
4. Copy two values from **Project Settings → API** (or **API Keys**):
   - **Project URL** (looks like `https://abcd1234.supabase.co`)
   - **anon / public key**. Newer projects call this the "publishable" key. If the app can't sign you in with it, use the key under the **Legacy API keys** tab instead.

   Never use the `service_role` or "secret" key in this app.

## 2. Get a Claude API key (Anthropic)

1. Sign up at <https://console.anthropic.com>.
2. Add a small amount of credit under **Billing**. A scorecard read typically costs a few cents or less.
3. Create a key under **API Keys** and copy it (it starts with `sk-ant-`). You can only see it once.

Tip: set a monthly spend limit in the console as a backstop.

## 3. Deploy the app (Vercel)

**Option A: from GitHub (easiest to update later)**
1. Put this folder in a new GitHub repository.
2. At <https://vercel.com>, choose **Add New → Project** and import the repository. Leave the framework as **Other**. Don't deploy yet.
3. Under **Environment Variables**, add:

| Name | Value |
|---|---|
| `SUPABASE_URL` | your Project URL |
| `SUPABASE_ANON_KEY` | your anon / publishable key |
| `ANTHROPIC_API_KEY` | your `sk-ant-…` key |
| `DAILY_PHOTO_LIMIT` | optional, default `10` (photo reads per person per 24 hours) |
| `ANTHROPIC_MODEL` | optional, default `claude-sonnet-5-5` |

4. Click **Deploy**. Note your site address, e.g. `https://golf-scores.vercel.app`.

**Option B: from your computer**
Install Node.js, then in this folder run `npx vercel`, follow the prompts, add the same variables under the project's **Settings → Environment Variables**, and run `npx vercel --prod`.

If you add or change variables after deploying, redeploy (Deployments → ⋯ → Redeploy) for them to take effect.

## 4. Connect sign-in links to your site (Supabase)

In **Authentication → URL Configuration**:
- **Site URL:** your Vercel address, e.g. `https://golf-scores.vercel.app`
- **Redirect URLs:** add the same address.

Without this, the sign-in links in emails will point to the wrong place.

## 5. Invite people

In Supabase, open **Authentication → Users → Add user → Send invitation**, and enter each person's email (including your own).
They get an email, click it, and land in the app signed in. Next time they enter their email on the sign-in screen to get a fresh link.

To remove someone: **Authentication → Users**, then delete the user. Their rounds are deleted with them.

## 6. Add it to your phone's home screen

Open the site in Safari (iPhone) or Chrome (Android) and choose **Share → Add to Home Screen** (or **Install app**). It opens full-screen like a regular app.

---

## How privacy and limits work

- Each person can only see and change their own rounds. This is enforced by the database's row-level security rules in `schema.sql`, not just by the page.
- The Claude API key lives only on the server (`api/read-scorecard.js`); browsers never see it.
- Each person gets `DAILY_PHOTO_LIMIT` photo reads per rolling 24 hours. Typing scores by hand is unlimited.

## Good to know

- **Sign-in emails:** Supabase's built-in email service sends only a few emails per hour. That's fine for a handful of people. For more, connect your own email provider under **Authentication → Emails → SMTP Settings**.
- **Free-plan pausing:** Supabase pauses free projects after about a week without activity. Open the dashboard and click **Restore** if that happens; no data is lost.
- **Rounds from the Claude version** don't move over automatically. Export them as CSV there first if you want to keep them.

## Project layout

```
public/index.html          the app (one page)
public/manifest.webmanifest, icon*  home-screen app details
api/config.js              gives the page its public Supabase settings
api/read-scorecard.js      checks sign-in and limit, sends the photo to Claude
api/_lib/prompt.js         instructions Claude gets with each photo
supabase/schema.sql        database tables and privacy rules
vercel.json                hosting settings
```
