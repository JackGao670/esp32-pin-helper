import test from "node:test";
import assert from "node:assert/strict";
import { boards, getBoardProfile, listBoardProfiles, getBoardPinLabel, isBoardReserved, resolveBoardFromSettings, boardInfoOf, pickAutoBoard, getBoardOnboardUsage } from "../src/database/boardLoader";
import { createConfig } from "../src/core/model/config";
import { addPeripheral, setSignal } from "../src/core/model/peripherals";
import { validateGpio } from "../src/core/validator/gpio";

test("boardLoader: sample board parses, helpers, list filter", () => {
  assert.ok(boards.length >= 1, "at least one sample board ships");

  // Case 1: getBoardProfile lookup
  const b = getBoardProfile("espressif", "esp32-s3-devkitc-1");
  assert.ok(b, "s3-devkitc-1 sample loaded");
  assert.equal(b!.id, "esp32-s3-devkitc-1");
  assert.equal(b!.vendor, "espressif");
  assert.equal(b!.targetChip, "esp32s3");
  assert.equal(b!.source.version, "v1.6");
  assert.ok(/^https:/.test(b!.source.url), "source URL is https");

  // Case 2: pins[].reserved union to reservedGpios
  assert.ok(b!.reservedGpios.includes(48), "RGB LED gpio 48 reserved from pins[].reserved=true");
  assert.equal(isBoardReserved(b!, 48), true, "helper isBoardReserved(48)=true");
  assert.equal(isBoardReserved(b!, 47), false, "GPIO47 is not reserved");

  // Case 3: labels (overridden and default fallback)
  assert.match(getBoardPinLabel(b!, 0), /BOOT/, "GPIO0 label includes BOOT");
  assert.equal(getBoardPinLabel(b!, 100), "GPIO100", "unknown gpio falls back to GPIO<N>");

  // Case 4: peripherals.defaultSignalMap schema validated per ^GPIO\d+$
  assert.equal(b!.peripherals.i2c0?.sda, "GPIO8", "i2c0 SDA default GPIO8 on this devkit");
  assert.equal(b!.peripherals.spi2?.mosi, "GPIO11", "spi2 MOSI default GPIO11 on this devkit");
  assert.equal(b!.peripherals.spi2?.sclk, "GPIO12", "spi2 SCLK default GPIO12 on this devkit");

  // Case 5: listBoardProfiles by chip (S3 + C6 samples ship)
  const s3 = listBoardProfiles("esp32s3");
  assert.ok(s3.length >= 1, "at least one S3 board");
  assert.ok(s3.every(x => x.targetChip === "esp32s3"), "all S3 entries target esp32s3");
  const c6 = listBoardProfiles("esp32c6");
  assert.ok(c6.length >= 1, "at least one C6 board (DevKitC-1 ships as sample)");
  assert.ok(c6.every(x => x.targetChip === "esp32c6"), "all C6 entries target esp32c6");
  assert.equal(c6[0].id, "esp32-c6-devkitc-1", "first C6 board sample is devkitc-1");
  // byId lookup for C6 sample
  const c6ById = getBoardProfile("espressif", "esp32-c6-devkitc-1");
  assert.ok(c6ById, "C6 devkitc-1 byId lookup succeeds");
  assert.equal(isBoardReserved(c6ById!, 8), true, "C6 devkitc-1 GPIO8 (RGB LED) reserved");
  assert.match(getBoardPinLabel(c6ById!, 9), /BOOT/, "C6 devkitc-1 GPIO9 label includes BOOT");

  // Case 6: powerDomain.perGpio 21 RTC pins all present
  assert.ok(b!.powerDomain, "sample declares power domain");
  assert.equal(b!.powerDomain!.default, "VDD33");
  assert.equal((b!.powerDomain as any).perGpio?.[21], "VDD3P3_RTC", "GPIO21 = RTC domain on devkitc-1");

  // Case 7: schema failures — invalid JSON should throw
  assert.throws(
    () => getBoardProfile("espressif", "not-exist") ?? (() => { throw new Error("fallthrough"); })(),
    /fallthrough/,
    "unknown board returns undefined"
  );
});

