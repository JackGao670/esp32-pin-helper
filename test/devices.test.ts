import test from "node:test";
import assert from "node:assert/strict";
import { getDevice } from "../src/database/loader";
import { definition, candidates } from "../src/core/resolver/peripherals";
import { createConfig } from "../src/core/model/config";
import { addPeripheral, selectTarget, setSignal } from "../src/core/model/peripherals";
import { validateGpio } from "../src/core/validator/gpio";
import { diagnosticProblems } from "../src/vscode/diagnosticModel";

test("C6 GPIO capabilities and restrictions match official summary", () => {
  const device = getDevice("esp32c6")!;
  assert.equal(device.pins.length, 31);
  assert.deepEqual(device.pins.map(pin => pin.gpio), Array.from({ length: 31 }, (_, i) => i));
  assert.equal(device.pins[0].capabilities.analog, true);
  assert.equal(device.pins[7].capabilities.analog, false);
  assert.ok(device.pins[15].restrictions.some(text => /Strapping/.test(text)));
  assert.ok(device.pins[12].restrictions.some(text => /JTAG/.test(text)));
  assert.ok(device.pins[14].restrictions.some(text => /bonded/.test(text)));
  assert.equal(getDevice("esp32s4"), undefined);
});

test("ordinary C6 controller instances do not inherit S3 resources", () => {
  assert.ok(definition("uart", 1, "esp32c6"));
  assert.equal(definition("uart", 2, "esp32c6"), undefined);
  assert.equal(definition("i2c", 1, "esp32c6"), undefined);
  assert.equal(definition("spi", 3, "esp32c6"), undefined);
  assert.ok(definition("spi", 2, "esp32c6"));
  assert.equal(candidates(definition("uart", 0, "esp32c6")!.signals[0], "esp32c6").length, 31);
});

test("validation uses target-specific pin existence and restrictions", () => {
  const config = createConfig("esp32c6");
  config.pins = [{ gpio: 22, function: "GPIO_OUTPUT" }];
  assert.equal(validateGpio(config).length, 0);
  assert.ok(validateGpio({ ...config, target: { chip: "esp32s3" } }).some(p => p.severity === "error"));
  config.pins[0].gpio = 45;
  assert.match(validateGpio(config)[0].message, /ESP32-C6/);
  assert.deepEqual(diagnosticProblems(JSON.stringify(createConfig("esp32c6"))), []);
});

test("C6 peripheral assignments validate and switching preserves non-chip metadata", () => {
  let config = addPeripheral(createConfig("esp32c6"), "uart", 1);
  // GPIO16/17 are the on-board USB-to-UART bridge (uart0) on the C6 devkits, so use free pins
  // to assert the route itself is valid with no diagnostics.
  config = setSignal(config, "uart1", "tx", 22);
  config = setSignal(config, "uart1", "rx", 23);
  assert.deepEqual(validateGpio(config), []);
  assert.throws(() => addPeripheral(config, "uart", 2), /Unsupported/);
  // Switching chips keeps the UART assignments and re-validates them for the new chip.
  const retargeted = selectTarget(config, "esp32s3");
  assert.equal(retargeted.target.chip, "esp32s3");
  assert.deepEqual(retargeted.peripherals, config.peripherals);
  assert.deepEqual(retargeted.pins, config.pins);
  // A peripheral the new chip lacks is reported as a diagnostic, not a blocking error.
  const camera = addPeripheral(createConfig("esp32s3"), "camera", 0);
  assert.ok(validateGpio(selectTarget(camera, "esp32c6")).some(p => /Unsupported peripheral camera:0/.test(p.message)));
  const empty = createConfig();
  empty.target.package = "QFN56";
  empty.vendor = { name: "keep" };
  const changed = selectTarget(empty, "esp32c6");
  assert.equal(changed.target.chip, "esp32c6");
  assert.equal(changed.target.package, undefined);
  assert.deepEqual(changed.vendor, empty.vendor);
  assert.throws(() => selectTarget(empty, "esp32s4"), /Unsupported/);
});

test("P4 GPIO capabilities, boot and USB pins do not inherit C6 or S3 restrictions", () => {
  const device = getDevice("esp32p4")!;
  assert.equal(device.pins.length, 55);
  assert.equal(device.pins[54].capabilities.analog, true);
  assert.equal(device.pins[16].capabilities.analog, true);
  assert.equal(device.pins[15].capabilities.analog, false);
  assert.equal(device.pins[15].capabilities.rtc, true);
  assert.equal(device.pins[16].capabilities.rtc, false);
  assert.deepEqual(device.pins.filter(pin => pin.restrictions.some(text => /Strapping/.test(text))).map(pin => pin.gpio), [34, 35, 36, 37, 38]);
  assert.ok(device.pins[24].restrictions.some(text => /JTAG/.test(text)));
  assert.deepEqual(device.pins[45].restrictions, []);
});

