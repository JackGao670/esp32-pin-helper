import test from "node:test";
import assert from "node:assert/strict";
import { createConfig } from "../src/core/model/config";
import { addPeripheral, setSignal } from "../src/core/model/peripherals";
import { validateGpio } from "../src/core/validator/gpio";
import { candidates as candidatesFor, definition as peripheralDefinition } from "../src/core/resolver/peripherals";
import {
  deriveRepairContext,
  extractIntentJson,
  intentFromConfig,
  parseIntent,
  planFromIntent,
  summarizeConfig
} from "../src/core/ai/intent";
import { buildCatalogue, detectChip, generationPrompt, pinsToAvoid, repairPrompt, supportedChips } from "../src/core/ai/prompt";

test("parseIntent accepts a well-formed spec and ignores unknown keys", () => {
  const spec = parseIntent({
    chip: "esp32s3",
    avoidStrapping: false,
    peripherals: [{ type: "uart", instance: 1, signals: ["tx", "rx"] }, { type: "i2c", instance: 0 }],
    pinFunctions: [{ gpio: 5, function: "GPIO_OUTPUT" }],
    // A model that tries to smuggle GPIO numbers for a peripheral must not be obeyed.
    "uart1.tx": 999,
    note: "hallucinated extra"
  });
  assert.deepEqual(spec, {
    chip: "esp32s3",
    avoidStrapping: false,
    peripherals: [{ type: "uart", instance: 1, signals: ["tx", "rx"] }, { type: "i2c", instance: 0 }],
    pinFunctions: [{ gpio: 5, function: "GPIO_OUTPUT" }]
  });
});

test("parseIntent rejects wrong shapes with a precise message", () => {
  for (const bad of [null, 42, "proposal", []]) assert.throws(() => parseIntent(bad), /must be a JSON object/);
  assert.throws(() => parseIntent({ chip: "" }), /`chip`/);
  assert.throws(() => parseIntent({ chip: 7 }), /`chip`/);
  assert.throws(() => parseIntent({ avoidStrapping: "yes" }), /`avoidStrapping`/);
  assert.throws(() => parseIntent({ peripherals: {} }), /`peripherals` must be an array/);
  assert.throws(() => parseIntent({ peripherals: [{ type: "uart", instance: -1 }] }), /peripherals\[0\]\.instance/);
  assert.throws(() => parseIntent({ peripherals: [{ instance: 0 }] }), /peripherals\[0\]\.type/);
  assert.throws(() => parseIntent({ peripherals: [{ type: "uart", instance: 1, signals: "tx" }] }), /peripherals\[0\]\.signals/);
  assert.throws(() => parseIntent({ pinFunctions: [{ gpio: 5, function: "OUT" }] }), /pinFunctions\[0\]\.function/);
  assert.throws(() => parseIntent({ pinFunctions: [{ gpio: -1, function: "GPIO_OUTPUT" }] }), /pinFunctions\[0\]\.gpio/);
});

test("extractIntentJson reads fenced or embedded JSON and refuses unusable answers", () => {
  assert.deepEqual(extractIntentJson('```json\n{"chip":"esp32c6"}\n```'), { chip: "esp32c6" });
  assert.deepEqual(
    extractIntentJson('Sure!\n{"peripherals":[{"type":"i2c","instance":0}]}\nHope that helps.'),
    { peripherals: [{ type: "i2c", instance: 0 }] }
  );
  assert.throws(() => extractIntentJson("I could not understand the request."), /did not return a JSON object/);
  assert.throws(() => extractIntentJson('```json\n{ not json }\n```'), /could not be parsed/);
});

test("planFromIntent drives the optimizer and validator to a legal configuration", () => {
  const plan = planFromIntent({ peripherals: [{ type: "uart", instance: 1 }, { type: "i2c", instance: 0 }] }, "esp32s3");
  assert.equal(plan.config.target.chip, "esp32s3");
  assert.deepEqual(plan.dropped, []);
  assert.ok(plan.config.peripherals?.uart1, "uart1 was configured");
  assert.ok(plan.config.peripherals?.i2c0, "i2c0 was configured");
  const rx = plan.config.peripherals!.uart1.signals.rx;
  const sda = plan.config.peripherals!.i2c0.signals.sda;
  assert.match(rx, /^GPIO\d+$/);
  assert.notEqual(rx, sda, "the optimizer never shares a GPIO between signals");
  assert.deepEqual(plan.problems.filter(problem => problem.severity === "error"), []);
});

