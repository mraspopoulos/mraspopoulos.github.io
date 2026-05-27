# mraspopoulos.github.io

Personal academic website built with [Astro](https://astro.build/), deployed to GitHub Pages, with auto-refreshed citation stats from [OpenAlex](https://openalex.org/).

**Already populated** from the legacy site: 51 publications (2005–2026), 22 research projects, teaching across UCLan Cyprus / OUC / Surrey, full CV with work history, your headshot, and 30+ paper PDFs. You can start editing immediately — none of it is placeholder.

---

## Quick start

```bash
npm install
npm run dev          # local preview at http://localhost:4321
npm run build        # output to dist/
npm run update-stats # manually refresh src/data/stats.json from OpenAlex
```

You need Node.js 20+ installed (free download from [nodejs.org](https://nodejs.org/)).

---

## Deploy

The repo is set up to deploy automatically to GitHub Pages on every push to `main`.

**One-time setup in your GitHub repo:**

1. Push this code to a repo named `mraspopoulos.github.io` on your account.
2. Go to **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **GitHub Actions** (not the default "Deploy from a branch").
4. Push any change to `main`. The "Build and deploy" workflow under the Actions tab will build and publish the site.

The site will be live at <https://mraspopoulos.github.io>.

---

## Updating content

All content lives in plain Markdown files. Edit a file, commit, and the site rebuilds.

### Add a news item

Create a new file in `src/content/news/`, e.g. `2026-06-keynote.md`:

```markdown
---
date: 2026-06-15
title: Invited keynote at IPIN 2026
link: https://ipin-conference.org/2026/
---
Delivered an invited keynote at IPIN 2026 on RIS-aided indoor positioning.
```

### Add a publication

Create a new file in `src/content/publications/`, e.g. `2026-globecom.md`:

```markdown
---
title: 'Your paper title here'
authors: 'Smith J., Raspopoulos M., Doe A.'
venue: 'IEEE GLOBECOM 2026'
year: 2026
type: 'conference'        # journal | conference | book | chapter | preprint
doi: '10.1109/...'
pdf: '/files/your-paper.pdf'  # optional, place PDF at public/files/your-paper.pdf
selected: true            # appears on homepage if true
order: 0                  # within the same year, lower comes first
---
```

### Add a research project

Create a new file in `src/content/projects/`, e.g. `new-project.md`:

```markdown
---
title: 'Project acronym — short description'
role: 'PI'                # PI / coordinator / co-investigator / senior researcher
status: 'ongoing'         # ongoing | completed | upcoming
startDate: 2026-09-01
endDate: 2028-08-31
budget: '€300,000'
funder: 'Horizon Europe'
partners: ['UCLan Cyprus', 'Partner A', 'Partner B']
url: 'https://project-site.example/'
featured: true
order: 1
---
Description of the project, what it does, and why it matters.
```

---

## Citation stats (auto-updated)

`src/data/stats.json` holds your works count, citation count, h-index, and i10-index.

The file is refreshed weekly (Mondays 06:00 UTC) by `.github/workflows/update-stats.yml`, which runs `scripts/fetch-openalex.mjs`. The script hits the OpenAlex public API using your ORCID and commits the new JSON.

**To trigger a refresh manually:** go to the Actions tab, click "Refresh OpenAlex stats", then "Run workflow".

**If your stats look wrong:** OpenAlex builds its author profile by matching works to your ORCID, Crossref records, and your publication history. If works are missing, you can [request a correction](https://help.openalex.org/hc/en-us/articles/14346015925783-How-do-I-correct-information-on-an-author-record) on the OpenAlex help center.

**No API key is required.** The script sends a `mailto:` parameter for the "polite pool" (faster, more reliable response from OpenAlex).

---

## Customising

- **Colour, fonts, spacing**: `src/styles/global.css`. Single accent variable (`--accent`) drives most of the colour. Default is `#1d3557` (navy). Try `#2c5530` for forest green, `#7b2d26` for academic burgundy, or `#1e3a5f` for darker navy.
- **Hero text**: `src/components/Hero.astro`. Edit name, role, affiliation, bio, and social links here.
- **Navigation items**: `src/components/Nav.astro`.
- **Footer**: `src/components/Footer.astro`.
- **Research interests pills**: `src/pages/index.astro`, near the top.

---

## Adding pages

Astro auto-routes files in `src/pages/`. Add a new `.astro` file and it becomes a route.

For example, create `src/pages/students.astro`:

```astro
---
import Base from '../layouts/Base.astro';
---

<Base title="Students — Marios Raspopoulos">
  <h1>PhD students</h1>
  <p>Current and former PhD students.</p>
</Base>
```

…and add it to the nav in `src/components/Nav.astro`.

---

## Domain

If you want a custom domain (e.g. `raspopoulos.com`):

1. Add a `CNAME` file at `public/CNAME` containing just `raspopoulos.com`.
2. Update `astro.config.mjs` → set `site: 'https://raspopoulos.com'`.
3. Configure DNS as described in [GitHub's docs](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site).

---

## What lives where

```
.
├── .github/workflows/      Build/deploy and weekly stats refresh
├── astro.config.mjs        Astro site configuration
├── package.json
├── public/                 Static files copied verbatim into the build
│   ├── favicon.svg
│   ├── images/photo.jpg    ← your headshot goes here
│   └── files/              ← drop your PDFs and CV here
├── scripts/
│   └── fetch-openalex.mjs  Pulls stats from OpenAlex by ORCID
├── src/
│   ├── components/         Reusable UI pieces (Nav, Hero, ProjectCard, ...)
│   ├── content/            Your editable content
│   │   ├── news/           One markdown file per news item
│   │   ├── projects/       One markdown file per project
│   │   └── publications/   One markdown file per publication
│   ├── content.config.ts   Schema for the collections above
│   ├── data/stats.json     Auto-updated by the OpenAlex workflow
│   ├── layouts/Base.astro  Shared HTML scaffold
│   ├── pages/              One file per route (index, publications, ...)
│   └── styles/global.css   All site styling
└── tsconfig.json
```

---

## License

Content (text and publications) © Marios Raspopoulos.
Code (Astro components, scripts, workflows) MIT.
