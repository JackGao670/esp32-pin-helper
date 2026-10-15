import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogs, LANGUAGES, normalizeLanguage, resolveLanguage, translator, type MessageKey } from "../src/i18n/messages";
import { buildHomeModel, renderHomeHtml } from "../src/vscode/homeModel";
import { createConfig, serializeConfig } from "../src/core/model/config";
import { projectNotice } from "../src/core/model/project";
import { DEFAULT_SETTINGS, readHeadlessSettings } from "../src/config/userSettings";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("i18n: BCP-47 tags normalise to the shipped languages", () => {
  assert.deepEqual([...LANGUAGES], ["en", "zh-cn"]);
  for (const tag of ["zh", "zh-CN", "zh-TW", "zh-Hans", "ZH-hant"]) assert.equal(normalizeLanguage(tag), "zh-cn", tag);
  for (const tag of ["en", "en-US", "de", "", undefined]) assert.equal(normalizeLanguage(tag), "en", String(tag));
});

test("i18n: the explicit setting overrides the host display language", () => {
  assert.equal(resolveLanguage("auto", "zh-CN"), "zh-cn");
  assert.equal(resolveLanguage("auto", "en-US"), "en");
  assert.equal(resolveLanguage(undefined, "zh-CN"), "zh-cn");
  // A forced setting wins even when the host would pick the other language.
  assert.equal(resolveLanguage("en", "zh-CN"), "en");
  assert.equal(resolveLanguage("zh-cn", "en-US"), "zh-cn");
});

test("i18n: both catalogs declare exactly the same message keys", () => {
  const en = Object.keys(catalogs.en).sort();
  const zh = Object.keys(catalogs["zh-cn"]).sort();
  assert.deepEqual(zh, en, "zh-cn must translate every key and invent none");
  assert.ok(en.length > 100, `expected a sizeable catalog, got ${en.length} keys`);
  for (const key of en) {
    assert.ok(catalogs.en[key as MessageKey].length > 0, `empty English message: ${key}`);
    assert.ok(catalogs["zh-cn"][key as MessageKey].length > 0, `empty Chinese message: ${key}`);
  }
});

test("i18n: {name} placeholders are substituted, and left verbatim when a param is missing", () => {
  const zh = translator("zh-cn");
  assert.equal(translator("en")("problems.count", { errors: 1, warnings: 2 }), "1 errors · 2 warnings");
  assert.equal(zh("problems.count", { errors: 1, warnings: 2 }), "1 个错误 · 2 个警告");
  assert.equal(zh("notice.detectedTarget", { chip: "esp32s3" }), "已识别项目目标芯片 esp32s3。选择一个 GPIO 功能即可创建 .pinconfig.json。");
  // A missing value stays visible instead of rendering "undefined".
  assert.equal(zh("problems.count", { errors: 1 }), "1 个错误 · {warnings} 个警告");
});

test("i18n: the language setting round-trips through the settings reader", () => {
  assert.equal(DEFAULT_SETTINGS.language, "auto");
  assert.equal(readHeadlessSettings().language, "auto");
  assert.equal(readHeadlessSettings({ language: "zh-cn" }).language, "zh-cn");
});

test("i18n: the Activity Bar home view renders in the requested language", () => {
  const model = buildHomeModel({
    folderName: "blink",
    raw: serializeConfig(createConfig("esp32s3")),
    settings: DEFAULT_SETTINGS
  });
  const zh = renderHomeHtml(model, { nonce: "n", language: "zh-cn" });
  assert.match(zh, /<html lang="zh-cn">/);
  assert.match(zh, /0 个错误/);
  assert.match(zh, /0 个警告/);
  assert.match(zh, /<dt>芯片<\/dt>/);
  assert.match(zh, /打开引脚规划器/);
  // Command URIs are locale-independent and must survive translation.
  assert.match(zh, /command:espPinPlanner\.open/);

  const en = renderHomeHtml(model, { nonce: "n", language: "en" });
  assert.match(en, /<html lang="en">/);
  assert.match(en, /0 errors/);
  // Omitting the language keeps the historical English rendering.
  assert.match(renderHomeHtml(model, { nonce: "n" }), /Open Pin Planner/);
});

test("i18n: the no-folder home state is translated too", () => {
  const model = buildHomeModel({ folderName: undefined, raw: undefined, settings: DEFAULT_SETTINGS });
  assert.match(renderHomeHtml(model, { nonce: "n", language: "zh-cn" }), /打开一个文件夹以规划 ESP32 引脚。/);
});

test("i18n: projectNotice follows the translator it is given", () => {
  assert.equal(projectNotice("esp32c6", "esp32s3", translator("zh-cn")),
    "项目目标芯片 esp32s3 与引脚配置目标 esp32c6 不一致，配置未被修改。");
  assert.match(projectNotice("esp32c6", "esp32s3"), /Configuration was not changed/);
});

test("i18n: every %key% in package.json is defined in both package.nls files", () => {
  const referenced = [...readFileSync(resolve(repoRoot, "package.json"), "utf8").matchAll(/%([A-Za-z0-9._-]+)%/g)].map(m => m[1]);
  assert.ok(referenced.length > 0, "package.json should reference localised strings");
  const en = JSON.parse(readFileSync(resolve(repoRoot, "package.nls.json"), "utf8")) as Record<string, string>;
  const zh = JSON.parse(readFileSync(resolve(repoRoot, "package.nls.zh-cn.json"), "utf8")) as Record<string, string>;
  for (const key of referenced) {
    assert.ok(key in en, `package.nls.json is missing ${key}`);
    assert.ok(key in zh, `package.nls.zh-cn.json is missing ${key}`);
  }
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
});
