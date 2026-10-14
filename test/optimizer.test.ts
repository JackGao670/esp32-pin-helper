import test from "node:test";
import assert from "node:assert/strict";
import { recommendAssignment, boardHintsFromProfile } from "../src/core/optimizer/assign";
import type { AssignmentPlan, BoardHints, PeripheralRequest } from "../src/core/optimizer/assign";
import { getBoardProfile } from "../src/database/boardLoader";
import { addPeripheral, setSignal } from "../src/core/model/peripherals";
import { createConfig } from "../src/core/model/config";
import { validateGpio } from "../src/core/validator/gpio";

const s3Hints = boardHintsFromProfile(getBoardProfile("espressif", "esp32-s3-devkitc-1")!);

function gpiosOf(plan: ReturnType<typeof recommendAssignment>[number], owner: string): number[] {
  return Object.values(plan.peripherals[owner].signals).map(ref => Number(ref.slice(4)));
}

test("auto-assignment prefers the board's default route", () => {
  const [plan] = recommendAssignment([{ type: "i2c", instance: 0 }], undefined, "esp32s3", { board: s3Hints });
  assert.equal(plan.peripherals.i2c0.signals.sda, "GPIO8");
  assert.equal(plan.peripherals.i2c0.signals.scl, "GPIO9");
});

test("strapping pins are avoided by default and used when the preference is disabled", () => {
  const strict = recommendAssignment([{ type: "uart", instance: 1 }], undefined, "esp32s3")[0];
  const strictGpios = gpiosOf(strict, "uart1");
  assert.ok(!strictGpios.some(gpio => [0, 3, 45, 46].includes(gpio)), "strapping pins should be avoided by default");

  const lax = recommendAssignment([{ type: "uart", instance: 1 }], { avoidStrapping: false }, "esp32s3")[0];
  assert.ok(gpiosOf(lax, "uart1").includes(0), "with avoidance off the lowest GPIO (0) becomes preferable");
});

test("occupied GPIOs are never reused", () => {
  const [plan] = recommendAssignment([{ type: "i2c", instance: 0 }], undefined, "esp32s3",
    { board: s3Hints, occupied: [8, 9] });
  const gpios = gpiosOf(plan, "i2c0");
  assert.ok(!gpios.includes(8) && !gpios.includes(9), "occupied pins must be excluded");
});

test("an accepted signal is pinned to its GPIO", () => {
  const [plan] = recommendAssignment([{ type: "i2c", instance: 0 }], { maxPlans: 1 }, "esp32s3",
    { board: s3Hints, pinned: { "i2c0.sda": 21 } });
  assert.equal(plan.peripherals.i2c0.signals.sda, "GPIO21", "the pinned pin must be honoured");
});

test("a rejected pin is dropped for that signal only", () => {
  const [plan] = recommendAssignment([{ type: "i2c", instance: 0 }], { maxPlans: 1 }, "esp32s3",
    { board: s3Hints, blocked: { "i2c0.sda": [8] } });
  assert.notEqual(plan.peripherals.i2c0.signals.sda, "GPIO8", "the rejected pin must be skipped for sda");
  assert.equal(plan.peripherals.i2c0.signals.scl, "GPIO9", "the other signal keeps its board default route");
});

test("returns up to maxPlans ranked plans with conflict-free pins", () => {
  const plans = recommendAssignment([{ type: "i2c", instance: 0 }], { maxPlans: 3 }, "esp32s3", { board: s3Hints });
  assert.ok(plans.length >= 1 && plans.length <= 3);
  assert.ok(plans[0].score >= plans[plans.length - 1].score, "plans must be ranked by score");
  for (const plan of plans) {
    const gpios = gpiosOf(plan, "i2c0");
    assert.equal(new Set(gpios).size, gpios.length, "a plan must not assign the same GPIO twice");
  }
});

