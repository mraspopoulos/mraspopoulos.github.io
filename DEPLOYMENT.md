# Deployment guide

Complete walkthrough for moving from the Jekyll/AcademicPages site to this Astro setup on GitHub Pages. Allow ~30 minutes the first time.

## Before you start: back up the old site

On GitHub, go to `https://github.com/mraspopoulos/mraspopoulos.github.io/settings`. Rename the repository to `mraspopoulos.github.io-jekyll-backup`. This frees up the name `mraspopoulos.github.io` for the new repo and preserves the old one. The old site will be briefly down during the cut-over.

## 1. Install Node.js

Download the LTS version from `https://nodejs.org` and run the installer. Verify with `node --version` in a terminal — you should see v20.x or v22.x.

## 2. Unzip and open the project

Unzip the archive. In a terminal, navigate to the `site` folder:

    cd ~/Desktop/site

## 3. Preview locally

    npm install
    npm run dev

Open `http://localhost:4321/` and click through the site. Edit content if needed — the dev server auto-reloads. Press Ctrl+C to stop.

## 4. Initialise git

    git init
    git add .
    git commit -m "Initial commit: new Astro site"
    git branch -M main

If git asks for identity:

    git config --global user.email "mraspopoulos@uclan.ac.uk"
    git config --global user.name "Marios Raspopoulos"

## 5. Create the GitHub repo and push

At `https://github.com/new`, create a public repo named exactly `mraspopoulos.github.io`. Do NOT initialise with a README, .gitignore, or license. Then:

    git remote add origin https://github.com/mraspopoulos/mraspopoulos.github.io.git
    git push -u origin main

## 6. Enable GitHub Pages with the Actions source

In the new repo: Settings → Pages → Source → **GitHub Actions**. This is the only setting that matters; pick GitHub Actions from the dropdown.

## 7. Watch the first build

Actions tab → "Build and deploy". Takes about a minute. When green, visit `https://mraspopoulos.github.io` and hard-refresh (Ctrl/Cmd+Shift+R).

## 8. Trigger the first stats fetch

Actions tab → "Refresh OpenAlex stats" → Run workflow. After it finishes (~20 s), a new commit appears with your real numbers and the site rebuilds automatically. Real stats appear on the live site in about 90 seconds.

If numbers look off, request corrections at the [OpenAlex author correction form](https://help.openalex.org/hc/en-us/articles/14346015925783).

## Day-to-day updates

Edit a file (e.g. `src/content/publications/2026-new-paper.md`), then:

    git add .
    git commit -m "Add new publication"
    git push

Change is live in ~60 seconds. Or edit directly on GitHub in the browser — same effect.

## Rollback

Every commit is a savepoint. On GitHub, find a known-good commit in the history and click "Revert". Or locally, `git revert HEAD`.

## Common issues

**Site shows 404 after deploy.** Action probably failed — check the Actions tab.

**Site shows the old Jekyll content.** Browser cache; hard-refresh, or wait 5 minutes for GitHub's CDN.

**`npm install` fails with version errors.** Check `node --version` — needs to be 20 or higher.

**Photos don't show after pushing.** Filenames are case-sensitive on Linux (where GitHub builds), so `Photo.jpg` and `photo.jpg` are different files. Match the case exactly to what the `Hero.astro` references.

**Custom domain.** See the "Domain" section in `README.md` — three lines of config and a DNS record.
