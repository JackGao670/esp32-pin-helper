import test from "node:test";
import assert from "node:assert/strict";
import { diagnosticProblems } from "../src/vscode/diagnosticModel";
import { createConfig, serializeConfig } from "../src/core/model/config";
import { addPeripheral, setSignal } from "../src/core/model/peripherals";

test("GPIO warning is anchored to its numeric JSON value, not text elsewhere", () => {
  const text = serializeConfig({ ...createConfig(), note: "GPIO0", pins: [{ gpio: 0, function: "GPIO_INPUT" }] });
  const [problem] = diagnosticProblems(text);
  assert.equal(text.slice(problem.offset, problem.offset + problem.length), "0");
  assert.deepEqual(problem.path, ["pins", 0, "gpio"]);
});

test("peripheral conflict is anchored to its signal value", () => {
  let config = addPeripheral(createConfig(), "uart", 1);
  config = setSignal(config, "uart1", "tx", 17);
  config = setSignal(config, "uart1", "rx", 17);
  const text = serializeConfig(config);
  const problem = diagnosticProblems(text).find(item => item.severity === "error")!;
  assert.deepEqual(problem.path, ["peripherals", "uart1", "signals", "rx"]);
  assert.equal(text.slice(problem.offset, problem.offset + problem.length), '"GPIO17"');
});

test("missing signal diagnostics fall back to their peripheral object", () => {
  const text = serializeConfig(addPeripheral(createConfig(), "i2c", 0));
  const problems = diagnosticProblems(text);
  assert.equal(problems.length, 2);
  assert.ok(text.slice(problems[0].offset, problems[0].offset + problems[0].length).includes('"type": "i2c"'));
});

test("unsupported targets and malformed configuration never report hardware success", () => {
  const text = serializeConfig({ ...createConfig(), target: { chip: "esp32s4" } });
  const [problem] = diagnosticProblems(text);
  assert.equal(text.slice(problem.offset, problem.offset + problem.length), '"esp32s4"');
  assert.match(problem.message, /not supported/);
  for (const invalid of ["{", "", '{"version":2}', '{"version":1,}', "// comment\n{}"]) {
    assert.ok(diagnosticProblems(invalid).some(problem => problem.severity === "error"));
  }
});

test("valid configurations clear all diagnostic problems", () => {
  assert.deepEqual(diagnosticProblems(serializeConfig(createConfig())), []);
});