test("planFromIntent assigns GPIOs itself and never trusts a model-supplied pin", () => {
  // The model claims uart1.tx=999 and a bogus 999 pinFunction; both must be rejected.
  const plan = planFromIntent(
    { peripherals: [{ type: "uart", instance: 1 }], pinFunctions: [{ gpio: 999, function: "GPIO_OUTPUT" }] },
    "esp32s3"
  );
  assert.ok(plan.dropped.some(entry => /GPIO999: does not exist/.test(entry)));
  const tx = plan.config.peripherals!.uart1.signals.tx;
  assert.match(tx, /^GPIO\d+$/);
  assert.notEqual(tx, "GPIO999");
  assert.deepEqual(plan.config.pins, []);
});

test("planFromIntent reports what it had to drop instead of silently inventing pins", () => {
  const unavailable = planFromIntent({ peripherals: [{ type: "camera_mipi", instance: 0 }] }, "esp32s3");
  assert.ok(unavailable.dropped.some(entry => /camera_mipi0: not available on esp32s3/.test(entry)));
  assert.deepEqual(unavailable.config.peripherals ?? {}, {});

  const badSignal = planFromIntent({ peripherals: [{ type: "uart", instance: 1, signals: ["tx", "bogus"] }] }, "esp32s3");
  assert.ok(badSignal.dropped.some(entry => /uart1\.bogus: no such signal/.test(entry)));
  assert.ok(badSignal.config.peripherals?.uart1.signals.tx);
  assert.equal(badSignal.config.peripherals?.uart1.signals.bogus, undefined);

  const duplicate = planFromIntent({
    peripherals: [{ type: "uart", instance: 1 }, { type: "uart", instance: 1 }]
  }, "esp32s3");
  assert.ok(duplicate.dropped.some(entry => /uart1: requested more than once/.test(entry)));
});

test("planFromIntent keeps pinned signals and respects occupied GPIOs (minimal-change repair)", () => {
  const first = planFromIntent({ peripherals: [{ type: "i2c", instance: 0 }] }, "esp32s3");
  const sda = first.config.peripherals!.i2c0.signals.sda;
  const keep = planFromIntent({ peripherals: [{ type: "i2c", instance: 0 }] }, "esp32s3", {
    pinned: { "i2c0.sda": Number(sda.slice(4)) }
  });
  assert.equal(keep.config.peripherals!.i2c0.signals.sda, sda, "an unpinned-only re-solve keeps the pinned signal");

  const used = Number(first.config.peripherals!.i2c0.signals.scl.slice(4));
  const moved = planFromIntent({ peripherals: [{ type: "i2c", instance: 0 }] }, "esp32s3", { occupied: [used] });
  assert.notEqual(moved.config.peripherals!.i2c0.signals.scl, `GPIO${used}`, "occupied GPIOs are not reused");
});

test("planFromIntent surfaces an unsatisfiable request instead of writing a partial route", () => {
  const adc = peripheralDefinition("adc", 1, "esp32s3")!;
  const analog = candidatesFor(adc.signals[0], "esp32s3", 1);
  const plan = planFromIntent({ peripherals: [{ type: "adc", instance: 1 }] }, "esp32s3", { occupied: analog });
  assert.ok(plan.dropped.some(entry => /No complete pin set could be found/.test(entry)));
  assert.equal(plan.config.peripherals?.adc1?.signals.in, undefined, "no pin is invented when the bus cannot fit");
  assert.deepEqual(plan.problems.filter(problem => problem.severity === "error"), []);
});

test("the validator remains the gate: an illegal plain pin is reported as an error", () => {
  // GPIO46 is input-only on the S3, so asking for an output there must fail validation.
  const plan = planFromIntent({ pinFunctions: [{ gpio: 46, function: "GPIO_OUTPUT" }] }, "esp32s3");
  assert.ok(plan.problems.some(problem => problem.severity === "error" && problem.gpio === 46));
});

