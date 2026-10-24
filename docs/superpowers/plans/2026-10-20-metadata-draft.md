# Gaffer site metadata: the draft to review

Status: PARKED by the owner on 2026-10-20 to review in a dedicated sit-down. Draft only, nothing here is applied to `site/` yet. Companion to `2026-10-19-site-metadata.md` (the checklist). This file holds the actual text, so you can edit the words and then I apply it all in one pass with tests.

Every value below that you should look at is marked **EDIT?**. Anything not marked is mechanical.

## 1. Wording

| Item | Draft | Length |
|---|---|---|
| Title (`<title>`, `og:title`, `twitter:title`) | `Gaffer: your AI crew in After Effects` | 37 (limit about 60) |
| Description (`description`) | `Gaffer is an AI crew for After Effects. Ask for the motion you want and Claude builds it in your project, from a panel inside the app. Requires Claude Code.` | 156 (target 140 to 160) |
| Short description (`og:description`, `twitter:description`) | `Ask for the motion you want. Claude builds it in your After Effects project, from a panel inside the app.` | 105 |
| Image alt (`og:image:alt`) | `A grid of looping motion clips under the word Gaffer.` | 54 |
| Site name | `Gaffer` | |

**EDIT?** all four sentences. Notes on my choices:
- The title is the page headline, so a search result and the page agree.
- "Requires Claude Code" is in the description on purpose: it filters out people who cannot use it.
- I left out "free". Whether to say it depends on your answer to the price question (checklist item 7).
- No em dashes, as with the rest of the copy.

## 2. The head block (replaces the current `<title>` and `description`)

```html
<title>Gaffer: your AI crew in After Effects</title>
<meta name="description" content="Gaffer is an AI crew for After Effects. Ask for the motion you want and Claude builds it in your project, from a panel inside the app. Requires Claude Code.">
<link rel="canonical" href="https://gafferae.com/">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta name="application-name" content="Gaffer">
<meta name="apple-mobile-web-app-title" content="Gaffer">
<link rel="alternate" type="text/markdown" href="/install.md" title="Install instructions for agents">

<meta property="og:type" content="website">
<meta property="og:site_name" content="Gaffer">
<meta property="og:title" content="Gaffer: your AI crew in After Effects">
<meta property="og:description" content="Ask for the motion you want. Claude builds it in your After Effects project, from a panel inside the app.">
<meta property="og:url" content="https://gafferae.com/">
<meta property="og:locale" content="en_US">
<meta property="og:image" content="https://gafferae.com/og.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:alt" content="A grid of looping motion clips under the word Gaffer.">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Gaffer: your AI crew in After Effects">
<meta name="twitter:description" content="Ask for the motion you want. Claude builds it in your After Effects project, from a panel inside the app.">
<meta name="twitter:image" content="https://gafferae.com/og.jpg">
<meta name="twitter:image:alt" content="A grid of looping motion clips under the word Gaffer.">

<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
```

The icon links and the manifest (`/favicon.ico`, `/icon.svg`, `/apple-touch-icon.png`, `/site.webmanifest`) are now applied: the mark is the lime bottom design from the owner's Figma (Plugin Dev, Branding section, frame 656:4287) and `scripts/site/build-icons.mjs` generates every icon from `scripts/site/icon-source.svg`. The share image (`site/og.jpg`, 1200 x 630) is designed in Figma (Plugin Dev, Gaffer page, frame "Share image 1200x630", 659:4202) and exported from there with `node scripts/site/figma-export-og.mjs` (Grip plugin open in the file). There is no generator: the design uses rotation, blur and opacity that only Figma renders faithfully. The Open Graph and Twitter tags stay unapplied until the owner approves the image and the wording.

## 3. Structured data (JSON-LD)

Brand-only publisher, no personal name (**EDIT?** if you want a real publisher). The price node is left out until you confirm it.

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": "https://gafferae.com/#website",
      "name": "Gaffer",
      "url": "https://gafferae.com/"
    },
    {
      "@type": "SoftwareApplication",
      "@id": "https://gafferae.com/#app",
      "name": "Gaffer",
      "description": "An AI crew for After Effects. Ask for the motion you want and Claude builds it in your project, from a panel inside the app.",
      "url": "https://gafferae.com/",
      "applicationCategory": "MultimediaApplication",
      "operatingSystem": "macOS, Windows",
      "softwareRequirements": "Adobe After Effects 2022 or later, Claude Code",
      "downloadUrl": "https://github.com/spendolas/gaffer-ae/releases/latest",
      "image": "https://gafferae.com/og.jpg",
      "publisher": { "@type": "Organization", "name": "Gaffer", "url": "https://gafferae.com/" }
    }
  ]
}
</script>
```

If you confirm it is free, one line is added to the app node: `"offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" }`.

## 4. Root files

**`robots.txt`** (needs your decision on AI crawlers). Two versions:

Option A, allow everything, keep the clips out of search crawls:
```
User-agent: *
Allow: /
Disallow: /media/

Sitemap: https://gafferae.com/sitemap.xml
```

Option B, same, and also tell AI training crawlers to stay out:
```
User-agent: *
Allow: /
Disallow: /media/