test("assigns every required signal and yields a config with no validation errors", () => {
  const [plan] = recommendAssignment([{ type: "camera", instance: 0 }], { maxPlans: 1 }, "esp32s3", { board: s3Hints });
  const signals = plan.peripherals.camera0.signals;
  assert.equal(Object.keys(signals).length, 12, "DVP camera has 12 required signals");
  assert.equal(new Set(gpiosOf(plan, "camera0")).size, 12, "all camera signals must map to distinct pins");

  let config = addPeripheral(createConfig("esp32s3"), "camera", 0);
  for (const [signal, ref] of Object.entries(signals)) config = setSignal(config, "camera0", signal, Number(ref.slice(4)));
  assert.equal(validateGpio(config).filter(problem => problem.severity === "error").length, 0);
});

test("explicit signal subset limits the assignment", () => {
  const [plan] = recommendAssignment([{ type: "i2s", instance: 0, signals: ["bclk", "ws", "dout"] }],
    { maxPlans: 1 }, "esp32s3");
  assert.deepEqual(Object.keys(plan.peripherals.i2s0.signals).sort(), ["bclk", "dout", "ws"]);
});

test("unsupported peripherals produce no plan", () => {
  assert.deepEqual(recommendAssignment([{ type: "lcd", instance: 0 }], undefined, "esp32c6"), []);
});

// §3.5 — typical combination coverage + solve-time budget.
type Chip = "esp32s3" | "esp32c6" | "esp32p4";
interface Scenario { name: string; chip: Chip; requests: PeripheralRequest[]; board?: BoardHints }

const SPI_4WIRE = ["sclk", "mosi", "miso", "cs"];
const SD_4BIT = ["clk", "cmd", "d0", "d1", "d2", "d3"];

const COMBINATIONS: Scenario[] = [
  { name: "S3 · UART0 (board default route)", chip: "esp32s3", board: s3Hints,
    requests: [{ type: "uart", instance: 0 }] },
  { name: "S3 · UART1 + I2C0 + SPI2 4-wire", chip: "esp32s3", board: s3Hints,
    requests: [{ type: "uart", instance: 1 }, { type: "i2c", instance: 0 },
      { type: "spi", instance: 2, signals: SPI_4WIRE }] },
  { name: "S3 · LEDC + RMT + ADC1", chip: "esp32s3", board: s3Hints,
    requests: [{ type: "ledc", instance: 0 }, { type: "ledc", instance: 1 },
      { type: "rmt", instance: 4 }, { type: "adc", instance: 1 }] },
  { name: "S3 · I2S0 duplex + TWAI0", chip: "esp32s3", board: s3Hints,
    requests: [{ type: "i2s", instance: 0, signals: ["bclk", "ws", "dout", "din"] },
      { type: "twai", instance: 0 }] },
  { name: "S3 · SDMMC1 4-bit + USB", chip: "esp32s3", board: s3Hints,
    requests: [{ type: "sdmmc", instance: 1, signals: SD_4BIT }, { type: "usb", instance: 0 }] },
  { name: "S3 · Camera (DVP 8-bit)", chip: "esp32s3", board: s3Hints,
    requests: [{ type: "camera", instance: 0 }] },
  { name: "S3 · Camera + LCD_MCU 8080", chip: "esp32s3", board: s3Hints,
    requests: [{ type: "camera", instance: 0 }, { type: "lcd_mcu", instance: 0 }] },
  { name: "S3 · full mix (11 peripherals)", chip: "esp32s3", board: s3Hints,
    requests: [{ type: "uart", instance: 0 }, { type: "uart", instance: 1 }, { type: "i2c", instance: 0 },
      { type: "spi", instance: 2, signals: SPI_4WIRE }, { type: "ledc", instance: 0 }, { type: "ledc", instance: 1 },
      { type: "adc", instance: 1 }, { type: "rmt", instance: 4 },
      { type: "i2s", instance: 0, signals: ["bclk", "ws", "dout", "din"] },
      { type: "twai", instance: 0 }, { type: "sdmmc", instance: 1, signals: SD_4BIT }] },
  { name: "C6 · UART0 + I2C0 + SPI2 4-wire + TWAI0", chip: "esp32c6",
    requests: [{ type: "uart", instance: 0 }, { type: "i2c", instance: 0 },
      { type: "spi", instance: 2, signals: SPI_4WIRE }, { type: "twai", instance: 0 }] },
  { name: "C6 · full mix (10 peripherals)", chip: "esp32c6",
    requests: [{ type: "uart", instance: 0 }, { type: "uart", instance: 1 }, { type: "i2c", instance: 0 },
      { type: "spi", instance: 2, signals: SPI_4WIRE }, { type: "ledc", instance: 0 }, { type: "adc", instance: 1 },
      { type: "rmt", instance: 0 }, { type: "i2s", instance: 0 }, { type: "twai", instance: 0 },
      { type: "usb", instance: 0 }] },
  { name: "P4 · UART1 + I2C0 + SPI2 4-wire + SDMMC1 4-bit", chip: "esp32p4",
    requests: [{ type: "uart", instance: 1 }, { type: "i2c", instance: 0 },
      { type: "spi", instance: 2, signals: SPI_4WIRE }, { type: "sdmmc", instance: 1, signals: SD_4BIT }] },
  { name: "P4 · Camera + LCD_MCU + I2C0 + UART0", chip: "esp32p4",
    requests: [{ type: "camera", instance: 0 }, { type: "lcd_mcu", instance: 0 },
      { type: "i2c", instance: 0 }, { type: "uart", instance: 0 }] },
  { name: "P4 · full mix (11 peripherals)", chip: "esp32p4",
    requests: [{ type: "uart", instance: 0 }, { type: "uart", instance: 1 }, { type: "i2c", instance: 0 },
      { type: "spi", instance: 2, signals: SPI_4WIRE }, { type: "ledc", instance: 0 }, { type: "adc", instance: 1 },
      { type: "rmt", instance: 0 }, { type: "i2s", instance: 0 }, { type: "twai", instance: 0 },
      { type: "sdmmc", instance: 1, signals: SD_4BIT }, { type: "usb", instance: 0 }] }
];

