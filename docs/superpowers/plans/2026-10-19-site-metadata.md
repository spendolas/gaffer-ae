# Gaffer site: metadata, SEO, icons and hosting checklist

Status: plan only, written 2026-10-19 while the user slept. Nothing here is built yet.
Scope: everything a browser, search engine, social platform or crawler expects from https://gafferae.com that is not the page design itself.

Legend: **ME** = I can build and test it alone. **YOU** = needs you (assets, accounts, decisions). **BOTH** = I build it, you approve or supply one input.

## 1. Tags in the page head (`site/index.html`)

| Item | Format / value | Who |
|---|---|---|
| `<title>` | 50 to 60 characters. Proposal: `Gaffer: your AI crew in After Effects` (no em-dash, per the copy rule) | ME, you approve wording |
| `<meta name="description">` | 140 to 160 characters, one plain sentence. Today it says "Motion made in After Effects with Gaffer, an agent you drive from Claude Code." Proposal adds what it is and that it is free | ME, you approve wording |
| `<link rel="canonical" href="https://gafferae.com/">` | absolute https URL, apex domain (no www, no trailing index.html) | ME |
| `<meta name="robots" content="index, follow, max-image-preview:large">` | the default is already index,follow; this only adds the large image preview permission | ME |
| `<meta name="theme-color" content="#121212">` and `color-scheme` | already in the page | done |
| `<meta name="viewport">` | already there. NOTE: it contains `maximum-scale=1, user-scalable=no`, which blocks pinch zoom. Lighthouse and WCAG 1.4.4 flag that. The page is a locked full-screen grid, so it was deliberate, but it is an accessibility cost | YOU decide: keep, or allow zoom |
| `<meta name="apple-mobile-web-app-title" content="Gaffer">` and `application-name` | name shown when saved to an iPhone home screen or pinned | ME |
| `<html lang="en">` | already there | done |
| `<meta name="keywords">` | do NOT add: ignored by every major search engine | n/a |
| `<link rel="alternate" type="text/markdown" href="/install.md" title="Install instructions for agents">` | optional hint that the machine-readable install doc exists | ME |
| `<meta http-equiv="Content-Security-Policy">` | GitHub Pages cannot send custom HTTP headers, so a meta CSP is the only option. It needs a hash for the inline boot-variables style block (the sync script can compute it). Hardening, not SEO | ME, low priority |
| `<meta name="referrer" content="strict-origin-when-cross-origin">` | this is already the browser default; adding it only documents it | ME, optional |

## 2. Social sharing tags (Open Graph and X/Twitter)

Used by Slack, iMessage, WhatsApp, LinkedIn, Facebook, Discord, X and Bluesky link previews. All URLs must be absolute https.

| Tag | Value |
|---|---|
| `og:type` | `website` |
| `og:site_name` | `Gaffer` |
| `og:title` | same as the title, or a shorter punchier variant |
| `og:description` | same as the meta description (about 100 to 160 characters shows in full) |
| `og:url` | `https://gafferae.com/` |
| `og:image` | `https://gafferae.com/og.jpg`, **1200 x 630 px**, JPG or PNG, under 5 MB (under 1 MB is better) |
| `og:image:width`, `og:image:height`, `og:image:type` | `1200`, `630`, `image/jpeg` |
| `og:image:alt` | one sentence describing the image |
| `og:locale` | `en_US` |
| `twitter:card` | `summary_large_image` |
| `twitter:title`, `twitter:description`, `twitter:image`, `twitter:image:alt` | same values (X falls back to the og: tags, but `twitter:card` itself is required) |

**The image is the one big item.** Ruling 5 planned a generated `og.jpg` (a copy of the first poster). A designed card (the grid fading into the headline) will look far better. Options: (a) you design it in Figma at 1200 x 630 and send the file; (b) I generate a draft by compositing poster frames and the headline with ffmpeg, you approve or replace it. Some platforms also want a square crop (1200 x 1200) for chat apps: I can produce both from the same art. **BOTH.**

## 3. Files at the site root (`site/`)

| File | Content / format | Who |
|---|---|---|
| `robots.txt` | `User-agent: *`, `Allow: /`, `Sitemap: https://gafferae.com/sitemap.xml`. Decision: whether to allow or block AI training crawlers (GPTBot, ClaudeBot, CCBot, Google-Extended, etc.) with extra `User-agent` / `Disallow: /` blocks. Also consider `Disallow: /media/` so crawlers do not pull the ~10 MB of clips | ME builds, **YOU decide the AI-crawler policy** |
| `sitemap.xml` | XML, one `<url>` for `https://gafferae.com/` with `<lastmod>`; optionally `install.md`. Generated in the deploy workflow so `lastmod` is current | ME |
| `favicon.ico` | multi-size ICO (16, 32, 48 px). Browsers still request `/favicon.ico` by default | ME placeholder, **YOU supply the mark** |
| `icon.svg` | SVG favicon, can adapt to light/dark with a `prefers-color-scheme` rule in the file. Linked with `<link rel="icon" type="image/svg+xml" href="/icon.svg">` | same |
| `apple-touch-icon.png` | **180 x 180 px**, opaque (no transparency, iOS fills transparent areas with black), no rounded corners (iOS rounds them) | same |
| `icon-192.png`, `icon-512.png`, `icon-512-maskable.png` | PNGs for the manifest (the maskable one needs the mark inside the central 80% safe zone) | same |
| `site.webmanifest` | JSON: `name`, `short_name`, `icons`, `theme_color` `#121212`, `background_color` `#121212`, `display: browser` (we are not building an installable app, but Android Chrome and some link tools read it). Linked with `<link rel="manifest">` | ME |
| `404.html` | GitHub Pages serves it for any unknown path. A small on-brand page with a link home (same fonts and colours, no JS needed) | ME |
| `llms.txt` | emerging convention (plain Markdown at the site root) that tells AI tools what the site is and where the agent-readable pages are (`install.md`). Low cost, no downside | ME, you approve the wording |
| `.well-known/security.txt` | contact address for vulnerability reports (RFC 9116: `Contact:`, `Expires:`). Recommended for software that asks people to run install steps | BOTH: **YOU give a contact email or URL** |
| `CNAME` | `gafferae.com` (already planned) | ME |
| `.nojekyll` | only needed if the site is published without the Actions artifact. We publish through Actions, so Jekyll never runs; I will add it anyway if the deploy ever changes | ME |
| `install.md` | the agent-readable install doc (Task 9 of the build plan; not metadata but linked from the prompt) | ME, needs the real install steps checked |