User-agent: GPTBot
Disallow: /

User-agent: ClaudeBot
Disallow: /

User-agent: CCBot
Disallow: /

User-agent: Google-Extended
Disallow: /

Sitemap: https://gafferae.com/sitemap.xml
```

Two caveats you should weigh: blocking AI crawlers can also stop AI assistants from learning about the product from the page, and `Disallow: /media/` stops image search from showing the clips. **Correction from a real test (2026-10-22):** I wrote here that the install flow is unaffected by robots rules because an agent fetching a URL for a user is not a crawler. That is wrong in practice: a Claude Cowork session refused to fetch the install page and said the site "blocks automated fetching (robots disallow)". (The page was actually down at that moment, a 502 on its `robots.txt`, which that fetcher treats as disallow; with the server back and no `robots.txt` at all, the page is fetchable.) So: whatever `robots.txt` we ship, `/install.md` must stay allowed for every agent that fetches on a user's behalf (a blanket `Disallow: /` for the Anthropic, OpenAI and Google user agents would break the install prompt), and the site must never answer `robots.txt` with a 5xx. Add a test that fetches `robots.txt` rules and asserts `/install.md` is allowed for `*` and for the user-triggered agents.

**`llms.txt`** (**EDIT?** the wording):
```
# Gaffer

> Gaffer is an AI crew for After Effects: a panel inside After Effects where Claude builds motion in your project from plain requests. It requires Claude Code and After Effects 2022 or later, on macOS or Windows.

## For agents

- [Install instructions](https://gafferae.com/install.md): the exact steps to install Gaffer for a user who asked for it. Follow them in order.
- [Source and releases](https://github.com/spendolas/gaffer-ae): the code, the changelog and the downloads.
```

**`.well-known/security.txt`** (needs a contact from you; the date is one year out and must be renewed):
```
Contact: mailto:<YOUR ADDRESS>
Expires: 2027-10-20T00:00:00.000Z
Preferred-Languages: en
Canonical: https://gafferae.com/.well-known/security.txt
```

**`site.webmanifest`**:
```json
{
  "name": "Gaffer",
  "short_name": "Gaffer",
  "description": "Your AI crew in After Effects",
  "start_url": "/",
  "display": "browser",
  "theme_color": "#121212",
  "background_color": "#121212",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icon-512-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

## 5. Already done in this branch

- `install.md`, generated from the README, with a test that it stays in sync.
- `404.html` and a `sitemap.xml` built on each deploy (with the install page listed).
- `CNAME` and the deploy workflow.

## 6. What I need from you to finish

1. Edit or approve the wording in section 1.
2. A mark for the icons (an SVG, or say "draft a G in Source Sans on the blue" and I will).
3. The share image: your art at 1200 x 630, or I draft one from poster frames plus the headline.
4. robots.txt: option A or B, and whether `/media/` stays out of search.
5. A security contact (or skip `security.txt`).
6. Free or not, for the structured data.
7. Pinch-zoom: it is disabled now (`maximum-scale=1, user-scalable=no`), which Lighthouse and WCAG flag. Keep it for the locked page, or allow it?

When you have answered, I apply sections 2, 3 and 4 in one pass and add tests that fail if a tag, a file or a size is wrong (share image exactly 1200 x 630, icons the right sizes, every URL absolute https).

## 7. Added 2026-10-20: specific metadata on every published media asset

Requirement from the owner: every media asset we publish (the clips, the posters, the share image, the icons) should carry its own specific metadata, not only the page. Not designed yet; the notes below are what to decide when the draft is reviewed.

What the assets carry today (checked): the clips only have the encoder tags ffmpeg writes (`Lavf`, `libx264` or `libx265`) and no title, author, copyright or description. They contain no personal paths, names or host names, which is the thing to keep true.

Pieces of the work:
1. **Embedded tags in each clip:** title, description, copyright, creator and source URL, written by `add-sample.sh` (`-metadata`) so every new clip gets them. Re-tagging the six existing clips is a remux, with no re-encode.
2. **Embedded tags in each image:** the posters, `og.jpg` and the icons get the same fields (EXIF or XMP), written when they are generated.
3. **Per-clip fields in `items.json`:** a human title and a short description for each clip (also the source for alt text), kept next to the serial name in `docs/site-clips.md` or a small `clips.json`. The clip tiles are decorative today (`aria-hidden`), so this does not change how the page reads to a screen reader unless we decide it should.
4. **Structured data per asset:** `ImageObject` and `VideoObject` entries with name, description, creator, license and thumbnail, linked from the main `SoftwareApplication` node. Video entries only help if the clips are crawlable, which interacts with `Disallow: /media/` in section 4.
5. **A rule that nothing leaks:** a test that fails if any published asset carries a personal name, a local path or a host name in its tags, and that the encoder strings are the only unplanned tags.

Questions to answer at the review: the exact copyright holder and licence wording, a title and description for each of the seven clips, whether to keep the encoder tags or strip them, and whether clip tiles should become readable to assistive technology.