test("P4 ships in one QFN104 package that bonds out every GPIO", () => {
  const device = getDevice("esp32p4")!;
  assert.match(device.scope, /QFN104/);
  // The single package bonds out all 55 GPIOs, so no pin is flagged as missing on a variant.
  assert.equal(device.pins.length, 55);
  assert.equal(device.pins.some(pin => pin.restrictions.some(text => /bonded/.test(text))), false);
  // Flash/PSRAM sit on dedicated pads, so no GPIO carries a memory reservation either.
  assert.equal(device.pins.some(pin => pin.restrictions.some(text => /Flash\/PSRAM/.test(text))), false);
});

test("P4 standard controller instances and routes are target-specific", () => {
  assert.ok(definition("uart", 4, "esp32p4"));
  assert.equal(definition("uart", 5, "esp32p4"), undefined);
  assert.ok(definition("i2c", 1, "esp32p4"));
  assert.equal(definition("i2c", 2, "esp32p4"), undefined);
  assert.ok(definition("spi", 2, "esp32p4"));
  assert.equal(candidates(definition("uart", 4, "esp32p4")!.signals[0], "esp32p4").length, 55);
  let config = addPeripheral(createConfig("esp32p4"), "uart", 4);
  // GPIO53 is reserved by the P4 Function-EV board (audio PA enable), so use free pins
  // to assert the route itself is valid with no diagnostics.
  config = setSignal(config, "uart4", "tx", 20);
  config = setSignal(config, "uart4", "rx", 21);
  assert.deepEqual(validateGpio(config), []);
  assert.deepEqual(diagnosticProblems(JSON.stringify(config)), []);
  assert.throws(() => addPeripheral(config, "uart", 5), /Unsupported/);
  config.pins.push({ gpio: 55, function: "GPIO_OUTPUT" });
  assert.ok(validateGpio(config).some(problem => /ESP32-P4/.test(problem.message)));
});

test("P4 LP UART/I2C only reach the low-power domain pads GPIO0-15", () => {
  assert.ok(definition("lpuart", 0, "esp32p4"));
  assert.equal(definition("lpuart", 1, "esp32p4"), undefined);
  assert.ok(definition("lpi2c", 0, "esp32p4"));
  assert.equal(definition("lpi2c", 1, "esp32p4"), undefined);
  // The LP controllers are P4-only; they do not exist on the other supported chips.
  assert.equal(definition("lpuart", 0, "esp32s3"), undefined);
  assert.equal(definition("lpi2c", 0, "esp32c6"), undefined);
  const lpDomain = Array.from({ length: 16 }, (_, i) => i);
  const signal = (type: string, id: string) => definition(type, 0, "esp32p4")!.signals.find(entry => entry.id === id)!;
  assert.deepEqual(candidates(signal("lpuart", "tx"), "esp32p4"), lpDomain);
  assert.deepEqual(candidates(signal("lpi2c", "sda"), "esp32p4"), lpDomain);
  // HP-only pads (e.g. GPIO20) must never be offered for an LP signal.
  assert.equal(candidates(signal("lpuart", "tx"), "esp32p4").includes(20), false);
  // Routing an LP signal to an HP pad is a hard error.
  const bad = setSignal(addPeripheral(createConfig("esp32p4"), "lpuart", 0), "lpuart0", "tx", 20);
  assert.ok(validateGpio(bad).some(problem => problem.severity === "error" && problem.owner === "lpuart0"));
  // The documented LP IO MUX defaults (LP_GPIO14 / LP_GPIO15) route cleanly.
  let good = setSignal(addPeripheral(createConfig("esp32p4"), "lpuart", 0), "lpuart0", "tx", 14);
  good = setSignal(good, "lpuart0", "rx", 15);
  assert.deepEqual(validateGpio(good), []);
});

