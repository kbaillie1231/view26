# view26

View Program Browser 2026: a fast, phone-first way to browse the
[VIEW Conference 2026](https://www.viewconference.it) program (Turin, 12-16 October).
Live at **https://viewprogram.app**.

- Day tabs that open on today, sessions grouped by start time, Live and Next badges, and a "Now" button
- Search across every day (titles, speakers, studios, descriptions; accents don't matter)
- Filters for subject, speaker, format and room, with live counts
- Star sessions into "My picks" (saved on the device, no login) with overlap warnings
- Add a session to your calendar or share a link to it
- Works offline after the first visit and can be added to the home screen

It's a static site with no framework, no build step and no backend.

## How the data stays current

`.github/workflows/fetch-program.yml` runs every 20 minutes from about 07:00 to
22:50 Turin time, 12-16 October (and on demand from the Actions tab):

1. Downloads the official program page (`viewconference.it/assets/html/view_CET.html`).
2. `scripts/fetch-articles.mjs` fetches descriptions and speaker photos for any
   new session pages (all of them once a day). This step is optional: if the
   article pages are slow or down, the program is still updated.
3. `scripts/parse-program.mjs` writes `site/data/program.json` and one `.ics`
   file per session in `site/ics/`. It stops without writing anything if the
   page looks truncated or broken, or if the session count suddenly drops by
   more than 20% (a manual run accepts that), so a bad fetch can't break the site.
   Session ids are carried over from the previous run so people's starred
   sessions survive title edits.
4. Commits the result if anything changed. Netlify redeploys on the push.

The open app also re-checks the program every few minutes and when it comes
back to the foreground, so room changes reach people without a reload.

GitHub only runs scheduled workflows on the default branch, so the schedule
starts once this is on `main`. GitHub can also delay scheduled runs at busy times.
To force an update, open **Actions → Update program → Run workflow**.

## Deploying on Netlify

1. In Netlify: **Add new project → Import an existing project → GitHub** and pick this repository.
2. Choose the `main` branch. `netlify.toml` already sets the publish directory (`site`) and no build command.
3. Deploy. Every push (including the automatic program updates) redeploys.

## Working on it locally

```sh
npm ci
npm run parse    # rebuild site/data/program.json from data/source/view_CET.html
npm run serve    # http://localhost:8080
```

Add `?now=2026-10-14T11:40` to the URL to preview the Live/Next state at any time.

When you change `site/app.js` or `site/styles.css`, bump their `?v=` in
`site/index.html` and in `site/sw.js` (and `VERSION` there), so installed copies
pick up the new code on their next launch.
