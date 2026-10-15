import data from "esp-device-pack/devices/esp32s3/esp32s3.json";
import c6 from "esp-device-pack/devices/esp32c6/esp32c6.json";
import p4 from "esp-device-pack/devices/esp32p4/esp32p4.json";
import { assertPackCompatible } from "./pack";

export interface PinDefinition {
  gpio: number;
  capabilities: { input: boolean; output: boolean; openDrain: boolean; gpioMatrix: boolean; analog: boolean; rtc: boolean };
  restrictions: string[];
  functions: string[];
}

interface DeviceJson {
  id: string;
  name: string;
  architecture: string;
  databaseVersion: string;
  scope: string;
  source: { document: string; version: string; url: string };
  gpioNumbers: number[];
  defaultCapabilities: { input: boolean; output: boolean; openDrain: boolean; gpioMatrix: boolean };
  strapping: number[];
  rtc: number[];
  analog: number[];
  memoryPins: number[];
  octalMemoryPins: number[];
  usbJtag: number[];
  functions: string[];
  adcUnits?: Record<string, number[]>;
  adcWifiSharedUnits?: number[];
  variantPins?: number[];
  inputOnlyPins?: number[];
  noOpenDrainPins?: number[];
  [key: string]: unknown;
}
function loadDevice(raw: unknown) {
  const data = raw as DeviceJson;
  if (!/^\d+\.\d+\.\d+$/.test(data.databaseVersion) || !data.source?.url ||
      new Set(data.gpioNumbers).size !== data.gpioNumbers.length ||
      !data.gpioNumbers.every(gpio => Number.isInteger(gpio) && gpio >= 0)) {
    throw new Error(`Invalid device database: ${data.id}`);
  }
  const inputOnly = new Set(data.inputOnlyPins ?? []);
  const noOpenDrain = new Set(data.noOpenDrainPins ?? []);
  return {
  id: data.id,
  name: data.name,
  source: data.source,
  scope: data.scope,
  adcUnits: (data.adcUnits ?? {}) as Record<string, number[]>,
  adcWifiSharedUnits: (data.adcWifiSharedUnits ?? []) as number[],
  pins: data.gpioNumbers.map((gpio): PinDefinition => ({
    gpio,
    capabilities: {
      ...data.defaultCapabilities,
      output: data.defaultCapabilities.output && !inputOnly.has(gpio),
      openDrain: data.defaultCapabilities.openDrain && !inputOnly.has(gpio) && !noOpenDrain.has(gpio),
      analog: (data.analog ?? []).includes(gpio),
      rtc: (data.rtc ?? []).includes(gpio)
    },
    restrictions: [
      ...((data.strapping ?? []).includes(gpio) ? ["Strapping pin: external circuitry may affect boot."] : []),
      ...((data.memoryPins ?? []).includes(gpio) ? ["Usually used by Flash/PSRAM; verify the chip variant and board before use."] : []),
      ...((data.octalMemoryPins ?? []).includes(gpio) ? ["Reserved when Octal Flash/PSRAM is used; memory mode is not checked in this PoC."] : []),
      ...((data.usbJtag ?? []).includes(gpio) ? ["Reconfiguration disables the default USB Serial/JTAG function."] : []),
      ...(data.variantPins?.includes(gpio) ? ["Pin is not bonded out on some SiP/non-SiP variants. Verify the exact package before use."] : []),
      ...(inputOnly.has(gpio) ? ["Input-only pin (MTDO strapping function); output and open-drain drivers are not available."] : []),
      ...(!inputOnly.has(gpio) && noOpenDrain.has(gpio) ? ["Pin does not support open-drain output; use push-pull or select a different GPIO for I2C/1-wire style buses."] : [])
    ],
    functions: data.functions
  }))
  };
}

// Fail fast if the installed esp-device-pack speaks a newer manifest shape than this build.
assertPackCompatible();
export const devices = [loadDevice(data), loadDevice(c6), loadDevice(p4)];
export const device = devices[0];
export function getDevice(chip: string) {
  return devices.find(device => device.id === chip);
}
