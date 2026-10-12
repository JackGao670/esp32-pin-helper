import type { PinAssignment, PinConfigDocument } from "./config";
import { definition, gpioNumber } from "../resolver/peripherals";
import { getDevice } from "../../database/loader";

export function selectTarget(config: PinConfigDocument, chip: string): PinConfigDocument {
  if (!getDevice(chip)) throw new Error("Unsupported target chip.");
  if (chip === config.target.chip) return config;
  if (config.pins.length || Object.keys(config.peripherals ?? {}).length) {
    throw new Error("Target switching requires an empty configuration. Existing assignments were not changed.");
  }
  const { package: _package, variant: _variant, ...target } = config.target;
  return { ...config, target: { ...target, chip } };
}

export interface ResolvedAssignment extends PinAssignment {
  owner?: string;
  signal?: string;
}

export function resolveAssignments(config: PinConfigDocument): ResolvedAssignment[] {
  const result: ResolvedAssignment[] = [...config.pins];
  for (const [owner, peripheral] of Object.entries(config.peripherals ?? {})) {
    for (const [signal, value] of Object.entries(peripheral.signals)) {
      const gpio = gpioNumber(value);
      if (gpio !== undefined) result.push({
        gpio, function: `${peripheral.type.toUpperCase()}${peripheral.instance}_${signal.toUpperCase()}`, owner, signal
      });
    }
  }
  return result;
}

export function addPeripheral(config: PinConfigDocument, type: string, instance: number): PinConfigDocument {
  if (!definition(type, instance, config.target.chip)) throw new Error("Unsupported peripheral instance.");
  if (Object.values(config.peripherals ?? {}).some(p => p.type === type && p.instance === instance)) {
    throw new Error("This peripheral instance is already configured.");
  }
  const entries = { ...config.peripherals };
  const base = `${type}${instance}`;
  let id = base;
  for (let index = 1; Object.hasOwn(entries, id); index++) id = `${base}_${index}`;
  Object.defineProperty(entries, id, { value: { type, instance, signals: {} }, enumerable: true, configurable: true, writable: true });
  return { ...config, peripherals: entries };
}

export function setSignal(config: PinConfigDocument, owner: string, signal: string, gpio: number | null): PinConfigDocument {
  const peripheral = Object.hasOwn(config.peripherals ?? {}, owner) ? config.peripherals![owner] : undefined;
  const spec = peripheral && definition(peripheral.type, peripheral.instance, config.target.chip);
  if (!peripheral || !spec?.signals.some(item => item.id === signal)) throw new Error("Unknown peripheral signal.");
  const signals = { ...peripheral.signals };
  if (gpio === null) delete signals[signal];
  else {
    if (!Number.isInteger(gpio) || gpio < 0) throw new Error("Invalid GPIO number.");
    signals[signal] = `GPIO${gpio}`;
  }
  return { ...config, peripherals: { ...config.peripherals, [owner]: { ...peripheral, signals } } };
}

export function removePeripheral(config: PinConfigDocument, owner: string): PinConfigDocument {
  const peripherals = { ...config.peripherals };
  if (!Object.hasOwn(peripherals, owner)) throw new Error("Unknown peripheral.");
  delete peripherals[owner];
  return { ...config, peripherals };
}