Not needed: `humans.txt` (optional vanity), `browserconfig.xml` (old Windows tiles, obsolete), Safari `mask-icon` (obsolete since Safari 12), `ads.txt`, cookie banner (no cookies, no analytics by design).

## 4. Structured data (JSON-LD in the head)

One `<script type="application/ld+json">` block with a `SoftwareApplication`:
`name` Gaffer, `applicationCategory` `MultimediaApplication`, `operatingSystem` `macOS, Windows`, `description`, `url`, `image` (the og image), `softwareRequirements` "Adobe After Effects 2022 or later, Claude Code", `offers` `{price: "0", priceCurrency: "USD"}` (free for now: confirm), `downloadUrl` (the GitHub Releases page), and a `publisher`. Plus a small `WebSite` node (`name`, `url`). It earns rich results only occasionally, but it is how search and AI answers learn what the page is. Validate with Google's Rich Results Test.

**YOU decide the publisher identity.** You have been careful about not leaking your real name through the repo: a brand-only `Organization` named Gaffer (no personal name, no address) is the safe default.

## 5. Content for search engines

The page is one huge headline, a subtitle, an install prompt and a note. That is almost no indexable text, and the clips are decorative. Search engines will see roughly: "Gaffer, your AI crew in After Effects. Install Gaffer by following ... Requires Claude Code." That is enough to rank for the brand name, not for "After Effects AI plugin". Options, **YOU decide**:
1. Leave it (brand-name discovery only, cleanest design).
2. Add a short real description paragraph that is accessible but not part of the visual design (an accurate sentence or two inside the `<main>` for screen readers and crawlers). Accurate hidden-from-sight text is allowed, but search engines may weight it low.
3. Add a second page later (docs, a features page, a changelog) and link it from the dock. Best for SEO, not part of this build.

## 6. Hosting and accounts (nothing here can be done from the repo)

| Step | Who |
|---|---|
| DNS at your registrar: four `A` records for the apex (185.199.108.153, 185.199.109.153, 185.199.110.153, 185.199.111.153), optional `AAAA` records, and a `CNAME` for `www` pointing at the account's github.io host. (GitHub's published values: I will re-check them from GitHub's docs when we get there, not from memory.) | **YOU** |
| GitHub repo Settings, Pages: source = GitHub Actions, custom domain `gafferae.com`, **Enforce HTTPS** on | **YOU** (I give you the exact clicks) |
| Verify the domain for Pages (a `_github-pages-challenge-...` TXT record) so nobody else can claim it | **YOU** |
| Google Search Console and Bing Webmaster Tools: add the property (DNS TXT verification is best because it survives redeploys), submit `sitemap.xml` | **YOU** (accounts) |
| Repo social preview image (Settings, 1280 x 640 px PNG) for link previews of the GitHub repo itself | **YOU** upload, I make the image |
| `www` to apex redirect | handled by GitHub once both DNS records exist |

## 7. Tests and checks I can run before you wake up the next time

- A node test that fails when a required tag or file is missing, when the OG image is not exactly 1200 x 630, when an icon has the wrong size (ffprobe), when a URL is not absolute https, when the sitemap or robots.txt reference a wrong host, or when `llms.txt`/`install.md` links break.
- Local Lighthouse run (performance, accessibility, SEO, best practices) in a scratch folder if Chrome is available; the zoom-blocking viewport will show up there.
- After deploy (you or me with your OK): Facebook Sharing Debugger, LinkedIn Post Inspector, Slack/Discord paste test, X post preview, Google Rich Results Test, and a check that `/robots.txt`, `/sitemap.xml`, `/favicon.ico`, `/apple-touch-icon.png`, `/404` and `/install.md` all return the right content type and status over HTTPS.

## 8. Suggested order

1. Decisions from you (section 9), then my build of everything marked ME (about one session).
2. Your brand mark and OG art (or my drafts, approved), then final icons and the share image.
3. Deploy, DNS, HTTPS, verification, sitemap submission, social debuggers.

## 9. Decisions and inputs I need from you

1. Brand mark for the favicon (an SVG, or a description if you want me to draft a simple "G" mark in Source Sans on the blue).
2. OG image: your art, or approve a draft from me.
3. AI crawler policy for `robots.txt` (allow all, or block training crawlers) and whether to block `/media/`.
4. Publisher identity for the structured data (brand-only is my default) and a security contact for `security.txt`.
5. Viewport zoom: keep pinch-zoom disabled, or allow it.
6. Search text: leave as is, add a short accurate description paragraph, or plan a second page.
7. Free price in structured data: confirm "free" (licensing and Pro tiers may come later).
8. The tagline wording for title, description and social cards (the page headline is the starting point).
