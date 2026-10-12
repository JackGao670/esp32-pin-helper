import test from "node:test";
import assert from "node:assert/strict";
import { createConfig, parseConfig, serializeConfig, setPin } from "../src/core/model/config";
import { device } from "../src/database/loader";
import { validateGpio } from "../src/core/validator/gpio";

test("ESP32-S3 contains exactly the 45 documented GPIOs", () => {
  assert.equal(device.pins.length, 45);
  assert.equal(new Set(device.pins.map(pin => pin.gpio)).size, 45);
  assert.ok(!device.pins.some(pin => pin.gpio >= 22 && pin.gpio <= 25));
  assert.ok(device.pins.every(pin => pin.capabilities.input));
  // GPIO46 is input-only (MTDO strapping); every other documented GPIO is output capable.
  assert.equal(device.pins.filter(pin => !pin.capabilities.output).map(pin => pin.gpio).join(","), "46");
});

test("chip capabilities and restrictions match source summary", () => {
  assert.ok(device.pins.find(pin => pin.gpio === 3)?.restrictions.some(text => text.includes("Strapping")));
  assert.equal(device.pins.find(pin => pin.gpio === 0)?.capabilities.analog, false);
  assert.equal(device.pins.find(pin => pin.gpio === 1)?.capabilities.analog, true);
  assert.ok(device.pins.find(pin => pin.gpio === 35)?.restrictions.some(text => text.includes("Octal")));
});

test("round trip and edits preserve unknown document and assignment fields", () => {
  const config = parseConfig('{"version":1,"target":{"chip":"esp32s3","variant":"custom"},"pins":[{"gpio":17,"function":"GPIO_INPUT","label":"sensor"}],"vendor":{"value":42}}');
  assert.deepEqual(parseConfig(serializeConfig(config)), config);
  const edited = setPin(config, 17, "GPIO_OUTPUT");
  assert.equal(edited.pins[0].label, "sensor");
  assert.deepEqual(edited.vendor, { value: 42 });
  assert.equal(config.pins[0].function, "GPIO_INPUT");
});

test("set and clear assignment without duplicates", () => {
  const first = setPin(createConfig(), 17, "GPIO_INPUT");
  const second = setPin(first, 17, "GPIO_OUTPUT");
  assert.equal(second.pins.length, 1);
  assert.deepEqual(setPin(second, 17, null).pins, []);
});

test("malformed models and unsupported versions are rejected", () => {
  for (const text of ["null", "[]", '{"version":2}', '{"version":1,"target":{"chip":"esp32s3"},"pins":[{"gpio":-1,"function":"GPIO_INPUT"}]}',
    '{"version":1,"target":{"chip":"esp32s3"},"pins":[],"peripherals":{"uart":{"type":"uart","instance":0,"signals":{"tx":17}}}}']) {
    assert.throws(() => parseConfig(text));
  }
});

test("GPIO validation catches duplicates and nonexistent pins", () => {
  const config = createConfig();
  config.pins = [{ gpio: 17, function: "GPIO_INPUT" }, { gpio: 17, function: "GPIO_OUTPUT" }, { gpio: 22, function: "GPIO_INPUT" }];
  assert.equal(validateGpio(config).filter(problem => problem.severity === "error").length, 2);
  assert.throws(() => setPin(config, 17, "GPIO_INPUT"), /duplicate/);
});

test("strapping and memory assignments warn, ordinary GPIO does not", () => {
  assert.equal(validateGpio(setPin(createConfig(), 17, "GPIO_OUTPUT")).length, 0);
  assert.equal(validateGpio(setPin(createConfig(), 0, "GPIO_INPUT"))[0].severity, "warning");
  assert.match(validateGpio(setPin(createConfig(), 26, "GPIO_OUTPUT"))[0].message, /Flash/);
});

test("unknown functions are preserved and explicitly not validated", () => {
  const config = createConfig();
  config.pins = [{ gpio: 17, function: "UART1_TX" }];
  assert.match(validateGpio(config)[0].message, /not validated/);
  assert.deepEqual(parseConfig(serializeConfig(config)), config);
});
