import test from "node:test";
import assert from "node:assert/strict";
import { createConfig, parseConfig, serializeConfig } from "../src/core/model/config";
import { addPeripheral, removePeripheral, resolveAssignments, setSignal } from "../src/core/model/peripherals";
import { candidates, definition, gpioNumber, supportsSignal } from "../src/core/resolver/peripherals";
import { device } from "../src/database/loader";
import { validateGpio } from "../src/core/validator/gpio";

test("peripheral signal edits derive pin assignments without redundant persistence", () => {
  let config = addPeripheral(createConfig(), "uart", 1);
  config = setSignal(config, "uart1", "tx", 17);
  config = setSignal(config, "uart1", "rx", 18);
  assert.equal(config.pins.length, 0);
  assert.equal(resolveAssignments(config).length, 2);
  assert.equal(validateGpio(config).length, 0);
  assert.deepEqual(parseConfig(serializeConfig(config)), config);
  config = setSignal(config, "uart1", "tx", 8);
  assert.ok(!resolveAssignments(config).some(pin => pin.gpio === 17));
  assert.equal(resolveAssignments(removePeripheral(config, "uart1")).length, 0);
});

test("GPIO and peripheral conflicts are detected without discarding either assignment", () => {
  let config = addPeripheral(createConfig(), "i2c", 0);
  config = setSignal(config, "i2c0", "sda", 8);
  config = setSignal(config, "i2c0", "scl", 8);
  config.pins.push({ gpio: 8, function: "GPIO_OUTPUT" });
  assert.equal(resolveAssignments(config).length, 3);
  assert.equal(validateGpio(config).filter(p => p.severity === "error").length, 2);
});

test("unsupported instances and signals are rejected and duplicate instances diagnosed", () => {
  assert.throws(() => addPeripheral(createConfig(), "spi", 0));
  const config = addPeripheral(createConfig(), "uart", 1);
  assert.throws(() => addPeripheral(config, "uart", 1));
  assert.throws(() => setSignal(config, "uart1", "sda", 8));
  config.peripherals!.other = { type: "uart", instance: 1, signals: {} };
  assert.ok(validateGpio(config).some(p => /more than once/.test(p.message)));
});

test("matrix and dedicated routing enforce direction and open-drain capabilities", () => {
  const tx = definition("uart", 0)!.signals[0];
  // GPIO46 is input-only (MTDO strapping) on ESP32-S3, so it is excluded from output routes.
  assert.equal(candidates(tx).length, 44);
  assert.ok(!candidates(tx).includes(22));
  assert.ok(!candidates(tx).includes(46));
  const pin = device.pins[0];
  assert.equal(supportsSignal({ ...pin, capabilities: { ...pin.capabilities, output: false } }, tx), false);
  const sda = definition("i2c", 0)!.signals[0];
  assert.equal(supportsSignal({ ...pin, capabilities: { ...pin.capabilities, openDrain: false } }, sda), false);
  const fixed = { ...tx, routing: "dedicated" as const, gpio: [19] };
  assert.deepEqual(candidates(fixed), [19]);
  assert.equal(gpioNumber("GPIO08"), undefined);
  assert.equal(gpioNumber("GPIO8"), 8);
});

test("completeness distinguishes required signals and software-managed SPI CS", () => {
  let config = addPeripheral(createConfig(), "spi", 2);
  assert.equal(validateGpio(config).filter(p => p.severity === "warning").length, 3);
  config = setSignal(config, "spi2", "sclk", 12);
  config = setSignal(config, "spi2", "mosi", 11);
  config.peripherals!.spi2.softwareCs = true;
  assert.equal(validateGpio(config).length, 0);
});

test("unknown and invalid JSON routes are diagnosed, vendor fields survive edits", () => {
  let config = addPeripheral(createConfig(), "uart", 1);
  config.peripherals!.uart1.vendor = { note: "keep" };
  config = setSignal(config, "uart1", "tx", 17);
  assert.deepEqual(config.peripherals!.uart1.vendor, { note: "keep" });
  config.peripherals!.uart1.signals.rx = "GPIO22";
  assert.ok(validateGpio(config).some(p => p.severity === "error"));
  config.peripherals!.uart1.signals.rx = "not-a-pin";
  assert.ok(validateGpio(config).some(p => /invalid signal/.test(p.message)));
});

