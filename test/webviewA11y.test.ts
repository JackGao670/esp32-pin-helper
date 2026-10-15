import test from "node:test";
import assert from "node:assert/strict";

/**
 * §4.7 accessibility: assert the WebView markup carries accessible names, roles and live regions.
 * The webview entry (store.ts) touches `window` at module scope, so a minimal stub is installed
 * before App is imported; without `acquireVsCodeApi` the store falls back to its in-memory
 * preview state, which is exactly the state we want to render here.
 */
async function renderApp(): Promise<string> {
  (globalThis as unknown as { window: unknown }).window = { addEventListener: () => {} };
  // The preview store mirrors the browser locale; pin it so these structural assertions are stable
  // regardless of the developer machine's display language (§4.7 i18n).
  Object.defineProperty(globalThis, "navigator", { value: { language: "en-US" }, configurable: true });
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { App } = await import("../webview/src/App");
  return renderToStaticMarkup(React.createElement(App));
}

test("webview a11y: landmarks, groups and live regions are present", async () => {
  const html = await renderApp();
  assert.match(html, /^<main>/, "the planner renders inside a main landmark");
  assert.match(html, /<aside class="resources" aria-label="Peripherals and target chip">/);
  assert.match(html, /<aside class="inspector" aria-label="Pin inspector">/);
  assert.match(html, /<div class="pinout" role="group" aria-label="GPIO overview for ESP32-S3">/);
  assert.match(html, /<div class="legend" role="list" aria-label="Pin status legend">/);
  assert.match(html, /role="listitem"/);
  // The inspector status and the Problems counter announce changes to screen readers.
  assert.match(html, /class="pin-status unused" aria-live="polite"/);
  assert.match(html, /<span role="status">0 errors · 0 warnings<\/span>/);
});

test("webview a11y: pin cells are toggle buttons with a spoken description", async () => {
  const html = await renderApp();
  const pins = html.match(/<button class="pin [^"]*"[^>]*>/g) ?? [];
  assert.ok(pins.length > 10, "the S3 pinout renders its GPIO cells");
  for (const pin of pins) {
    assert.match(pin, /aria-pressed="(true|false)"/, `missing aria-pressed: ${pin}`);
    assert.match(pin, /aria-label="[^"]+" title="[^"]+"/, `missing accessible name: ${pin}`);
  }
  // Exactly one pin is the selected one, and its description is a "<label> — <meaning>" phrase.
  assert.equal(pins.filter(pin => pin.includes('aria-pressed="true"')).length, 1);
  assert.match(html, /aria-label="[^"]+ — [^"]*"/);
});

test("webview a11y: decorative dots are hidden from assistive technology", async () => {
  const html = await renderApp();
  assert.match(html, /<span class="dot" aria-hidden="true"><\/span>/);
  assert.match(html, /<i class="dot" aria-hidden="true"><\/i>/);
  assert.ok(!/<span class="dot"><\/span>/.test(html), "no decorative dot may be exposed unlabelled");
  assert.match(html, /<span class="chip-mark" aria-hidden="true"><\/span>/);
});
