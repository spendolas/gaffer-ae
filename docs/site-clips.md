# Landing page clips: serial names and sources

The files in `site/media/` are named `clip-NN` so the public page carries no source names. This table
is the key: which export each serial came from. `scripts/site/add-sample.sh` gives a new clip the next
free number when no slug is passed, and appends its row here.

All sources live in `exports/` (untracked, in the main checkout): `prores/` holds the After Effects
ProRes masters, `gifs/` the GIF exports.

| Clip | Source | Added | Notes |
|---|---|---|---|
| clip-01 | `exports/gifs/ascii-fx.gif` | 2026-10-18 | formerly `ascii-fx`; native 2:1 (1000x500), the largest file; re-encoded at CRF 26 (HEVC 29) on 2026-10-24, 1.7 MB H.264 / 1.3 MB HEVC, no visible difference |
| clip-02 | `exports/gifs/confetti-burst.gif` | 2026-10-18 | formerly `confetti-burst` |
| clip-03 | `exports/prores/Iso LEGO Block_v2_offset50.mov` | 2026-10-19 | replaces the old iso LEGO block clip (`Iso LEGO Block.mov`, formerly `iso-lego-block`) |
| clip-04 | `exports/prores/menu-hover_v2.mov` | 2026-10-18 | formerly `menu-hover-v2` (was clip-05 before the lego brick was dropped) |
| clip-05 | `exports/prores/spinners_loop_v2.mov` | 2026-10-18 | formerly `spinners-loop-v2` (was clip-06) |
| clip-06 | `exports/Joao/book-nav-gaffer.mp4` | 2026-10-19 | from Joao; 1300x300 source padded to 2.4:1 with its own dark red (#4e1512, edge-smeared) so the whole nav bar fits; native 60 fps |
| clip-07 | `exports/prores/shimmer-sphere.mov` | 2026-10-20 | 1080x1080 60 fps, 12 s loop, scaled to 800; re-encoded at CRF 26 (HEVC 29) on 2026-10-24: 1.4 MB H.264, 1.2 MB HEVC, SSIM 0.995 against the CRF 20 version |
| clip-08 | `exports/prores/croissant-colors.mov` | 2026-10-21 | 1280x800 (1.6:1) 60 fps, 5 s loop, native shape and size; 0.4 MB H.264, 0.3 MB HEVC |

Sources for clip-04 and clip-05 are inferred from their 60 fps frame rate (the GIFs are 50 fps) and the
matching export names; clip-07 comes from a ProRes master that is still in `exports/prores`. clip-01 and clip-02 have only GIF exports.

Removed on 2026-10-19: the old iso LEGO block clip (`Iso LEGO Block.mov`) and the red LEGO brick clip
(`lego_brick_v2.mov`, formerly `lego-brick-v2`, serial clip-04 for a day). Both can be re-added with
`scripts/site/add-sample.sh` from `exports/prores/`.

Titles, descriptions and copyright holders live in `scripts/site/clip-meta.json`. A new clip needs an entry
there (a test fails otherwise); `node scripts/site/tag-clips.mjs` writes them into the files, then rebuild the manifest.

Images: `scripts/site/asset-meta.json` holds the title, description and holder of the share image and the icons;
posters take their clip's entry from `clip-meta.json`. `node scripts/site/tag-images.mjs` writes them with
exiftool (strips every other tag first). Run it after `build-icons.mjs` or `figma-export-og.mjs` and commit the
result; the deploy workflow tags the generated posters itself.