test("rule registration accepts additional validation rules", () => {
  assert.deepEqual(validateGpio(createConfig(), [{ id: "custom", check: () => [{ severity: "warning", message: "custom" }] }]), [
    { severity: "warning", message: "custom" }
  ]);
});

test("SPI without data lines warns and quad mode requires MOSI+MISO; softwareCs suppresses CS warning", () => {
  const sclkOnly = addPeripheral(createConfig(), "spi", 2);
  sclkOnly.peripherals!.spi2.signals = { sclk: "GPIO12" };
  const problems = validateGpio(sclkOnly);
  assert.ok(problems.some(p => /assign at least MOSI or MISO/.test(p.message)));
  assert.ok(problems.some(p => /CS is unassigned/.test(p.message)));
  const csOk = { ...sclkOnly, peripherals: { spi2: { ...sclkOnly.peripherals!.spi2, softwareCs: true } } };
  assert.ok(!validateGpio(csOk).some(p => /CS is unassigned/.test(p.message)));
  const quadNoBase = addPeripheral(createConfig(), "spi", 2);
  quadNoBase.peripherals!.spi2.signals = { sclk: "GPIO12", d: "GPIO7", cs: "GPIO10" };
  assert.ok(validateGpio(quadNoBase).some(p => /quad mode.*also requires MOSI/.test(p.message)));
});

test("I2S without dout/din warns and empty ADC warns", () => {
  const clocksOnly = addPeripheral(createConfig("esp32s3"), "i2s", 0);
  clocksOnly.peripherals!.i2s0.signals = { bclk: "GPIO5", ws: "GPIO6" };
  assert.ok(validateGpio(clocksOnly).some(p => /assign at least DOUT.*or DIN/.test(p.message)));
  const emptyAdc = addPeripheral(createConfig("esp32s3"), "adc", 1);
  assert.ok(validateGpio(emptyAdc).some(p => /no ADC channels assigned/.test(p.message)));
});

test("S3/C6 RMT channel banks warn about TX-only vs RX-only", () => {
  const tx = addPeripheral(createConfig("esp32s3"), "rmt", 0);
  tx.peripherals!.rmt0.signals = { sig: "GPIO1" };
  assert.ok(validateGpio(tx).some(p => /TX-only/.test(p.message)));
  const rx = addPeripheral(createConfig("esp32s3"), "rmt", 7);
  rx.peripherals!.rmt7.signals = { sig: "GPIO2" };
  assert.ok(validateGpio(rx).some(p => /RX-only/.test(p.message)));
  const c6tx = addPeripheral(createConfig("esp32c6"), "rmt", 1);
  c6tx.peripherals!.rmt1.signals = { sig: "GPIO7" };
  assert.ok(validateGpio(c6tx).some(p => /TX-only/.test(p.message)));
  // P4 has no TX-only bank restriction, so banks are silent.
  const p4 = addPeripheral(createConfig("esp32p4"), "rmt", 0);
  p4.peripherals!.rmt0.signals = { sig: "GPIO1" };
  assert.ok(!validateGpio(p4).some(p => /TX-only|RX-only/.test(p.message)));
});

test("Octal memory pins escalate warnings when any octal pin is reassigned", () => {
  const quadOnly = addPeripheral(createConfig(), "spi", 2);
  quadOnly.peripherals!.spi2.signals = { sclk: "GPIO12", mosi: "GPIO27", cs: "GPIO10" };
  assert.ok(validateGpio(quadOnly).some(p => /Usually used by Flash\/PSRAM/.test(p.message)));
  assert.ok(!validateGpio(quadOnly).some(p => /Octal SPI upper data/.test(p.message)));
  const withOctal = addPeripheral(createConfig(), "spi", 2);
  // GPIO33 is an S3 octal memory pin (D4 upper lane) regardless of SPI signal name.
  withOctal.peripherals!.spi2.signals = { sclk: "GPIO33", mosi: "GPIO27", cs: "GPIO10" };
  const probs = validateGpio(withOctal);
  assert.ok(probs.some(p => /Octal SPI upper data pin \(D4-D7\)/.test(p.message)));
  assert.ok(probs.some(p => /whole D0-D7 bus is reserved/.test(p.message)));
});

