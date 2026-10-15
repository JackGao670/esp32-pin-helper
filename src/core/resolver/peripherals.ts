import data from "esp-device-pack/devices/esp32s3/peripherals.json";
import c6 from "esp-device-pack/devices/esp32c6/peripherals.json";
import p4 from "esp-device-pack/devices/esp32p4/peripherals.json";
import c3 from "esp-device-pack/devices/esp32c3/peripherals.json";
import c2 from "esp-device-pack/devices/esp32c2/peripherals.json";
import esp32 from "esp-device-pack/devices/esp32/peripherals.json";
import s2 from "esp-device-pack/devices/esp32s2/peripherals.json";
import c5 from "esp-device-pack/devices/esp32c5/peripherals.json";
import h2 from "esp-device-pack/devices/esp32h2/peripherals.json";
import { getDevice, type PinDefinition } from "../../database/loader";

export interface SignalDefinition {
  id: string;
  direction: "input" | "output" | "bidirectional";
  routing: "gpio_matrix" | "dedicated" | "analog";
  required: boolean;
  openDrain?: boolean;
  gpio?: number[];
}
export interface PeripheralDefinition {
  type: string;
  instances: number[];
  signals: SignalDefinition[];
}

export const peripherals = data.peripherals as PeripheralDefinition[];
export function getPeripherals(chip: string): PeripheralDefinition[] {
  const packs = [data, c6, p4, c3, c2, esp32, s2, c5, h2];
  return (packs.find(pack => pack.chip === chip)?.peripherals ?? []) as PeripheralDefinition[];
}

export function definition(type: string, instance: number, chip = "esp32s3"): PeripheralDefinition | undefined {
  return getPeripherals(chip).find(peripheral => peripheral.type === type && peripheral.instances.includes(instance));
}

export function supportsSignal(pin: PinDefinition, signal: SignalDefinition): boolean {
  return (signal.direction !== "output" ? pin.capabilities.input : true) &&
    (signal.direction !== "input" ? pin.capabilities.output : true) &&
    (!signal.openDrain || pin.capabilities.openDrain) &&
    // `gpio` narrows the allowed pads: it is the fixed pad list for `dedicated` signals and an
    // explicit allow-list for `gpio_matrix` signals (e.g. the ESP32-P4 low-power domain GPIO0-15,
    // which is the only pad set reachable from the LP GPIO matrix).
    (signal.routing === "gpio_matrix" ? pin.capabilities.gpioMatrix && (!signal.gpio || signal.gpio.includes(pin.gpio))
      : signal.routing === "analog" ? pin.capabilities.analog
      : Boolean(signal.gpio?.includes(pin.gpio)));
}

export function candidates(signal: SignalDefinition, chip = "esp32s3", instance?: number): number[] {
  const device = getDevice(chip);
  if (!device) return [];
  const analogPins = signal.routing === "analog"
    ? device.adcUnits?.[String(instance)] ?? device.pins.filter(pin => pin.capabilities.analog).map(pin => pin.gpio)
    : undefined;
  return device.pins
    .filter(pin => (analogPins === undefined || analogPins.includes(pin.gpio)) && supportsSignal(pin, signal))
    .map(pin => pin.gpio);
}

export function gpioNumber(value: string): number | undefined {
  if (!/^GPIO(?:0|[1-9]\d*)$/.test(value)) return undefined;
  return Number(value.slice(4));
}