function applyPlan(chip: Chip, plan: AssignmentPlan): ReturnType<typeof createConfig> {
  let config = createConfig(chip);
  for (const [owner, peripheral] of Object.entries(plan.peripherals)) {
    config = addPeripheral(config, peripheral.type, peripheral.instance);
    for (const [signal, ref] of Object.entries(peripheral.signals)) {
      config = setSignal(config, owner, signal, Number(ref.slice(4)));
    }
  }
  return config;
}

test("typical peripheral combinations are solved, legal and fast (§3.5)", () => {
  assert.ok(COMBINATIONS.length >= 10, "the matrix must cover at least 10 typical combinations");
  // Warm up the module's data lookups so the first timed run is not penalised.
  recommendAssignment([{ type: "uart", instance: 0 }], { maxPlans: 1 }, "esp32s3");
  const timings: number[] = [];
  for (const scenario of COMBINATIONS) {
    const start = performance.now();
    const [plan] = recommendAssignment(scenario.requests, { maxPlans: 1 }, scenario.chip, { board: scenario.board });
    const elapsed = performance.now() - start;
    timings.push(elapsed);
    assert.ok(plan, `${scenario.name}: expected at least one plan`);
    const gpios = Object.values(plan.peripherals)
      .flatMap(peripheral => Object.values(peripheral.signals).map(ref => Number(ref.slice(4))));
    assert.equal(new Set(gpios).size, gpios.length, `${scenario.name}: GPIOs must not be reused`);
    const errors = validateGpio(applyPlan(scenario.chip, plan)).filter(problem => problem.severity === "error");
    assert.deepEqual(errors.map(problem => problem.message), [], `${scenario.name}: plan must validate cleanly`);
    assert.ok(elapsed < 1000, `${scenario.name}: solved in ${elapsed.toFixed(1)}ms, expected < 1000ms`);
  }
  const sorted = [...timings].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
  assert.ok(p95 < 500, `P95 solve time ${p95.toFixed(1)}ms must stay under 500ms`);
});
