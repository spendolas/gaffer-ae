// A model catalog for tests that drive a ChatHandler through a chat turn but
// are not about model discovery. The handler would otherwise build the real
// catalog, and the background refresh after a completed turn would read the
// developer's Keychain and call the (isolated, dead) API base URL. This one
// does no I/O: discovery fails closed, nothing is cached, refresh is a no-op.
// Tests about discovery itself inject a real catalog with fake edges instead
// (model-catalog-adapter.test.mjs). Node's test runner also loads this file
// during discovery; it defines no tests.
export function noopModelCatalog() {
  return {
    get: async () => ({ status: 'no-credential', catalog: null, fetchedAt: null, fromCache: false }),
    peek: () => null,
    invalidate() {},
    refreshInBackground: () => Promise.resolve(),
  };
}