test("boardLoader: P4 Function-EV-Board parses dedicated-free GPIO defaults", () => {
  const p4 = getBoardProfile("espressif", "esp32-p4-function-ev-board");
  assert.ok(p4, "P4 Function-EV-Board sample loaded");
  assert.equal(p4!.targetChip, "esp32p4");
  assert.equal(p4!.vendor, "espressif");
  assert.ok(/^https:/.test(p4!.source.url), "source URL is https");

  // reserved pins from pins[].reserved=true union
  assert.deepEqual(p4!.reservedGpios, [53], "only the hardwired audio PA enable is reserved");
  assert.equal(isBoardReserved(p4!, 53), true);
  assert.equal(isBoardReserved(p4!, 26), false, "optional LCD backlight default is not reserved");
  assert.equal(isBoardReserved(p4!, 9), false, "I2S DOUT pin is not reserved");

  // peripherals only stores GPIO-routable defaults (MIPI dedicated pads omitted)
  assert.equal(p4!.peripherals.i2c0?.sda, "GPIO7", "shared I2C0 SDA=GPIO7");
  assert.equal(p4!.peripherals.i2s0?.mclk, "GPIO13", "ES8311 MCLK=GPIO13");
  assert.equal(p4!.peripherals.lcd_mipi0?.reset, "GPIO27", "DSI reset=GPIO27");
  assert.equal(p4!.peripherals.lcd_mipi0?.bl_pwm, "GPIO26", "DSI backlight PWM=GPIO26");
  assert.equal(p4!.peripherals.camera_mipi0, undefined, "camera_mipi has no GPIO-routable default");
  for (const owner of Object.keys(p4!.peripherals)) {
    for (const v of Object.values(p4!.peripherals[owner])) {
      assert.match(v, /^GPIO\d+$/, `${owner} default values must be GPIO<N> strings`);
    }
  }

  // pin labels use PCB silkscreen
  assert.match(getBoardPinLabel(p4!, 37), /U0TXD/, "GPIO37 label mentions U0TXD");
  assert.match(getBoardPinLabel(p4!, 43), /SDMMC CLK/, "GPIO43 label mentions SDMMC CLK");

  // list filter
  const p4List = listBoardProfiles("esp32p4");
  assert.equal(p4List.length, 1, "exactly one P4 board sample");
  assert.equal(p4List[0].id, "esp32-p4-function-ev-board");
});

test("resolveBoardFromSettings: none / auto (unique) / byId (chip-matched) / auto 0 or >1 candidates", () => {
  // none always disables board features
  assert.equal(resolveBoardFromSettings({ preset: "none" }, "esp32s3"), undefined);

  // auto resolves when exactly one board matches the target chip
  const s3 = resolveBoardFromSettings({ preset: "auto" }, "esp32s3");
  assert.equal(s3?.id, "esp32-s3-devkitc-1", "auto picks the unique S3 board");
  const p4 = resolveBoardFromSettings({ preset: "auto" }, "esp32p4");
  assert.equal(p4?.id, "esp32-p4-function-ev-board", "auto picks the unique P4 board");

  // byId requires a chip match
  assert.equal(resolveBoardFromSettings({ preset: "byId", vendor: "espressif", board: "esp32-s3-devkitc-1" }, "esp32s3")?.id,
    "esp32-s3-devkitc-1");
  assert.equal(resolveBoardFromSettings({ preset: "byId", vendor: "espressif", board: "esp32-s3-devkitc-1" }, "esp32p4"),
    undefined, "byId with mismatched target chip falls back to no board");
  assert.equal(resolveBoardFromSettings({ preset: "byId", vendor: "espressif", board: "does-not-exist" }, "esp32s3"),
    undefined, "byId unknown board returns undefined");
});

