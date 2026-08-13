# Bar Daily Report

Nightly reporting portal for venue managers: enter the night's figures, see wage
and revenue percentages calculate live, and get flagged against that venue's
forecast before submitting.

Sign-in with a work Google account is required. Access is enforced server-side.

## Structure

```
index.html          the form
assets/styles.css   light + dark theme
assets/config.js    venues, flag bands, endpoint    <- normally the only file to edit
assets/app.js       calculations, forecast flags, uploads, validation
```

Static site — no build step, no dependencies. Served from GitHub Pages.

## Local development

```bash
npx serve .    # or any static file server
```

Set `auth.enabled = false` in `assets/config.js` to bypass the sign-in gate
locally. Never deploy with it off.

Backend configuration, deployment and operational notes are kept separately and
are not published here.
