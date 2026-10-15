import test from "node:test";
import assert from "node:assert/strict";
import { parseSdkconfigTarget, projectNotice } from "../src/core/model/project";
import { createConfig, parseConfig, serializeConfig } from "../src/core/model/config";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("sdkconfig parser handles BOM, CRLF, whitespace and comments", () => {
  assert.equal(parseSdkconfigTarget('\uFEFF# CONFIG_IDF_TARGET="esp32"\r\n CONFIG_IDF_TARGET = "esp32s3" # target\r\n'), "esp32s3");
  assert.equal(parseSdkconfigTarget('CONFIG_IDF_TARGET="esp32p4"\nCONFIG_IDF_TARGET_ESP32P4=y'), "esp32p4");
});

test("target parser does not mistake flags or unrelated settings for target", () => {
  assert.equal(parseSdkconfigTarget("CONFIG_IDF_TARGET_ESP32S3=y\nCONFIG_OTHER=\"esp32c6\""), undefined);
  assert.equal(parseSdkconfigTarget('CONFIG_IDF_TARGET="bad-target"\n'), undefined);
  assert.equal(parseSdkconfigTarget('CONFIG_IDF_TARGET="esp32s3"\nCONFIG_IDF_TARGET="esp32s3"'), "esp32s3");
  assert.throws(() => parseSdkconfigTarget('CONFIG_IDF_TARGET="esp32s3"\nCONFIG_IDF_TARGET="esp32c6"'), /conflicting/);
});

test("project target mismatch is reported without rewriting config", () => {
  const config = createConfig("esp32c6");
  assert.equal(config.target.chip, "esp32c6");
  assert.match(projectNotice(config.target.chip, "esp32s3"), /not changed/);
  assert.equal(projectNotice(config.target.chip, "esp32c6"), "");
  assert.equal(projectNotice(config.target.chip), "");
  assert.equal(createConfig().target.chip, "esp32s3");
});

test("pinconfig.schema.json v1 covers target chips, gpio functions and P1 peripheral signal names", () => {
  const schema = JSON.parse(readFileSync(resolve(repoRoot, "schemas", "pinconfig.schema.json"), "utf8"));
  assert.equal(schema.$schema, "http://json-schema.org/draft-07/schema#");
  assert.equal(schema.properties.version.const, 1);
  assert.deepEqual(schema.properties.target.properties.chip.enum, ["esp32s3", "esp32c6", "esp32p4"]);
  assert.deepEqual(schema.properties.pins.items.properties.function.enum, ["GPIO_INPUT", "GPIO_OUTPUT", "GPIO_OPEN_DRAIN"]);
  const peripheral = schema.definitions.peripheral;
  assert.deepEqual(peripheral.properties.type.enum, ["uart", "i2c", "spi", "ledc", "adc", "rmt", "i2s", "camera", "lcd", "lcd_mcu", "camera_mipi", "lcd_mipi", "usb", "twai", "sdmmc", "lpuart", "lpi2c"]);
  assert.equal("signals-uart" in schema.definitions, true);
  assert.equal("signals-adc" in schema.definitions, true);
  assert.equal("signals-i2s" in schema.definitions, true);
  assert.equal("signals-lcd-mcu" in schema.definitions, true);
  assert.equal("signals-usb" in schema.definitions, true);
  assert.equal("signals-twai" in schema.definitions, true);
  assert.equal("signals-sdmmc" in schema.definitions, true);
  assert.equal(schema.definitions["signals-twai"].additionalProperties, false);
  assert.equal(schema.definitions["signals-sdmmc"].additionalProperties, false);
  assert.deepEqual(Object.keys(schema.definitions["signals-twai"].properties).sort(), ["tx", "rx", "bus_off", "clkout"].sort());
  assert.deepEqual(Object.keys(schema.definitions["signals-sdmmc"].properties).sort(), ["clk", "cmd", "d0", "d1", "d2", "d3"].sort());
  assert.equal(schema.definitions["signals-lpuart"].additionalProperties, false);
  assert.equal(schema.definitions["signals-lpi2c"].additionalProperties, false);
  assert.deepEqual(Object.keys(schema.definitions["signals-lpuart"].properties).sort(), ["tx", "rx", "rts", "cts", "dsr", "dtr"].sort());
  assert.deepEqual(Object.keys(schema.definitions["signals-lpi2c"].properties).sort(), ["sda", "scl"].sort());
  assert.ok(schema.definitions["signals-adc"].description.includes("ADC1"));
  // Schema's gpioRef regex should reject malformed values.
  const gpioPattern = new RegExp(schema.definitions.gpioRef.pattern);
  assert.ok(gpioPattern.test("GPIO0"));
  assert.ok(gpioPattern.test("GPIO48"));
  assert.ok(!gpioPattern.test("GPIO08"));
  assert.ok(!gpioPattern.test("gpio0"));
  // A representative valid document parses cleanly through model parseConfig.
  const doc = JSON.stringify({
    version: 1,
    target: { chip: "esp32s3" },
    pins: [{ gpio: 17, function: "GPIO_INPUT", label: "s1" }],
    peripherals: {
      i2c0: { type: "i2c", instance: 0, signals: { sda: "GPIO8", scl: "GPIO9" } },
      adc1: { type: "adc", instance: 1, signals: { in: "GPIO5" } }
    }
  });
  assert.equal(parseConfig(doc).peripherals?.adc1?.type, "adc");
});

