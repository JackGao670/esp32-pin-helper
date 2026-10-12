import data from "../../../devices/esp32s3/peripherals.json";
import c6 from "../../../devices/esp32c6/peripherals.json";
import p4 from "../../../devices/esp32p4/peripherals.json";
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
  const packs = [data, c6, p4];
  return (packs.find(pack => pack.chip === chip)?.peripherals ?? []) as PeripheralDefinition[];
}

export function definition(type: string, instance: number, chip = "esp32s3"): PeripheralDefinition | undefined {
  return getPeripherals(chip).find(peripheral => peripheral.type === type && peripheral.instances.includes(instance));
}

export function supportsSignal(pin: PinDefinition, signal: SignalDefinition): boolean {
  return (signal.direction !== "output" ? pin.capabilities.input : true) &&
    (signal.direction !== "input" ? pin.capabilities.output : true) &&
    (!signal.openDrain || pin.capabilities.openDrain) &&
    (signal.routing === "gpio_matrix" ? pin.capabilities.gpioMatrix
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
