import test from "node:test";
import assert from "node:assert/strict";
import { createConfig, serializeConfig, setPin, type PinConfigDocument } from "../src/core/model/config";
import { addPeripheral, setSignal } from "../src/core/model/peripherals";
import { recommendAssignment } from "../src/core/optimizer/assign";
import { validateGpio } from "../src/core/validator/gpio";
import { diagnosticProblems } from "../src/vscode/diagnosticModel";
import { getDevice } from "../src/database/loader";

const CHIP = "esp32s3";

/** The widest realistic S3 file: a legal peripheral mix plus a plain pin on every remaining GPIO. */
function largestConfig(): PinConfigDocument {
  const device = getDevice(CHIP)!;
  const [plan] = recommendAssignment([
    { type: "uart", instance: 1 }, { type: "i2c", instance: 0 }, { type: "spi", instance: 2 },
    { type: "ledc", instance: 0 }, { type: "rmt", instance: 0 }, { type: "adc", instance: 1 }
  ], { maxPlans: 1 }, CHIP);
  let config = createConfig(CHIP);
  const taken = new Set<number>();
  for (const [owner, peripheral] of Object.entries(plan?.peripherals ?? {})) {
    config = addPeripheral(config, peripheral.type, peripheral.instance);
    for (const [signal, ref] of Object.entries(peripheral.signals)) {
      config = setSignal(config, owner, signal, Number(ref.slice(4)));
      taken.add(Number(ref.slice(4)));
    }
  }
  for (const pin of device.pins) {
    if (taken.has(pin.gpio)) continue;
    config = setPin(config, pin.gpio, pin.capabilities.output ? "GPIO_OUTPUT" : "GPIO_INPUT");
  }
  return config;
}

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

test("validating the largest S3 configuration stays under the 100ms budget (§4.7)", () => {
  const config = largestConfig();
  const text = serializeConfig(config);
  const assignments = config.pins.length + Object.values(config.peripherals ?? {})
    .reduce((total, peripheral) => total + Object.keys(peripheral.signals).length, 0);
  assert.ok(assignments >= 40, `the baseline must be a large file, got ${assignments} assignments`);

  // Warm up the module-level data lookups so the first timed run is not penalised.
  validateGpio(config);
  diagnosticProblems(text);

  const runs = 25;
  const validate: number[] = [];
  const diagnostics: number[] = [];
  for (let index = 0; index < runs; index++) {
    let start = performance.now();
    validateGpio(config);
    validate.push(performance.now() - start);

    start = performance.now();
    diagnosticProblems(text);
    diagnostics.push(performance.now() - start);
  }

  assert.ok(p95(validate) < 100, `validateGpio P95 ${p95(validate).toFixed(1)}ms must stay under 100ms`);
  assert.ok(p95(diagnostics) < 100, `diagnosticProblems P95 ${p95(diagnostics).toFixed(1)}ms must stay under 100ms`);
});