test("schema root allOf constrains per-chip owner names and per-type instance enums", () => {
  const schema = JSON.parse(readFileSync(resolve(repoRoot, "schemas", "pinconfig.schema.json"), "utf8"));
  assert.ok(Array.isArray(schema.allOf), "schema root should declare per-chip allOf rules");
  assert.equal(schema.allOf.length, 3, "one rule per target chip (s3 / c6 / p4)");
  // Utility: pick the chip-rule by const value.
  const chipRule = (chip: string) => schema.allOf
    .find((rule: any) => rule?.if?.properties?.target?.properties?.chip?.const === chip) as any;
  const owners = (chip: string) => new Set(chipRule(chip).then.properties.peripherals.propertyNames.enum as string[]);
  const instEnums = (chip: string) => chipRule(chip).then.properties.peripherals.additionalProperties.allOf as any[];
  const instEnumForType = (chip: string, type: string) => instEnums(chip)
    .find((r: any) => r?.if?.properties?.type?.const === type)?.then?.properties?.instance?.enum as number[];

  // ESP32-C6 has no uart2, no i2c1, no i2s1, no adc2, no spi3; but has uart0/uart1.
  assert.equal(owners("esp32c6").has("uart0"), true);
  assert.equal(owners("esp32c6").has("uart2"), false);
  assert.equal(owners("esp32c6").has("i2c1"), false);
  assert.equal(owners("esp32c6").has("i2s1"), false);
  assert.equal(owners("esp32c6").has("adc2"), false);
  assert.equal(owners("esp32c6").has("spi3"), false);
  assert.deepEqual(instEnumForType("esp32c6", "uart"), [0, 1]);
  assert.deepEqual(instEnumForType("esp32c6", "adc"), [1]);
  assert.deepEqual(instEnumForType("esp32c6", "spi"), [2]);

  // ESP32-S3: adc 1+2, uart 0-2, i2s 0-1, spi 2-3.
  assert.equal(owners("esp32s3").has("adc1"), true);
  assert.equal(owners("esp32s3").has("adc2"), true);
  assert.equal(owners("esp32s3").has("i2s2"), false);
  assert.deepEqual(instEnumForType("esp32s3", "uart"), [0, 1, 2]);
  assert.deepEqual(instEnumForType("esp32s3", "spi"), [2, 3]);
  assert.deepEqual(instEnumForType("esp32s3", "ledc"), [0, 1, 2, 3, 4, 5, 6, 7]);

  // ESP32-P4: uart 0-4, i2s 0-2, adc 1+2 (ADC1 GPIO16-23, ADC2 GPIO49-54).
  assert.equal(owners("esp32p4").has("uart4"), true);
  assert.equal(owners("esp32p4").has("uart5"), false);
  assert.equal(owners("esp32p4").has("adc2"), true);
  assert.deepEqual(instEnumForType("esp32p4", "uart"), [0, 1, 2, 3, 4]);
  assert.deepEqual(instEnumForType("esp32p4", "i2s"), [0, 1, 2]);
  assert.deepEqual(instEnumForType("esp32p4", "adc"), [1, 2]);
  // P4 dedicated camera/lcd owners + camera_mipi/lcd_mipi new types
  assert.equal(owners("esp32p4").has("camera0"), true);
  assert.equal(owners("esp32p4").has("camera_mipi0"), true);
  assert.equal(owners("esp32p4").has("lcd0"), true);
  assert.equal(owners("esp32p4").has("lcd_mipi0"), true);
  assert.equal(owners("esp32p4").has("camera_mipi1"), false);
  assert.equal(owners("esp32p4").has("lcd_mipi1"), false);
  assert.deepEqual(instEnumForType("esp32p4", "camera"),       [0]);
  assert.deepEqual(instEnumForType("esp32p4", "camera_mipi"),  [0]);
  assert.deepEqual(instEnumForType("esp32p4", "lcd"),          [0]);
  assert.deepEqual(instEnumForType("esp32p4", "lcd_mipi"),     [0]);
  // S3 keeps DVP camera + RGB lcd (camera_mipi/lcd_mipi types not permitted owners on S3)
  assert.equal(owners("esp32s3").has("camera_mipi0"), false);
  assert.equal(owners("esp32s3").has("lcd_mipi0"), false);
  // C6 has no camera/lcd owners at all
  assert.equal(owners("esp32c6").has("camera0"), false);
  assert.equal(owners("esp32c6").has("lcd0"), false);
  assert.equal(owners("esp32c6").has("camera_mipi0"), false);
  assert.equal(owners("esp32c6").has("lcd_mipi0"), false);
  // USB is present on every chip; lcd_mcu only where LCD_CAM exists (S3 / P4, not C6).
  assert.equal(owners("esp32s3").has("usb0"), true);
  assert.equal(owners("esp32c6").has("usb0"), true);
  assert.equal(owners("esp32p4").has("usb0"), true);
  assert.equal(owners("esp32s3").has("lcd_mcu0"), true);
  assert.equal(owners("esp32p4").has("lcd_mcu0"), true);
  assert.equal(owners("esp32c6").has("lcd_mcu0"), false);
  assert.deepEqual(instEnumForType("esp32s3", "usb"),     [0]);
  assert.deepEqual(instEnumForType("esp32c6", "usb"),     [0]);
  assert.deepEqual(instEnumForType("esp32p4", "usb"),     [0]);
  assert.deepEqual(instEnumForType("esp32s3", "lcd_mcu"), [0]);
  assert.deepEqual(instEnumForType("esp32p4", "lcd_mcu"), [0]);
  // USB / LCD_MCU signal schemas defined, additionalProperties=false
  assert.equal(schema.definitions["signals-usb"].additionalProperties, false);
  assert.equal(schema.definitions["signals-lcd-mcu"].additionalProperties, false);
  assert.deepEqual(Object.keys(schema.definitions["signals-usb"].properties).sort(), ["dn","dp"].sort());
  assert.equal(Object.keys(schema.definitions["signals-lcd-mcu"].properties).includes("d15"), true);
  // MIPI signal schemas defined, additionalProperties=false
  assert.equal("signals-camera-mipi" in schema.definitions, true);
  assert.equal("signals-lcd-mipi" in schema.definitions, true);
  assert.equal(schema.definitions["signals-camera-mipi"].additionalProperties, false);
  assert.equal(schema.definitions["signals-lcd-mipi"].additionalProperties, false);
  const camMipiProps = Object.keys(schema.definitions["signals-camera-mipi"].properties);
  assert.deepEqual(camMipiProps.sort(),
    ["csi_clkp","csi_clkn","csi_d0p","csi_d0n","csi_d1p","csi_d1n","xclk","pwdn","reset"].sort());
  const lcdMipiProps = Object.keys(schema.definitions["signals-lcd-mipi"].properties);
  assert.equal(lcdMipiProps.includes("dsi_d0p") && lcdMipiProps.includes("dsi_d3n"), true);
  assert.equal(lcdMipiProps.includes("te") && lcdMipiProps.includes("bl_pwm"), true);

  // TWAI (CAN) is a GPIOMatrix-routed type with a chip-specific controller count.
  assert.deepEqual(instEnumForType("esp32s3", "twai"), [0]);
  assert.deepEqual(instEnumForType("esp32c6", "twai"), [0, 1]);
  assert.deepEqual(instEnumForType("esp32p4", "twai"), [0, 1, 2]);
  assert.equal(owners("esp32s3").has("twai0"), true);
  assert.equal(owners("esp32c6").has("twai1"), true);
  assert.equal(owners("esp32p4").has("twai2"), true);
  assert.equal(owners("esp32s3").has("twai1"), false);

  // SDMMC host: S3 has two GPIOMatrix slots, P4 only slot 1, C6 has no host at all.
  assert.deepEqual(instEnumForType("esp32s3", "sdmmc"), [0, 1]);
  assert.deepEqual(instEnumForType("esp32p4", "sdmmc"), [1]);
  assert.equal(owners("esp32s3").has("sdmmc0"), true);
  assert.equal(owners("esp32s3").has("sdmmc1"), true);
  assert.equal(owners("esp32p4").has("sdmmc1"), true);
  assert.equal(owners("esp32p4").has("sdmmc0"), false);
  assert.equal(owners("esp32c6").has("sdmmc0"), false);
  assert.equal(instEnumForType("esp32c6", "sdmmc"), undefined);

  // LP UART / LP I2C exist only on ESP32-P4 (single instance each), on the GPIO0-15 LP domain.
  assert.deepEqual(instEnumForType("esp32p4", "lpuart"), [0]);
  assert.deepEqual(instEnumForType("esp32p4", "lpi2c"), [0]);
  assert.equal(owners("esp32p4").has("lpuart0"), true);
  assert.equal(owners("esp32p4").has("lpi2c0"), true);
  assert.equal(owners("esp32p4").has("lpuart1"), false);
  assert.equal(owners("esp32p4").has("lpi2c1"), false);
  assert.equal(owners("esp32s3").has("lpuart0"), false);
  assert.equal(owners("esp32s3").has("lpi2c0"), false);
  assert.equal(owners("esp32c6").has("lpuart0"), false);
  assert.equal(owners("esp32c6").has("lpi2c0"), false);
});
