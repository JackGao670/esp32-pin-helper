import test from "node:test";
import assert from "node:assert/strict";
import { buildHomeModel, renderHomeHtml } from "../src/vscode/homeModel";
import { createConfig, serializeConfig } from "../src/core/model/config";
import { DEFAULT_SETTINGS } from "../src/config/userSettings";

const render = (model: Parameters<typeof renderHomeHtml>[0]) => renderHomeHtml(model, { nonce: "test-nonce" });

test("home model: no workspace folder and missing .pinconfig.json are distinct states", () => {
  const noFolder = buildHomeModel({ folderName: undefined, raw: undefined, settings: DEFAULT_SETTINGS });
  assert.equal(noFolder.status, "no-folder");
  assert.equal(noFolder.errors, 0);
  const noFolderHtml = render(noFolder);
  assert.match(noFolderHtml, /Open a folder to plan ESP32 pins/);
  assert.match(noFolderHtml, /command:espPinPlanner\.open/);
  assert.ok(!noFolderHtml.includes("command:espPinPlanner.create"), "create needs a folder, so it must not be offered");

  const noFile = buildHomeModel({ folderName: "blink", raw: undefined, settings: DEFAULT_SETTINGS });
  assert.equal(noFile.status, "no-file");
  assert.equal(noFile.folderName, "blink");
  const noFileHtml = render(noFile);
  assert.match(noFileHtml, /No \.pinconfig\.json in blink/);
  assert.match(noFileHtml, /command:espPinPlanner\.create/);
});

test("home model: unparsable config reports the parser message and escapes it", () => {
  const broken = buildHomeModel({ folderName: "<b>w</b>", raw: "{", settings: DEFAULT_SETTINGS });
  assert.equal(broken.status, "invalid");
  assert.ok(broken.parseError);
  const html = render(broken);
  assert.match(html, /could not be parsed/);
  assert.match(html, /class="err"/);
  assert.match(html, /in &lt;b&gt;w&lt;\/b&gt; could not be parsed/);
  assert.ok(!html.includes("<b>w</b>"), "folder name must not be injected as markup");
});

test("home model: ready state summarises chip, board and problem counts", () => {
  const model = buildHomeModel({
    folderName: "blink",
    raw: serializeConfig(createConfig("esp32s3")),
    settings: DEFAULT_SETTINGS
  });
  assert.equal(model.status, "ready");
  assert.equal(model.chip, "esp32s3");
  assert.equal(model.chipName, "ESP32-S3");
  assert.equal(model.supported, true);
  assert.equal(model.boardName, "ESP32-S3-DevKitC-1 (N8R8)");
  assert.deepEqual([model.errors, model.warnings], [0, 0]);
  const html = render(model);
  assert.match(html, /0 errors/);
  assert.match(html, /0 warnings/);
  assert.match(html, /ESP32-S3-DevKitC-1/);
  assert.match(html, /command:espPinPlanner\.validate/);
  assert.match(html, /command:espPinPlanner\.selectTarget/);
  assert.match(html, /<style nonce="test-nonce">/);
  // §4.7 accessibility: the view content sits in a main landmark with a declared language.
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<body><main>/);
  assert.match(html, /<\/main><\/body>/);
});

test("home model: hardware violations and unsupported chips surface in the counts", () => {
  // GPIO46 on S3 is input-only: OUTPUT must be an error.
  const violated = createConfig("esp32s3");
  violated.pins = [{ gpio: 46, function: "GPIO_OUTPUT" }];
  const bad = buildHomeModel({ folderName: "blink", raw: serializeConfig(violated), settings: DEFAULT_SETTINGS });
  assert.equal(bad.status, "ready");
  assert.equal(bad.errors, 1);

  // A chip without a device database degrades to a warning instead of failing the view.
  const unknown = buildHomeModel({
    folderName: "blink",
    raw: serializeConfig(createConfig("esp32c5")),
    settings: DEFAULT_SETTINGS
  });
  assert.equal(unknown.status, "ready");
  assert.equal(unknown.supported, false);
  assert.equal(unknown.chipName, "esp32c5");
  assert.equal(unknown.warnings, 1);
  assert.equal(unknown.errors, 0);
  assert.match(render(unknown), /\(not supported\)/);
});

test("home model: board features follow the board setting", () => {
  const none = buildHomeModel({
    folderName: "blink",
    raw: serializeConfig(createConfig("esp32s3")),
    settings: { ...DEFAULT_SETTINGS, board: { preset: "none" } }
  });
  assert.equal(none.boardName, undefined);
  assert.ok(!render(none).includes("<dt>Board</dt>"));

  const byId = buildHomeModel({
    folderName: "blink",
    raw: serializeConfig(createConfig("esp32c6")),
    settings: { ...DEFAULT_SETTINGS, board: { preset: "byId", vendor: "espressif", board: "esp32-c6-devkitm-1" } }
  });
  assert.equal(byId.boardName, "ESP32-C6-DevKitM-1 (MINI-1)");
});