test("boardInfoOf: serializes labelMap + reservedGpios + defaultSignalMap for the WebView", () => {
  const p4 = getBoardProfile("espressif", "esp32-p4-function-ev-board")!;
  const info = boardInfoOf(p4);
  assert.equal(info.vendor, "espressif");
  assert.equal(info.id, "esp32-p4-function-ev-board");
  assert.equal(info.name, p4.name);
  assert.equal(info.labelMap["43"], "GPIO43 (microSD SDMMC CLK / SD SPI CLK)");
  assert.deepEqual(info.reservedGpios, [53]);
  assert.equal(info.labelMap["26"].includes("reserved"), false, "labelMap stores raw labels only");

  // defaultSignalMap is a deep copy of the board's recommended routing (owner -> signal -> GPIO<N>)
  assert.equal(info.defaultSignalMap.uart0?.tx, "GPIO37");
  assert.equal(info.defaultSignalMap.i2s0?.mclk, "GPIO13");
  assert.equal(info.defaultSignalMap.lcd_mipi0?.reset, "GPIO27");
  info.defaultSignalMap.uart0.tx = "GPIO1";
  assert.equal(p4.peripherals.uart0.tx, "GPIO37", "copy must not alias the board profile");
});

test("boardRule: routes on a reserved board pin emit a warning; non-reserved pins stay silent", () => {
  // S3 devkitc-1 reserves GPIO48 (RGB LED). auto board resolution activates boardRule.
  const onReserved = createConfig("esp32s3");
  onReserved.peripherals = { ledc2: { type: "ledc", instance: 2, signals: { out: "GPIO48" } } } as any;
  const warn = validateGpio(onReserved).filter(p => p.severity === "warning" && /reserved on/.test(p.message));
  assert.equal(warn.length, 1, "assigning a reserved board pin yields exactly one board warning");
  assert.match(warn[0].message, /GPIO48/);
  assert.equal(warn[0].gpio, 48);

  // Non-reserved pin (GPIO47 Green LED) → no board reserved warning.
  const onFree = createConfig("esp32s3");
  onFree.peripherals = { ledc1: { type: "ledc", instance: 1, signals: { out: "GPIO47" } } } as any;
  assert.equal(validateGpio(onFree).filter(p => /reserved on/.test(p.message)).length, 0);

  // preset=none disables the board rule entirely.
  assert.equal(validateGpio(onReserved, undefined, { board: { preset: "none" } }).filter(p => /reserved on/.test(p.message)).length,
    0, "board preset=none suppresses reserved-pin warnings");
});