test("ESP32-S3 DVP Camera requires sync/clock + 8-bit data bus; LCD RGB detects partial 16/24-bit busses", () => {
  // — Camera —
  let cameraMin = addPeripheral(createConfig("esp32s3"), "camera", 0);
  cameraMin.peripherals!.camera0.signals = { xclk: "GPIO15", pclk: "GPIO17", vsync: "GPIO16", href: "GPIO18",
    d0: "GPIO1", d1: "GPIO2", d2: "GPIO3", d3: "GPIO4", d4: "GPIO5", d5: "GPIO6", d6: "GPIO7", d7: "GPIO8" };
  const okCamera = validateGpio(cameraMin).filter(p => p.severity === "warning" && /camera0/.test(p.message));
  assert.equal(okCamera.length, 0, "fully assigned 8-bit DVP camera should produce no completeness warnings");

  let cameraBad = addPeripheral(createConfig("esp32s3"), "camera", 0);
  cameraBad.peripherals!.camera0.signals = { xclk: "GPIO15" };  // missing pclk/vsync/href + d0-d7
  const camProblems = validateGpio(cameraBad);
  assert.ok(camProblems.some(p => /DVP sync\/clock missing: pclk, vsync, href/.test(p.message)), "should flag missing DVP sync/clock");
  assert.ok(camProblems.some(p => /8-bit DVP data bus incomplete; missing: d0, d1, d2, d3, d4, d5, d6, d7/.test(p.message)), "should flag missing DVP d0-d7");

  // — LCD —
  let lcd8 = addPeripheral(createConfig("esp32s3"), "lcd", 0);
  lcd8.peripherals!.lcd0.signals = { pclk: "GPIO40", vsync: "GPIO41", hsync: "GPIO42", de: "GPIO45",
    d0: "GPIO10", d1: "GPIO11", d2: "GPIO12", d3: "GPIO13", d4: "GPIO14", d5: "GPIO16", d6: "GPIO17", d7: "GPIO18" };
  const lcd8Problems = validateGpio(lcd8).filter(p => /lcd0/.test(p.message));
  assert.equal(lcd8Problems.length, 0, "8-bit RGB LCD with full sync + DE should produce no completeness warnings");

  // Partial 16-bit: d8 present but d8-d15 not complete → warn.
  let lcdPartial16 = addPeripheral(createConfig("esp32s3"), "lcd", 0);
  lcdPartial16.peripherals!.lcd0.signals = { pclk: "GPIO40", vsync: "GPIO41", hsync: "GPIO42", de: "GPIO45",
    d0: "GPIO10", d1: "GPIO11", d2: "GPIO12", d3: "GPIO13", d4: "GPIO14", d5: "GPIO16", d6: "GPIO17", d7: "GPIO18",
    d8: "GPIO21" };
  assert.ok(validateGpio(lcdPartial16).some(p => /partial 16-bit mode; missing D8-D15 pins: d9, d10, d11, d12, d13, d14, d15/.test(p.message)));

  // Partial 24-bit: d16 present + some d17-d23 missing → warn.
  let lcdPartial24 = addPeripheral(createConfig("esp32s3"), "lcd", 0);
  lcdPartial24.peripherals!.lcd0.signals = { pclk: "GPIO40", vsync: "GPIO41", hsync: "GPIO42", de: "GPIO45",
    d0: "GPIO10", d1: "GPIO11", d2: "GPIO12", d3: "GPIO13", d4: "GPIO14", d5: "GPIO16", d6: "GPIO17", d7: "GPIO18",
    d8: "GPIO21", d9: "GPIO22", d10: "GPIO23", d11: "GPIO38", d12: "GPIO39", d13: "GPIO40", d14: "GPIO41", d15: "GPIO42",
    d16: "GPIO43" };
  const lcd24Probs = validateGpio(lcdPartial24);
  assert.ok(lcd24Probs.some(p => /partial 24-bit mode; missing D16-D23 pins: d17, d18, d19, d20, d21, d22, d23/.test(p.message)),
    "24-bit mode must flag incomplete d16-d23");

  // Fully assigned 24-bit LCD → no completeness warnings.
  let lcdFull = addPeripheral(createConfig("esp32s3"), "lcd", 0);
  const allSignals: any = { pclk: "GPIO40", vsync: "GPIO41", hsync: "GPIO42", de: "GPIO45" };
  for (let i = 0; i <= 23; i++) allSignals[`d${i}`] = `GPIO${(i + 1) % 48}`;
  lcdFull.peripherals!.lcd0.signals = allSignals;
  const fullWarns = validateGpio(lcdFull).filter(p => p.severity === "warning" && /lcd0/.test(p.message) && /RGB LCD sync|8-bit RGB|partial 16-bit|partial 24-bit/.test(p.message));
  assert.equal(fullWarns.length, 0, "fully routed RGB LCD should have no data-bus completeness warnings");
});