test("P4 LP SPI/I2S only reach the low-power domain pads GPIO0-15", () => {
  assert.ok(definition("lpspi", 0, "esp32p4"));
  assert.equal(definition("lpspi", 1, "esp32p4"), undefined);
  assert.ok(definition("lpi2s", 0, "esp32p4"));
  assert.equal(definition("lpi2s", 1, "esp32p4"), undefined);
  // The LP controllers are P4-only; they do not exist on the other supported chips.
  assert.equal(definition("lpspi", 0, "esp32s3"), undefined);
  assert.equal(definition("lpi2s", 0, "esp32c6"), undefined);
  const lpDomain = Array.from({ length: 16 }, (_, i) => i);
  const signal = (type: string, id: string) => definition(type, 0, "esp32p4")!.signals.find(entry => entry.id === id)!;
  // The LP I2S is a slave receiver, so its clock and data lines are inputs from an external master.
  assert.equal(signal("lpi2s", "bclk").direction, "input");
  assert.equal(signal("lpi2s", "din").direction, "input");
  assert.deepEqual(candidates(signal("lpspi", "sclk"), "esp32p4"), lpDomain);
  assert.deepEqual(candidates(signal("lpi2s", "din"), "esp32p4"), lpDomain);
  // HP-only pads (e.g. GPIO20) must never be offered for an LP signal.
  assert.equal(candidates(signal("lpi2s", "bclk"), "esp32p4").includes(20), false);
  // Routing an LP signal to an HP pad is a hard error.
  const bad = setSignal(addPeripheral(createConfig("esp32p4"), "lpspi", 0), "lpspi0", "sclk", 20);
  assert.ok(validateGpio(bad).some(problem => problem.severity === "error" && problem.owner === "lpspi0"));
  // A plausible LP I2S slave-RX wiring on GPIO2-4 validates cleanly.
  let good = setSignal(addPeripheral(createConfig("esp32p4"), "lpi2s", 0), "lpi2s0", "bclk", 2);
  good = setSignal(good, "lpi2s0", "ws", 3);
  good = setSignal(good, "lpi2s0", "din", 4);
  assert.deepEqual(validateGpio(good), []);
});

test("P1 peripherals expose target-specific instance counts", () => {
  assert.ok(definition("ledc", 7, "esp32s3"));
  assert.ok(definition("ledc", 7, "esp32p4"));
  assert.ok(definition("ledc", 5, "esp32c6"));
  assert.equal(definition("ledc", 7, "esp32c6"), undefined);
  assert.ok(definition("rmt", 7, "esp32s3"));
  assert.ok(definition("rmt", 3, "esp32c6"));
  assert.equal(definition("rmt", 4, "esp32c6"), undefined);
  assert.ok(definition("i2s", 1, "esp32s3"));
  assert.equal(definition("i2s", 1, "esp32c6"), undefined);
  assert.ok(definition("i2s", 2, "esp32p4"));
});

