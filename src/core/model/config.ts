export interface PinAssignment {
  gpio: number;
  function: string;
  [key: string]: unknown;
}

export interface PeripheralAssignment {
  type: string;
  instance: number;
  signals: Record<string, string>;
  [key: string]: unknown;
}

export interface PinConfigDocument {
  version: 1;
  target: { chip: string; [key: string]: unknown };
  pins: PinAssignment[];
  peripherals?: Record<string, PeripheralAssignment>;
  [key: string]: unknown;
}

export const gpioFunctions = ["GPIO_INPUT", "GPIO_OUTPUT", "GPIO_OPEN_DRAIN"] as const;
export type GpioFunction = typeof gpioFunctions[number];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createConfig(chip = "esp32s3"): PinConfigDocument {
  return { version: 1, target: { chip }, pins: [] };
}

export function parseConfig(text: string): PinConfigDocument {
  const value: unknown = JSON.parse(text);
  if (!record(value) || value.version !== 1 || !record(value.target) ||
      typeof value.target.chip !== "string" || !Array.isArray(value.pins)) {
    throw new Error("Expected version 1, target.chip and a pins array.");
  }
  for (const pin of value.pins) {
    if (!record(pin) || !Number.isInteger(pin.gpio) || typeof pin.gpio !== "number" ||
        pin.gpio < 0 || typeof pin.function !== "string" || !pin.function) {
      throw new Error("Each pin requires a non-negative integer gpio and a function.");
    }
  }
  if (value.peripherals !== undefined) {
    if (!record(value.peripherals)) throw new Error("peripherals must be an object.");
    for (const peripheral of Object.values(value.peripherals)) {
      if (!record(peripheral) || typeof peripheral.type !== "string" ||
          !Number.isInteger(peripheral.instance) || typeof peripheral.instance !== "number" ||
          peripheral.instance < 0 || !record(peripheral.signals) ||
          !Object.values(peripheral.signals).every(signal => typeof signal === "string")) {
        throw new Error("Invalid peripheral assignment.");
      }
    }
  }
  return value as unknown as PinConfigDocument;
}

export function serializeConfig(config: PinConfigDocument): string {
  return JSON.stringify(config, null, 2) + "\n";
}

export function setPin(config: PinConfigDocument, gpio: number, fn: GpioFunction | null): PinConfigDocument {
  // Existing extension fields survive a normal edit; duplicates require explicit repair.
  const assignments = config.pins.filter(pin => pin.gpio === gpio);
  if (assignments.length > 1) throw new Error("Resolve duplicate assignments in the JSON editor first.");
  const pins = config.pins.filter(pin => pin.gpio !== gpio);
  if (fn) pins.push({ ...assignments[0], gpio, function: fn });
  return { ...config, pins: pins.sort((a, b) => a.gpio - b.gpio) };
}