test("ESP32-P4 MIPI CSI 1-lane baseline + 2-lane completeness; MIPI DSI lane contiguity + partial pair warnings", () => {
  // — MIPI CSI 2-lane full assignment → no lane warnings —
  let camMipiFull = addPeripheral(createConfig("esp32p4"), "camera_mipi", 0);
  camMipiFull.peripherals!.camera_mipi0.signals = {
    csi_clkp: "GPIO44", csi_clkn: "GPIO45",
    csi_d0p: "GPIO43", csi_d0n: "GPIO42",
    csi_d1p: "GPIO47", csi_d1n: "GPIO46"
  };
  const fullCamWarns = validateGpio(camMipiFull).filter(p => /camera_mipi0/.test(p.message) && /MIPI CSI/.test(p.message));
  assert.equal(fullCamWarns.length, 0, "fully assigned 2-lane CSI should emit no lane completeness warnings");

  // — CSI 1-lane baseline missing CLK or lane 0 —
  let camMipiNoLane0 = addPeripheral(createConfig("esp32p4"), "camera_mipi", 0);
  camMipiNoLane0.peripherals!.camera_mipi0.signals = { csi_clkp: "GPIO44", csi_clkn: "GPIO45" };
  assert.ok(validateGpio(camMipiNoLane0).some(p => /MIPI CSI 1-lane baseline missing CLK \+ lane 0 differential pairs/.test(p.message)));

  // — CSI partial pair: only csi_d1p without d1n —
  let camMipiPartial = addPeripheral(createConfig("esp32p4"), "camera_mipi", 0);
  camMipiPartial.peripherals!.camera_mipi0.signals = {
    csi_clkp: "GPIO44", csi_clkn: "GPIO45",
    csi_d0p: "GPIO43", csi_d0n: "GPIO42",
    csi_d1p: "GPIO47"   // missing csi_d1n
  };
  assert.ok(validateGpio(camMipiPartial).some(p => /differential pair csi_d1p\/csi_d1n partially assigned/.test(p.message)),
    "partial diff pair must produce warning");

  // — CSI lane 1 present but lane 0 incomplete (lane 0 has only one side) —
  let camMipiOrder = addPeripheral(createConfig("esp32p4"), "camera_mipi", 0);
  camMipiOrder.peripherals!.camera_mipi0.signals = {
    csi_clkp: "GPIO44", csi_clkn: "GPIO45",
    csi_d0p: "GPIO43", // missing d0n (incomplete 1-lane baseline)
    csi_d1p: "GPIO47", csi_d1n: "GPIO46"
  };
  const orderWarns = validateGpio(camMipiOrder);
  assert.ok(orderWarns.some(p => /differential pair csi_d0p\/csi_d0n partially assigned/.test(p.message)));
  assert.ok(orderWarns.some(p => /1-lane baseline missing CLK \+ lane 0/.test(p.message)));
  assert.ok(orderWarns.some(p => /lane 1 present but 1-lane baseline is incomplete/.test(p.message)),
    "should flag lane 1 present without full baseline");

  // — MIPI DSI 4-lane fully assigned —
  let dsiFull = addPeripheral(createConfig("esp32p4"), "lcd_mipi", 0);
  dsiFull.peripherals!.lcd_mipi0.signals = {
    dsi_clkp: "GPIO30", dsi_clkn: "GPIO31",
    dsi_d0p: "GPIO32", dsi_d0n: "GPIO33",
    dsi_d1p: "GPIO34", dsi_d1n: "GPIO35",
    dsi_d2p: "GPIO36", dsi_d2n: "GPIO37",
    dsi_d3p: "GPIO38", dsi_d3n: "GPIO39",
    te: "GPIO25", reset: "GPIO26", bl_pwm: "GPIO27"
  };
  const dsiFullW = validateGpio(dsiFull).filter(p => /lcd_mipi0/.test(p.message) &&
    (/MIPI DSI/.test(p.message) || /differential pair/.test(p.message) || /lane \d present/.test(p.message) || /contiguous/.test(p.message)));
  assert.equal(dsiFullW.length, 0, "fully assigned 4-lane DSI should have no lane completeness warnings (ignoring pin-level GPIO/strapping warnings)");

  // — DSI lane 3 present but lane 1 and lane 2 missing → contiguous violation —
  let dsiHole = addPeripheral(createConfig("esp32p4"), "lcd_mipi", 0);
  dsiHole.peripherals!.lcd_mipi0.signals = {
    dsi_clkp: "GPIO30", dsi_clkn: "GPIO31",
    dsi_d0p: "GPIO32", dsi_d0n: "GPIO33",
    // lanes 1 + 2 missing
    dsi_d3p: "GPIO38", dsi_d3n: "GPIO39"
  };
  const holeW = validateGpio(dsiHole);
  assert.ok(holeW.some(p => /DSI lane 3 present but lane 1 is missing/.test(p.message)),
    "DSI lane order violation on lane 3");
  assert.ok(holeW.some(p => /DSI lane 3 present but lane 2 is missing/.test(p.message)),
    "DSI lane order violation on lane 2 for lane 3 presence");

  // — DSI 1-lane baseline missing lane0 → warn.
  let dsiNoLane = addPeripheral(createConfig("esp32p4"), "lcd_mipi", 0);
  dsiNoLane.peripherals!.lcd_mipi0.signals = { dsi_clkp: "GPIO30", dsi_clkn: "GPIO31" };
  assert.ok(validateGpio(dsiNoLane).some(p => /MIPI DSI 1-lane baseline missing CLK \+ lane 0 differential pairs/.test(p.message)));
});