test("ADC units map to their documented GPIOs per chip", () => {
  const s3 = definition("adc", 1, "esp32s3")!.signals[0];
  assert.deepEqual(candidates(s3, "esp32s3", 1), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(candidates(s3, "esp32s3", 2), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  const c6 = definition("adc", 1, "esp32c6")!.signals[0];
  assert.deepEqual(candidates(c6, "esp32c6", 1), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(definition("adc", 2, "esp32c6"), undefined);
  const p4 = definition("adc", 1, "esp32p4")!.signals[0];
  assert.deepEqual(candidates(p4, "esp32p4", 1), [16, 17, 18, 19, 20, 21, 22, 23]);
  assert.deepEqual(candidates(p4, "esp32p4", 2), [49, 50, 51, 52, 53, 54]);
});

test("ADC, LEDC and I2S assignments validate; ADC pins outside the unit are errors", () => {
  let config = addPeripheral(createConfig("esp32s3"), "adc", 1);
  config = setSignal(config, "adc1", "in", 5);
  config = addPeripheral(config, "ledc", 3);
  config = setSignal(config, "ledc3", "out", 10);
  assert.deepEqual(validateGpio(config), []);
  const wrongUnit = setSignal(addPeripheral(createConfig("esp32s3"), "adc", 1), "adc1", "in", 12);
  assert.ok(validateGpio(wrongUnit).some(problem => problem.severity === "error"));
  assert.throws(() => addPeripheral(createConfig("esp32c6"), "adc", 2), /Unsupported/);
});

test("ADC2 assignment warns about the Wi-Fi sharing unit while ADC1 stays clean", () => {
  let config = addPeripheral(createConfig("esp32s3"), "adc", 2);
  config = setSignal(config, "adc2", "in", 12);
  const problems = validateGpio(config);
  assert.equal(problems.filter(problem => problem.severity === "error").length, 0);
  assert.ok(problems.some(problem => problem.severity === "warning" && problem.owner === "adc2" && /Wi-Fi/.test(problem.message)));
  assert.deepEqual(validateGpio(setSignal(addPeripheral(createConfig("esp32s3"), "adc", 1), "adc1", "in", 5)), []);
});

test("GPIO direction errors catch open-drain I2C SDA on pins without open-drain capability", () => {
  // GPIO47/48 on ESP32-S3 are output-capable but without open-drain support.
  const s3 = createConfig("esp32s3");
  s3.pins = [{ gpio: 47, function: "GPIO_OPEN_DRAIN" }];
  const sdaProblem = validateGpio(addPeripheral(s3, "i2c", 0)).find(p =>
    p.severity === "error" && /open-drain/.test(p.message));
  assert.ok(sdaProblem);
  assert.deepEqual(sdaProblem.path, ["pins", 0, "function"]);
});

test("memory and default USB Serial/JTAG pin reassignments warn, UART0 on its default JTAG pins is exempted", () => {
  const normal = setSignal(addPeripheral(createConfig("esp32s3"), "uart", 0), "uart0", "tx", 42);
  assert.equal(validateGpio(normal).filter(p => /console\/JTAG|Flash\/PSRAM/.test(p.message)).length, 0);
  // ESP32-S3 default USB Serial/JTAG pins are GPIO19 (D-) / GPIO20 (D+), not 43/44.
  const jtag = setSignal(addPeripheral(createConfig("esp32s3"), "spi", 2), "spi2", "sclk", 19);
  assert.ok(validateGpio(jtag).some(p => /USB Serial\/JTAG|console\/JTAG/.test(p.message)));
  const flash = setSignal(addPeripheral(createConfig("esp32s3"), "spi", 2), "spi2", "mosi", 27);
  const flashWarnings = validateGpio(flash).filter(p => /Flash\/PSRAM/.test(p.message));
  assert.ok(flashWarnings.some(p => p.severity === "warning"));
  const uart0 = addPeripheral(createConfig("esp32s3"), "uart", 0);
  uart0.signals = { tx: "GPIO19", rx: "GPIO20" };
  assert.equal(validateGpio(uart0).filter(p => /console\/JTAG/.test(p.message)).length, 0);
});

test("C3 GPIO capabilities, strapping, memory and USB Serial/JTAG pins match the official summary", () => {
  const device = getDevice("esp32c3")!;
  assert.equal(device.pins.length, 22);
  assert.deepEqual(device.pins.map(pin => pin.gpio), Array.from({ length: 22 }, (_, i) => i));
  // Analog pads are GPIO0-5 (ADC1 GPIO0-4 + ADC2 GPIO5); GPIO6 is digital-only.
  assert.equal(device.pins[0].capabilities.analog, true);
  assert.equal(device.pins[5].capabilities.analog, true);
  assert.equal(device.pins[6].capabilities.analog, false);
  assert.equal(device.pins[2].capabilities.rtc, true);
  assert.equal(device.pins[6].capabilities.rtc, false);
  assert.deepEqual(device.pins.filter(pin => pin.restrictions.some(text => /Strapping/.test(text))).map(pin => pin.gpio), [2, 8, 9]);
  assert.ok(device.pins[18].restrictions.some(text => /USB Serial\/JTAG/.test(text)));
  assert.ok(device.pins[12].restrictions.some(text => /Flash\/PSRAM/.test(text)));
  assert.ok(device.pins[13].restrictions.some(text => /bonded/.test(text)));
});

test("C2 GPIO capabilities, strapping, SiP-flash and USB handling match the official summary", () => {
  const device = getDevice("esp32c2")!;
  assert.equal(device.pins.length, 21);
  assert.deepEqual(device.pins.map(pin => pin.gpio), Array.from({ length: 21 }, (_, i) => i));
  assert.equal(device.pins[0].capabilities.analog, true);
  assert.equal(device.pins[4].capabilities.analog, true);
  assert.equal(device.pins[5].capabilities.analog, false);
  assert.deepEqual(device.pins.filter(pin => pin.restrictions.some(text => /Strapping/.test(text))).map(pin => pin.gpio), [8, 9]);
  // GPIO11-17 are only bonded out on non-SiP parts, so every one of them carries the variant note.
  assert.deepEqual(device.pins.filter(pin => pin.restrictions.some(text => /bonded/.test(text))).map(pin => pin.gpio), [11, 12, 13, 14, 15, 16, 17]);
  // The C2 has no USB controller, so no pin carries the USB Serial/JTAG restriction.
  assert.equal(device.pins.some(pin => pin.restrictions.some(text => /USB Serial\/JTAG/.test(text))), false);
});

test("C3 and C2 controller instances are chip-specific and do not leak S3/P4 resources", () => {
  // C3: UART 0-1, I2C 0 only, SPI 2 only, LEDC 0-5, ADC 1+2, RMT 0-3 (TX 0-1 / RX 2-3), I2S 0, USB 0, TWAI 0.
  assert.ok(definition("uart", 1, "esp32c3"));
  assert.equal(definition("uart", 2, "esp32c3"), undefined);
  assert.equal(definition("i2c", 1, "esp32c3"), undefined);
  assert.equal(definition("spi", 3, "esp32c3"), undefined);
  assert.ok(definition("ledc", 5, "esp32c3"));
  assert.equal(definition("ledc", 6, "esp32c3"), undefined);
  assert.ok(definition("rmt", 3, "esp32c3"));
  assert.equal(definition("rmt", 4, "esp32c3"), undefined);
  assert.ok(definition("i2s", 0, "esp32c3"));
  assert.ok(definition("usb", 0, "esp32c3"));
  assert.ok(definition("twai", 0, "esp32c3"));
  assert.equal(definition("sdmmc", 0, "esp32c3"), undefined);
  assert.deepEqual(candidates(definition("uart", 0, "esp32c3")!.signals[0], "esp32c3").length, 22);
  const c3adc = definition("adc", 1, "esp32c3")!.signals[0];
  assert.deepEqual(candidates(c3adc, "esp32c3", 1), [0, 1, 2, 3, 4]);
  assert.deepEqual(candidates(c3adc, "esp32c3", 2), [5]);
  // C2: UART 0-1, I2C 0, SPI 2, LEDC 0-5 and ADC1 only.
  assert.ok(definition("uart", 1, "esp32c2"));
  assert.equal(definition("i2c", 1, "esp32c2"), undefined);
  assert.ok(definition("ledc", 5, "esp32c2"));
  assert.equal(definition("adc", 2, "esp32c2"), undefined);
  assert.equal(definition("rmt", 0, "esp32c2"), undefined);
  assert.equal(definition("i2s", 0, "esp32c2"), undefined);
  assert.equal(definition("usb", 0, "esp32c2"), undefined);
  assert.equal(definition("twai", 0, "esp32c2"), undefined);
  assert.deepEqual(candidates(definition("uart", 0, "esp32c2")!.signals[0], "esp32c2").length, 21);
});

test("classic ESP32 GPIO capabilities, strapping, memory and input-only pins match the official summary", () => {
  const device = getDevice("esp32")!;
  // 34 bonded GPIOs: 0-19, 21-23, 25-27, 32-39 (GPIO20 and GPIO24/28-31 are not bonded out).
  assert.equal(device.pins.length, 34);
  assert.deepEqual(device.pins.map(pin => pin.gpio),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 37, 38, 39]);
  // ADC pins are the analog-capable pads; GPIO34-39 are input-only (ADC1) with no output path.
  assert.equal(device.pins.find(pin => pin.gpio === 34)!.capabilities.output, false);
  assert.equal(device.pins.find(pin => pin.gpio === 34)!.capabilities.openDrain, false);
  assert.equal(device.pins.find(pin => pin.gpio === 34)!.capabilities.analog, true);
  assert.equal(device.pins.find(pin => pin.gpio === 32)!.capabilities.analog, true);
  assert.equal(device.pins.find(pin => pin.gpio === 3)!.capabilities.analog, false);
  assert.equal(device.pins.find(pin => pin.gpio === 25)!.capabilities.rtc, true);
  assert.equal(device.pins.find(pin => pin.gpio === 26)!.capabilities.rtc, true);
  assert.deepEqual(device.pins.filter(pin => pin.restrictions.some(text => /Strapping/.test(text))).map(pin => pin.gpio), [0, 2, 5, 12, 15]);
  // Flash GPIO6-11 and the WROVER PSRAM pads GPIO16/17 carry the memory reservation.
  assert.deepEqual(device.pins.filter(pin => pin.restrictions.some(text => /Flash\/PSRAM/.test(text))).map(pin => pin.gpio), [6, 7, 8, 9, 10, 11, 16, 17]);
  // The classic ESP32 has no USB controller, so no pin carries a USB restriction of any kind.
  assert.equal(device.pins.some(pin => /USB/.test(pin.restrictions.join(" "))), false);
  assert.deepEqual(device.adcUnits, { "1": [36, 37, 38, 39, 32, 33, 34, 35], "2": [4, 0, 2, 15, 13, 12, 14, 27, 25, 26] });
});

test("ESP32-S2 GPIO capabilities, USB OTG pads and memory pins match the official summary", () => {
  const device = getDevice("esp32s2")!;
  // 43 GPIOs: 0-21 and 26-46 (22-25 do not exist).
  assert.equal(device.pins.length, 43);
  assert.deepEqual(device.pins.map(pin => pin.gpio),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46]);
  // GPIO46 is the only input-only pad; GPIO45/46 are strapping pins.
  assert.equal(device.pins.find(pin => pin.gpio === 46)!.capabilities.output, false);
  assert.deepEqual(device.pins.filter(pin => pin.capabilities.output === false).map(pin => pin.gpio), [46]);
  assert.deepEqual(device.pins.filter(pin => pin.restrictions.some(text => /Strapping/.test(text))).map(pin => pin.gpio), [0, 45, 46]);
  // USB OTG lives on the fixed internal-PHY pads GPIO19 (D-) / GPIO20 (D+).
  assert.deepEqual(device.pins.filter(pin => pin.restrictions.some(text => /USB OTG/.test(text))).map(pin => pin.gpio), [19, 20]);
  // Quad flash/PSRAM is on GPIO26-32; the octal variant adds GPIO33-37.
  assert.deepEqual(device.pins.filter(pin => pin.restrictions.some(text => /Usually used by Flash\/PSRAM/.test(text))).map(pin => pin.gpio), [26, 27, 28, 29, 30, 31, 32]);
  assert.deepEqual(device.pins.filter(pin => pin.restrictions.some(text => /Reserved when Octal/.test(text))).map(pin => pin.gpio), [33, 34, 35, 36, 37]);
  assert.deepEqual(device.adcUnits, { "1": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "2": [11, 12, 13, 14, 15, 16, 17, 18, 19, 20] });
});

test("ESP32 and ESP32-S2 controller instances are chip-specific and do not leak other chips' resources", () => {
  // ESP32: UART 0-2, I2C 0-1, SPI 2-3, LEDC 0-15, ADC 1+2, RMT 0-7, I2S 0-1, TWAI 0, and no USB.
  assert.ok(definition("uart", 2, "esp32"));
  assert.equal(definition("uart", 3, "esp32"), undefined);
  assert.ok(definition("i2c", 1, "esp32"));
  assert.equal(definition("spi", 1, "esp32"), undefined);
  assert.ok(definition("spi", 3, "esp32"));
  assert.ok(definition("ledc", 15, "esp32"));
  assert.equal(definition("ledc", 16, "esp32"), undefined);
  assert.ok(definition("rmt", 7, "esp32"));
  assert.equal(definition("rmt", 8, "esp32"), undefined);
  assert.ok(definition("i2s", 1, "esp32"));
  assert.ok(definition("twai", 0, "esp32"));
  assert.equal(definition("usb", 0, "esp32"), undefined);
  // Every output-capable pad can carry a UART TX line: 34 pins minus the 6 input-only ADC1 pads.
  assert.deepEqual(candidates(definition("uart", 0, "esp32")!.signals[0], "esp32").length, 28);
  // ESP32-S2: UART 0-1, I2C 0-1, SPI 2-3, LEDC 0-7, ADC 1+2, RMT 0-3, I2S 0, USB 0, TWAI 0.
  assert.ok(definition("uart", 1, "esp32s2"));
  assert.equal(definition("uart", 2, "esp32s2"), undefined);
  assert.ok(definition("ledc", 7, "esp32s2"));
  assert.equal(definition("ledc", 8, "esp32s2"), undefined);
  assert.ok(definition("rmt", 3, "esp32s2"));
  assert.equal(definition("rmt", 4, "esp32s2"), undefined);
  assert.ok(definition("i2s", 0, "esp32s2"));
  assert.equal(definition("i2s", 1, "esp32s2"), undefined);
  assert.ok(definition("usb", 0, "esp32s2"));
  assert.ok(definition("twai", 0, "esp32s2"));
  assert.equal(definition("sdmmc", 0, "esp32s2"), undefined);
  // The S2 USB OTG signals are locked to their fixed PHY pads.
  const dn = definition("usb", 0, "esp32s2")!.signals.find(signal => signal.id === "dn")!;
  const dp = definition("usb", 0, "esp32s2")!.signals.find(signal => signal.id === "dp")!;
  assert.deepEqual(candidates(dn, "esp32s2"), [19]);
  assert.deepEqual(candidates(dp, "esp32s2"), [20]);
  assert.deepEqual(candidates(definition("uart", 0, "esp32s2")!.signals[0], "esp32s2").length, 42);
});

test("C5 GPIO capabilities, strapping, memory and USB Serial/JTAG pins match the official summary", () => {
  const device = getDevice("esp32c5")!;
  // 29 GPIOs 0-28 with no gap; every pad is output-capable (no input-only pin on the C5).
  assert.equal(device.pins.length, 29);
  assert.deepEqual(device.pins.map(pin => pin.gpio), Array.from({ length: 29 }, (_, i) => i));
  assert.deepEqual(device.pins.filter(pin => pin.capabilities.output === false).map(pin => pin.gpio), []);
  assert.equal(device.pins.some(pin => /Input-only/.test(pin.restrictions.join(" "))), false);
  // ADC1 pads are GPIO1-6; GPIO0/GPIO7 are digital-only.
  assert.equal(device.pins[0].capabilities.analog, false);
  assert.equal(device.pins[1].capabilities.analog, true);
  assert.equal(device.pins[6].capabilities.analog, true);
  assert.equal(device.pins[7].capabilities.analog, false);
  // The RTC domain covers GPIO0-7.
  assert.equal(device.pins[7].capabilities.rtc, true);
  assert.equal(device.pins[8].capabilities.rtc, false);
  assert.deepEqual(device.pins.filter(pin => pin.restrictions.some(text => /Strapping/.test(text))).map(pin => pin.gpio), [2, 7, 27, 28]);
  assert.deepEqual(device.pins.filter(pin => pin.restrictions.some(text => /Flash\/PSRAM/.test(text))).map(pin => pin.gpio), [16, 17, 18, 19, 20, 21, 22]);
  // The USB Serial/JTAG PHY is fixed to GPIO13 (D-) / GPIO14 (D+); the C5 has no USB OTG.
  assert.deepEqual(device.pins.filter(pin => pin.restrictions.some(text => /USB Serial\/JTAG/.test(text))).map(pin => pin.gpio), [13, 14]);
  assert.equal(device.pins.some(pin => /USB OTG/.test(pin.restrictions.join(" "))), false);
  assert.deepEqual(device.adcUnits, { "1": [1, 2, 3, 4, 5, 6] });
});

test("C5 controller instances are chip-specific and do not leak other chips' resources", () => {
  // C5: UART 0-1, I2C 0 only, SPI 2 only, LEDC 0-5, ADC1 only, RMT 0-3, I2S 0, USB 0; no TWAI/SD host/LCD_CAM.
  assert.ok(definition("uart", 1, "esp32c5"));
  assert.equal(definition("uart", 2, "esp32c5"), undefined);
  assert.ok(definition("i2c", 0, "esp32c5"));
  assert.equal(definition("i2c", 1, "esp32c5"), undefined);
  assert.ok(definition("spi", 2, "esp32c5"));
  assert.equal(definition("spi", 3, "esp32c5"), undefined);
  assert.ok(definition("ledc", 5, "esp32c5"));
  assert.equal(definition("ledc", 6, "esp32c5"), undefined);
  assert.ok(definition("adc", 1, "esp32c5"));
  assert.equal(definition("adc", 2, "esp32c5"), undefined);
  assert.ok(definition("rmt", 3, "esp32c5"));
  assert.equal(definition("rmt", 4, "esp32c5"), undefined);
  assert.ok(definition("i2s", 0, "esp32c5"));
  assert.equal(definition("i2s", 1, "esp32c5"), undefined);
  assert.ok(definition("usb", 0, "esp32c5"));
  // TWAI is not enableable in ESP-IDF v5.4 for the C5, so it is not modelled.
  assert.equal(definition("twai", 0, "esp32c5"), undefined);
  assert.equal(definition("sdmmc", 0, "esp32c5"), undefined);
  assert.equal(definition("camera", 0, "esp32c5"), undefined);
  assert.equal(definition("lcd", 0, "esp32c5"), undefined);
  // No input-only pads, so every GPIO is a valid matrix route.
  assert.equal(candidates(definition("uart", 0, "esp32c5")!.signals[0], "esp32c5").length, 29);
  const adc = definition("adc", 1, "esp32c5")!.signals[0];
  assert.deepEqual(candidates(adc, "esp32c5", 1), [1, 2, 3, 4, 5, 6]);
  // The USB Serial/JTAG signals are locked to their fixed PHY pads.
  const dn = definition("usb", 0, "esp32c5")!.signals.find(signal => signal.id === "dn")!;
  const dp = definition("usb", 0, "esp32c5")!.signals.find(signal => signal.id === "dp")!;
  assert.deepEqual(candidates(dn, "esp32c5"), [13]);
  assert.deepEqual(candidates(dp, "esp32c5"), [14]);
  // A plausible UART1 route on free pins validates cleanly, and out-of-range GPIOs are errors.
  let config = addPeripheral(createConfig("esp32c5"), "uart", 1);
  config = setSignal(config, "uart1", "tx", 24);
  config = setSignal(config, "uart1", "rx", 25);
  assert.deepEqual(validateGpio(config), []);
  config.pins.push({ gpio: 29, function: "GPIO_OUTPUT" });
  assert.ok(validateGpio(config).some(problem => /ESP32-C5/.test(problem.message)));
});

test("H2 GPIO capabilities, strapping, SiP variant and USB Serial/JTAG pins match the official summary", () => {
  const device = getDevice("esp32h2")!;
  // 28 GPIOs 0-27 with no gap; every pad is output-capable (no input-only pin on the H2).
  assert.equal(device.pins.length, 28);
  assert.deepEqual(device.pins.map(pin => pin.gpio), Array.from({ length: 28 }, (_, i) => i));
  assert.equal(device.pins.some(pin => /Input-only/.test(pin.restrictions.join(" "))), false);
  // ADC1 pads are GPIO1-5; GPIO0/GPIO6 are digital-only.
  assert.equal(device.pins[0].capabilities.analog, false);
  assert.equal(device.pins[1].capabilities.analog, true);
  assert.equal(device.pins[5].capabilities.analog, true);
  assert.equal(device.pins[6].capabilities.analog, false);
  // The RTC domain covers GPIO7-14.
  assert.equal(device.pins[7].capabilities.rtc, true);
  assert.equal(device.pins[14].capabilities.rtc, true);
  assert.equal(device.pins[6].capabilities.rtc, false);
  assert.equal(device.pins[15].capabilities.rtc, false);
  assert.deepEqual(device.pins.filter(pin => pin.restrictions.some(text => /Strapping/.test(text))).map(pin => pin.gpio), [2, 3, 8, 9, 25]);
  assert.deepEqual(device.pins.filter(pin => pin.restrictions.some(text => /Flash\/PSRAM/.test(text))).map(pin => pin.gpio), [15, 16, 17, 18, 19, 20, 21]);
  // GPIO6-7 and GPIO15-21 are only bonded out on non-SiP parts.
  assert.deepEqual(device.pins.filter(pin => pin.restrictions.some(text => /bonded/.test(text))).map(pin => pin.gpio), [6, 7, 15, 16, 17, 18, 19, 20, 21]);
  // The USB Serial/JTAG PHY is fixed to GPIO26 (D-) / GPIO27 (D+); the H2 has no USB OTG.
  assert.deepEqual(device.pins.filter(pin => pin.restrictions.some(text => /USB Serial\/JTAG/.test(text))).map(pin => pin.gpio), [26, 27]);
  assert.equal(device.pins.some(pin => /USB OTG/.test(pin.restrictions.join(" "))), false);
  assert.deepEqual(device.adcUnits, { "1": [1, 2, 3, 4, 5] });
});

test("H2 controller instances are chip-specific and include the single TWAI controller", () => {
  // H2: UART 0-1, I2C 0-1, SPI 2 only, LEDC 0-5, ADC1 only, RMT 0-3, I2S 0, USB 0, TWAI 0; no SD host/LCD_CAM.
  assert.ok(definition("uart", 1, "esp32h2"));
  assert.equal(definition("uart", 2, "esp32h2"), undefined);
  assert.ok(definition("i2c", 1, "esp32h2"));
  assert.equal(definition("i2c", 2, "esp32h2"), undefined);
  assert.ok(definition("spi", 2, "esp32h2"));
  assert.equal(definition("spi", 3, "esp32h2"), undefined);
  assert.ok(definition("ledc", 5, "esp32h2"));
  assert.equal(definition("ledc", 6, "esp32h2"), undefined);
  assert.ok(definition("adc", 1, "esp32h2"));
  assert.equal(definition("adc", 2, "esp32h2"), undefined);
  assert.ok(definition("rmt", 3, "esp32h2"));
  assert.equal(definition("rmt", 4, "esp32h2"), undefined);
  assert.ok(definition("i2s", 0, "esp32h2"));
  assert.equal(definition("i2s", 1, "esp32h2"), undefined);
  assert.ok(definition("usb", 0, "esp32h2"));
  assert.ok(definition("twai", 0, "esp32h2"));
  assert.equal(definition("twai", 1, "esp32h2"), undefined);
  assert.equal(definition("sdmmc", 0, "esp32h2"), undefined);
  assert.equal(definition("camera", 0, "esp32h2"), undefined);
  assert.equal(definition("lcd", 0, "esp32h2"), undefined);
  assert.equal(candidates(definition("uart", 0, "esp32h2")!.signals[0], "esp32h2").length, 28);
  const adc = definition("adc", 1, "esp32h2")!.signals[0];
  assert.deepEqual(candidates(adc, "esp32h2", 1), [1, 2, 3, 4, 5]);
  const dn = definition("usb", 0, "esp32h2")!.signals.find(signal => signal.id === "dn")!;
  const dp = definition("usb", 0, "esp32h2")!.signals.find(signal => signal.id === "dp")!;
  assert.deepEqual(candidates(dn, "esp32h2"), [26]);
  assert.deepEqual(candidates(dp, "esp32h2"), [27]);
  // A plausible I2C1 route on free pins validates cleanly, and out-of-range GPIOs are errors.
  let config = addPeripheral(createConfig("esp32h2"), "i2c", 1);
  config = setSignal(config, "i2c1", "sda", 10);
  config = setSignal(config, "i2c1", "scl", 11);
  assert.deepEqual(validateGpio(config), []);
  config.pins.push({ gpio: 28, function: "GPIO_OUTPUT" });
  assert.ok(validateGpio(config).some(problem => /ESP32-H2/.test(problem.message)));
});
