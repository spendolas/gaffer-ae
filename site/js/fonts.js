// Resolves once the two first-paint font faces are loaded. Both faces are single
// variable files, so loading one weight fetches the whole file; the weights come
// from the live config only so the request matches what the page draws. Errors
// count as settled (a missing font must not hold the cover); the caller races
// this against the boot cap, so a hung font cannot hold it either.
export function loadFirstPaintFonts(fonts, config) {
  if (!fonts?.load) return Promise.resolve();
  const sans = fonts.load(`${config.headline.weight} 1em "Source Sans 3"`);
  const mono = fonts.load(`${config.type.monoWeight} 1em "JetBrains Mono"`);
  return Promise.allSettled([sans, mono]).then(() => undefined);
}