test("USB D+/D- pair completeness is enforced on the fixed PHY pads", () => {
  // Complete pair on S3 (GPIO19 = D-, GPIO20 = D+) → no pairing warning.
  let usb = addPeripheral(createConfig("esp32s3"), "usb", 0);
  usb = setSignal(usb, "usb0", "dn", 19);
  usb = setSignal(usb, "usb0", "dp", 20);
  assert.ok(!validateGpio(usb).some(p => /USB (DN|DP) .* is not assigned/.test(p.message)),
    "fully assigned USB D+/D- pair should not warn about pairing");

  // Only D+ assigned → warn that D- is missing.
  let half = addPeripheral(createConfig("esp32s3"), "usb", 0);
  half = setSignal(half, "usb0", "dp", 20);
  assert.ok(validateGpio(half).some(p => /USB DN \(D-\) is not assigned/.test(p.message)),
    "USB with only D+ must warn that D- is missing");

  // Pads are fixed: a GPIO outside the dedicated pad list is an invalid route.
  const wrongPad = setSignal(half, "usb0", "dn", 5);
  assert.ok(validateGpio(wrongPad).some(p => /usb0\.dn: invalid signal or GPIO route/.test(p.message)),
    "USB D- must only accept the dedicated pad GPIO");
  // C6 models the fixed USB Serial/JTAG pads (D- = GPIO12, D+ = GPIO13).
  const c6Def = definition("usb", 0, "esp32c6")!;
  assert.deepEqual(c6Def.signals.map(s => s.gpio![0]), [12, 13]);
});

test("LCD 8080 (i80) bus flags incomplete baseline and partial 16-bit data", () => {
  // 8-bit baseline only → no 8080 data-bus warnings.
  const mcu8 = addPeripheral(createConfig("esp32s3"), "lcd_mcu", 0);
  mcu8.peripherals!.lcd_mcu0.signals = { dc: "GPIO15", wr: "GPIO16",
    d0: "GPIO1", d1: "GPIO2", d2: "GPIO3", d3: "GPIO4", d4: "GPIO5", d5: "GPIO6", d6: "GPIO7", d7: "GPIO8" };
  assert.ok(!validateGpio(mcu8).some(p => /8080 \(i80\)/.test(p.message)),
    "complete 8-bit i80 baseline should not warn about bus width");

  // Missing data bits → baseline incomplete.
  const mcuBad = addPeripheral(createConfig("esp32s3"), "lcd_mcu", 0);
  mcuBad.peripherals!.lcd_mcu0.signals = { dc: "GPIO15", wr: "GPIO16", d0: "GPIO1" };
  assert.ok(validateGpio(mcuBad).some(p => /8-bit 8080 \(i80\) data bus incomplete; missing: d1, d2, d3, d4, d5, d6, d7/.test(p.message)),
    "missing i80 data bits must flag an incomplete 8-bit baseline");

  // Partial 16-bit → warn about the missing upper byte.
  const mcu16 = addPeripheral(createConfig("esp32s3"), "lcd_mcu", 0);
  mcu16.peripherals!.lcd_mcu0.signals = { dc: "GPIO15", wr: "GPIO16",
    d0: "GPIO1", d1: "GPIO2", d2: "GPIO3", d3: "GPIO4", d4: "GPIO5", d5: "GPIO6", d6: "GPIO7", d7: "GPIO8",
    d8: "GPIO21" };
  assert.ok(validateGpio(mcu16).some(p => /partial 16-bit 8080 \(i80\) bus; missing D8-D15 pins: d9, d10, d11, d12, d13, d14, d15/.test(p.message)),
    "partial 16-bit i80 bus must flag missing D8-D15");
  // C6 has no LCD_CAM, so lcd_mcu is not a known peripheral there.
  assert.equal(definition("lcd_mcu", 0, "esp32c6"), undefined);
});