test("summarizeConfig and intentFromConfig describe a produced configuration", () => {
  const plan = planFromIntent({
    peripherals: [{ type: "uart", instance: 1 }],
    pinFunctions: [{ gpio: 5, function: "GPIO_INPUT" }]
  }, "esp32s3");
  const lines = summarizeConfig(plan.config);
  assert.ok(lines.some(line => line.startsWith("uart1 (uart:1)")));
  assert.ok(lines.some(line => /plain GPIO: GPIO5=GPIO_INPUT/.test(line)));

  const intent = intentFromConfig(plan.config);
  assert.equal(intent.chip, "esp32s3");
  assert.deepEqual(intent.peripherals, [{ type: "uart", instance: 1, signals: ["tx", "rx"] }]);
  assert.deepEqual(intent.pinFunctions, [{ gpio: 5, function: "GPIO_INPUT" }]);
});

test("deriveRepairContext keeps valid routes pinned and only frees the broken ones", () => {
  let config = addPeripheral(createConfig("esp32s3"), "uart", 1);
  config = setSignal(config, "uart1", "tx", 17);
  config = setSignal(config, "uart1", "rx", 17); // deliberate conflict
  const problems = validateGpio(config, undefined, {});
  assert.ok(problems.some(problem => problem.severity === "error"));
  const context = deriveRepairContext(config, problems);
  assert.equal(context.pinned["uart1.tx"], 17, "the signal that was not flagged keeps its pin");
  assert.equal(context.pinned["uart1.rx"], undefined, "the conflicting signal is free to move");
  assert.deepEqual(context.occupied, []);
});

test("deriveRepairContext treats plain pins as occupied", () => {
  const config = { ...createConfig("esp32s3"), pins: [{ gpio: 8, function: "GPIO_INPUT" }] };
  const context = deriveRepairContext(config, []);
  assert.deepEqual(context.occupied, [8]);
  assert.deepEqual(context.pinned, {});
});

test("prompt helpers describe the chip facts the model must respect", () => {
  assert.deepEqual(supportedChips(), ["esp32s3", "esp32c6", "esp32p4", "esp32c3", "esp32c2"]);

  const catalogue = buildCatalogue("esp32s3");
  const uart = catalogue.find(entry => entry.type === "uart")!;
  assert.deepEqual(uart.instances, [0, 1, 2]);
  assert.deepEqual(uart.required, ["tx", "rx"]);
  assert.ok(uart.optional.includes("rts"));
  assert.deepEqual(buildCatalogue("esp32c5"), []);

  const avoid = pinsToAvoid("esp32s3");
  assert.deepEqual(avoid.strapping, [0, 3, 45, 46]);
  assert.ok(avoid.memory.includes(26));
  assert.deepEqual(avoid.usbJtag, [19, 20]);
  assert.deepEqual(pinsToAvoid("esp32c5"), { strapping: [], memory: [], usbJtag: [] });
});

test("detectChip reads the target from a natural-language request", () => {
  assert.equal(detectChip("use the P4 with a MIPI display"), "esp32p4");
  assert.equal(detectChip("ESP32-S3 devkit"), "esp32s3");
  assert.equal(detectChip("wire an I2C bus on esp32c6"), "esp32c6");
  assert.equal(detectChip("a small esp32-c3 project"), "esp32c3");
  assert.equal(detectChip("use an ESP32-C2 module"), "esp32c2");
  assert.equal(detectChip("configure a camera"), undefined);
  assert.equal(detectChip(""), undefined);
});

test("generation and repair prompts carry the catalogue, the request and the errors", () => {
  const generation = generationPrompt("configure a DVP camera on the P4", { chip: "esp32p4" });
  assert.match(generation, /never write GPIO numbers/);
  assert.match(generation, /Target chip: esp32p4/);
  assert.match(generation, /configure a DVP camera on the P4/);
  assert.match(generation, /camera_mipi/);

  const repair = repairPrompt("fix it", { chip: "esp32s3" }, {
    chip: "esp32s3",
    peripherals: [{ type: "uart", instance: 1 }]
  }, ["uart1.rx: invalid signal or GPIO route (GPIO999)."]);
  assert.match(repair, /"instance": 1/);
  assert.match(repair, /uart1\.rx: invalid signal or GPIO route/);
  assert.match(repair, /Return a corrected JSON object/);

  const noProblems = repairPrompt("", { chip: "esp32s3" }, { chip: "esp32s3" }, []);
  assert.match(noProblems, /- \(none\)/);
});
