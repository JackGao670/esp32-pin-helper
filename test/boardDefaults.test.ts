import test from "node:test";
import assert from "node:assert/strict";
import { parseOwner, boardShortcutsFor, boardPinNotes } from "../webview/src/boardDefaults";
import { boardInfoOf, getBoardProfile } from "../src/database/boardLoader";
import type { BoardInfo } from "../src/core/model/messages";

test("parseOwner: type names may contain digits (i2c0/i2s0) and malformed keys are rejected", () => {
  assert.deepEqual(parseOwner("uart0"), { type: "uart", instance: 0 });
  assert.deepEqual(parseOwner("spi2"), { type: "spi", instance: 2 });
  // Regression: the previous inline regex truncated "i2c0" to type "i2c" only by luck; "i2s0"/"lcd_mipi0"
  // and any digit-bearing type must survive, otherwise Board Defaults silently drops those rows.
  assert.deepEqual(parseOwner("i2c0"), { type: "i2c", instance: 0 });
  assert.deepEqual(parseOwner("i2s0"), { type: "i2s", instance: 0 });
  assert.deepEqual(parseOwner("lcd_mipi0"), { type: "lcd_mipi", instance: 0 });
  assert.deepEqual(parseOwner("camera0"), { type: "camera", instance: 0 });
  assert.equal(parseOwner("uart"), undefined);
  assert.equal(parseOwner("0uart"), undefined);
  assert.equal(parseOwner(""), undefined);
});

test("boardShortcutsFor: S3 board exposes its four fully-required routes and flags board-wired pins", () => {
  const s3 = boardInfoOf(getBoardProfile("espressif", "esp32-s3-devkitc-1")!);
  const shortcuts = boardShortcutsFor(s3, "esp32s3");
  assert.deepEqual(shortcuts.map(s => s.owner), ["uart0", "spi2", "i2c0", "ledc2"]);
  assert.deepEqual(shortcuts.map(s => [s.type, s.instance]), [["uart", 0], ["spi", 2], ["i2c", 0], ["ledc", 2]]);

  const uart0 = shortcuts.find(s => s.owner === "uart0")!;
  assert.equal(uart0.signals.tx, "GPIO43");
  assert.deepEqual(uart0.boardPins, [
    { gpio: 43, kind: "onboard", note: "on-board USB-to-UART bridge (U0TXD)" },
    { gpio: 44, kind: "onboard", note: "on-board USB-to-UART bridge (U0RXD)" }
  ]);

  // LEDC2 drives the board RGB LED, which the board marks reserved — the sharper of the two signals.
  assert.deepEqual(shortcuts.find(s => s.owner === "ledc2")!.boardPins,
    [{ gpio: 48, kind: "reserved", note: "RGB LED / GPIO48" }]);
  // SPI2 and I2C0 route to plain GPIOs: nothing to flag.
  assert.deepEqual(shortcuts.find(s => s.owner === "spi2")!.boardPins, []);
  assert.deepEqual(shortcuts.find(s => s.owner === "i2c0")!.boardPins, []);
});

test("boardShortcutsFor: routes missing a required signal are dropped, and no board yields no shortcuts", () => {
  const board: BoardInfo = {
    vendor: "test", id: "test-board", name: "Test Board",
    labelMap: {}, reservedGpios: [], onboardPins: [],
    defaultSignalMap: { uart0: { tx: "GPIO1" }, i2c0: { sda: "GPIO2" }, ledc0: { out: "GPIO3" } }
  };
  // uart needs tx+rx and i2c needs sda+scl — half-configured routes must not be offered.
  assert.deepEqual(boardShortcutsFor(board, "esp32s3").map(s => s.owner), ["ledc0"]);
  assert.deepEqual(boardShortcutsFor(undefined, "esp32s3"), []);
});

test("boardPinNotes: reserved wins over onboard, and an absent board yields nothing", () => {
  const board: BoardInfo = {
    vendor: "test", id: "test-board", name: "Test Board",
    labelMap: { "5": "DBG LED / GPIO5" }, reservedGpios: [5], defaultSignalMap: {},
    onboardPins: [{ gpio: 5, usage: "on-board LED" }, { gpio: 7, usage: "on-board USB bridge" }]
  };
  assert.deepEqual(boardPinNotes(board, [5, 7, 9]), [
    { gpio: 5, kind: "reserved", note: "DBG LED / GPIO5" },
    { gpio: 7, kind: "onboard", note: "on-board USB bridge" }
  ]);
  assert.deepEqual(boardPinNotes(undefined, [1]), []);
});