test("TWAI/CAN controllers expose TX/RX on any GPIO and require both lines", () => {
  // Controller counts are chip-specific: 1 on S3, 2 on C6, 3 on P4.
  assert.deepEqual(definition("twai", 0, "esp32s3")!.signals.filter(s => s.required).map(s => s.id), ["tx", "rx"]);
  assert.equal(definition("twai", 1, "esp32s3"), undefined);
  assert.ok(definition("twai", 1, "esp32c6"));
  assert.ok(definition("twai", 2, "esp32p4"));
  assert.equal(definition("twai", 3, "esp32p4"), undefined);
  // TX is an output and RX an input; both are routed through the GPIO matrix, so any
  // direction-capable GPIO qualifies (an external transceiver is required and not modeled).
  const tx = definition("twai", 0, "esp32s3")!.signals.find(s => s.id === "tx")!;
  const rx = definition("twai", 0, "esp32s3")!.signals.find(s => s.id === "rx")!;
  assert.equal(tx.routing, "gpio_matrix");
  assert.equal(rx.routing, "gpio_matrix");
  const pin = device.pins[0];
  assert.equal(supportsSignal({ ...pin, capabilities: { ...pin.capabilities, output: false } }, tx), false);
  assert.equal(supportsSignal({ ...pin, capabilities: { ...pin.capabilities, input: false } }, rx), false);
  // TX and RX are required: an empty controller warns for both lines.
  let config = addPeripheral(createConfig("esp32s3"), "twai", 0);
  const emptyWarns = validateGpio(config).filter(p => p.severity === "warning" && /twai0\./.test(p.message));
  assert.deepEqual(emptyWarns.map(p => p.message).sort(), [
    "twai0.RX is not assigned. Assign it, or use Auto-assign for twai0.",
    "twai0.TX is not assigned. Assign it, or use Auto-assign for twai0."
  ]);
  config = setSignal(config, "twai0", "tx", 4);
  config = setSignal(config, "twai0", "rx", 5);
  assert.ok(!validateGpio(config).some(p => /twai0\.(TX|RX) is not assigned/.test(p.message)),
    "wiring both TX and RX should clear the required-line warnings");
});