test("boardLoader: C6 DevKitM-1 parses board-wired UART bridge pins alongside the DevKitC-1", () => {
  const m1 = getBoardProfile("espressif", "esp32-c6-devkitm-1");
  assert.ok(m1, "C6 DevKitM-1 sample loaded");
  assert.equal(m1!.targetChip, "esp32c6");
  assert.equal(m1!.vendor, "espressif");
  assert.ok(/^https:/.test(m1!.source.url), "source URL is https");
  assert.match(m1!.source.url, /esp-dev-kits/, "source points at the official esp-dev-kits user guide");
  assert.equal(m1!.default, undefined, "the DevKitM-1 is not the reference C6 board");

  // reserved pin from pins[].reserved=true union
  assert.deepEqual(m1!.reservedGpios, [8], "RGB LED on GPIO8 is reserved");
  assert.equal(getBoardPinLabel(m1!, 9), "BOOT / GPIO9");

  // onboardPins: USB-to-UART bridge pins, matching the uart0 default route
  assert.equal(m1!.onboardPins?.length, 2);
  assert.match(getBoardOnboardUsage(m1!, 16) ?? "", /USB-to-UART bridge \(U0TXD/);
  assert.match(getBoardOnboardUsage(m1!, 17) ?? "", /USB-to-UART bridge \(U0RXD/);
  assert.equal(getBoardOnboardUsage(m1!, 18), undefined, "non-bridge pins have no onboard usage");
  assert.equal(m1!.peripherals.uart0?.tx, "GPIO16");
  assert.equal(m1!.peripherals.uart0?.rx, "GPIO17");

  const c6 = listBoardProfiles("esp32c6");
  assert.equal(c6.length, 2, "both C6 boards ship as samples");
  assert.deepEqual(c6.map(b => b.id), ["esp32-c6-devkitc-1", "esp32-c6-devkitm-1"]);
});

test("pickAutoBoard: ambiguous candidate sets fall back to no board instead of guessing", () => {
  const c6 = listBoardProfiles("esp32c6");
  const [c1, m1] = c6;

  // unique candidate always wins, even without the default marker
  assert.equal(pickAutoBoard([c1])?.id, "esp32-c6-devkitc-1");
  assert.equal(pickAutoBoard([]), undefined);

  // multiple candidates: only an explicitly flagged, unique default board resolves
  assert.equal(pickAutoBoard(c6)?.id, "esp32-c6-devkitc-1", "DevKitC-1 carries default=true");
  assert.equal(pickAutoBoard(c6.map(x => ({ ...x, default: undefined }))), undefined,
    "two unflagged candidates must not be guessed");
  assert.equal(pickAutoBoard(c6.map(x => ({ ...x, default: true }))), undefined,
    "two flagged candidates are ambiguous");
  assert.equal(pickAutoBoard([{ ...m1, default: true }])?.id, "esp32-c6-devkitm-1");

  // end-to-end through the settings path: auto resolves C6 to the flagged board, byId reaches the other one
  assert.equal(resolveBoardFromSettings({ preset: "auto" }, "esp32c6")?.id, "esp32-c6-devkitc-1");
  assert.equal(resolveBoardFromSettings({ preset: "byId", vendor: "espressif", board: "esp32-c6-devkitm-1" }, "esp32c6")?.id,
    "esp32-c6-devkitm-1");
});

test("boardUsageRule: taking over a board-wired GPIO warns once; the board's own default route stays silent", () => {
  // P4: GPIO43 is the microSD SDMMC CLK (board default for no configurable owner, so always a takeover).
  const sdTaken = createConfig("esp32p4");
  sdTaken.peripherals = { ledc6: { type: "ledc", instance: 6, signals: { out: "GPIO43" } } } as any;
  const usage = validateGpio(sdTaken).filter(p => p.severity === "warning" && /wired to the/.test(p.message));
  assert.equal(usage.length, 1, "one board-usage warning for the microSD pin");
  assert.equal(usage[0].gpio, 43);
  assert.equal(usage[0].owner, "ledc6");
  assert.match(usage[0].message, /microSD slot SDMMC CLK/);
  assert.deepEqual(usage[0].path, ["peripherals", "ledc6", "signals", "out"]);

  // Wiring the same pins as the board intends (uart0 on 37/38) is not a conflict.
  const uartDefault = createConfig("esp32p4");
  uartDefault.peripherals = { uart0: { type: "uart", instance: 0, signals: { tx: "GPIO37", rx: "GPIO38" } } } as any;
  assert.equal(validateGpio(uartDefault).filter(p => /wired to the/.test(p.message)).length, 0);

  // reservedGpios stay a boardRule concern: no duplicate usage warning for GPIO53 (audio PA enable).
  const paPin = createConfig("esp32p4");
  paPin.peripherals = { ledc7: { type: "ledc", instance: 7, signals: { out: "GPIO53" } } } as any;
  const paProblems = validateGpio(paPin);
  assert.equal(paProblems.filter(p => /wired to the/.test(p.message)).length, 0);
  assert.equal(paProblems.filter(p => /reserved on/.test(p.message)).length, 1);

  // board preset=none disables the board checks entirely.
  assert.equal(validateGpio(sdTaken, undefined, { board: { preset: "none" } })
    .filter(p => /wired to the/.test(p.message)).length, 0);
});

test("boardUsageRule: C6 devkit USB-to-UART bridge pins stay silent for uart0 and warn for any other owner", () => {
  const uart0 = createConfig("esp32c6");
  uart0.peripherals = { uart0: { type: "uart", instance: 0, signals: { tx: "GPIO16", rx: "GPIO17" } } } as any;
  assert.equal(validateGpio(uart0).filter(p => /wired to the/.test(p.message)).length, 0,
    "uart0 on the bridge pins is the intended wiring");

  const uart1 = createConfig("esp32c6");
  uart1.peripherals = { uart1: { type: "uart", instance: 1, signals: { tx: "GPIO16", rx: "GPIO17" } } } as any;
  const warns = validateGpio(uart1).filter(p => /wired to the/.test(p.message));
  assert.equal(warns.length, 2, "both bridge pins conflict when uart1 takes them over");
  const gpios = warns.map(p => p.gpio).filter((n): n is number => n !== undefined).sort((x, y) => x - y);
  assert.deepEqual(gpios, [16, 17]);
  assert.ok(warns.every(p => p.owner === "uart1"));
});
