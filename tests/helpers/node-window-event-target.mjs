/**
 * Minimal browser window for Node-side module loading.
 * EventTarget supplies the native add/remove/dispatch semantics used by
 * providerMode's storage listener; test-specific browser fields stay explicit.
 */
export function nodeWindowEventTarget(fields = {}) {
  return Object.assign(new EventTarget(), fields);
}