test("SDMMC host bus enforces the 1-bit baseline and 4-bit completeness", () => {
  // S3 exposes two GPIOMatrix-routed slots; P4 only slot 1; C6 has no SDMMC host.
  assert.deepEqual(definition("sdmmc", 0, "esp32s3")!.signals.filter(s => s.required).map(s => s.id), ["clk", "cmd", "d0"]);
  assert.ok(definition("sdmmc", 1, "esp32s3"));
  assert.ok(definition("sdmmc", 1, "esp32p4"));
  assert.equal(definition("sdmmc", 0, "esp32p4"), undefined);
  assert.equal(definition("sdmmc", 0, "esp32c6"), undefined);
  assert.throws(() => addPeripheral(createConfig("esp32c6"), "sdmmc", 0));

  // Missing 1-bit baseline lines → required-signal warnings.
  const empty = addPeripheral(createConfig("esp32s3"), "sdmmc", 0);
  const emptyWarns = validateGpio(empty).filter(p => p.severity === "warning" && /sdmmc0\./.test(p.message)).map(p => p.message).sort();
  assert.deepEqual(emptyWarns, [
    "sdmmc0.CLK is not assigned. Assign it, or use Auto-assign for sdmmc0.",
    "sdmmc0.CMD is not assigned. Assign it, or use Auto-assign for sdmmc0.",
    "sdmmc0.D0 is not assigned. Assign it, or use Auto-assign for sdmmc0."
  ]);

  // 1-bit baseline (clk/cmd/d0) with no upper lines → no 4-bit warning.
  let oneBit = addPeripheral(createConfig("esp32s3"), "sdmmc", 0);
  oneBit = setSignal(oneBit, "sdmmc0", "clk", 5);
  oneBit = setSignal(oneBit, "sdmmc0", "cmd", 6);
  oneBit = setSignal(oneBit, "sdmmc0", "d0", 7);
  const oneBitProbs = validateGpio(oneBit);
  assert.ok(!oneBitProbs.some(p => /4-bit SD bus/.test(p.message)), "1-bit baseline should not trigger the 4-bit warning");
  assert.ok(!oneBitProbs.some(p => /sdmmc0\.(CLK|CMD|D0) is not assigned/.test(p.message)));

  // Partial 4-bit: d1 wired without d2/d3 → warn about the incomplete group.
  const partial = setSignal(empty, "sdmmc0", "d1", 8);
  assert.ok(validateGpio(partial).some(p => /4-bit SD bus partially wired; missing D2, D3/.test(p.message)),
    "wiring only D1 must flag the incomplete 4-bit group");

  // Full 4-bit bus → no completeness warning.
  let fourBit = addPeripheral(createConfig("esp32s3"), "sdmmc", 1);
  for (const [signal, gpio] of [["clk", 5], ["cmd", 6], ["d0", 7], ["d1", 8], ["d2", 9], ["d3", 10]] as [string, number][]) {
    fourBit = setSignal(fourBit, "sdmmc1", signal, gpio);
  }
  assert.ok(!validateGpio(fourBit).some(p => /4-bit SD bus/.test(p.message)),
    "a fully wired 4-bit bus should not warn");
});

test("diagnostics explain how to fix the problem, not just that it exists (§4.7)", () => {
  // A GPIO that does not exist lists the ones that do.
  const missing = createConfig("esp32s3");
  missing.pins = [{ gpio: 99, function: "GPIO_INPUT" }];
  const missingMessage = validateGpio(missing).find(p => p.severity === "error")!.message;
  assert.match(missingMessage, /GPIO99 does not exist on ESP32-S3/);
  assert.match(missingMessage, /Valid GPIOs: 0-21, 26-48\./);

  // An input-only pin used as an output says so and what to do.
  const inputOnly = createConfig("esp32s3");
  inputOnly.pins = [{ gpio: 46, function: "GPIO_OUTPUT" }];
  assert.match(validateGpio(inputOnly).find(p => p.severity === "error")!.message,
    /GPIO46 is input-only, so GPIO_OUTPUT cannot be used here; choose an output-capable GPIO\./);

  // A wrong route points at the pins that would work.
  const wrongRoute = setSignal(addPeripheral(createConfig("esp32s3"), "i2c", 0), "i2c0", "sda", 46);
  assert.match(validateGpio(wrongRoute).find(p => /i2c0\.sda: invalid signal/.test(p.message))!.message,
    /GPIO46 cannot be routed to i2c0\.SDA; use Auto-assign or one of: /);

  // An unknown signal id lists the real ones for that peripheral.
  const unknownSignal = addPeripheral(createConfig("esp32s3"), "uart", 1);
  unknownSignal.peripherals!.uart1.signals.bogus = "GPIO5";
  assert.match(validateGpio(unknownSignal).find(p => /uart1\.bogus: invalid signal/.test(p.message))!.message,
    /uart1 has no "bogus" signal; use one of: tx, rx, rts, cts\./);

  // An instance the chip does not have lists the ones it does.
  const unknownInstance = addPeripheral(createConfig("esp32s3"), "uart", 1);
  unknownInstance.peripherals!.uart5 = { type: "uart", instance: 5, signals: {} };
  assert.match(validateGpio(unknownInstance).find(p => p.severity === "error")!.message,
    /Unsupported peripheral uart:5\. ESP32-S3 provides uart0, uart1, uart2\./);

  // A peripheral the chip does not have at all says so.
  const unknownType = addPeripheral(createConfig("esp32c6"), "uart", 0);
  unknownType.peripherals!.camera0 = { type: "camera", instance: 0, signals: {} };
  assert.match(validateGpio(unknownType).find(p => p.severity === "error")!.message,
    /Unsupported peripheral camera:0\. ESP32-C6 has no camera peripheral\./);
});

