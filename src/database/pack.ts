import manifest from "esp-device-pack/pack.json";

/** Device-pack manifest API versions this extension build understands. */
export const SUPPORTED_PACK_API = [1] as const;

export interface PackDeviceEntry {
  chip: string;
  device: string;
  peripherals: string;
}

export interface PackBoardEntry {
  vendor: string;
  id: string;
  path: string;
}

export interface DevicePackManifest {
  id: string;
  version: string;
  apiVersion: number;
  databaseVersion: string;
  devices: PackDeviceEntry[];
  boards: PackBoardEntry[];
}

/** The `esp-device-pack` database this build was compiled against. */
export const devicePack = manifest as DevicePackManifest;

export function packCompatible(apiVersion: number, supported: readonly number[] = SUPPORTED_PACK_API): boolean {
  return supported.includes(apiVersion);
}

/**
 * Guard the database/extension contract: the pack may evolve independently, but a manifest whose
 * shape this build does not understand must fail loudly instead of feeding the validator bad data.
 */
export function assertPackCompatible(pack: DevicePackManifest = devicePack): void {
  if (!packCompatible(pack.apiVersion)) {
    throw new Error(
      `esp-device-pack ${pack.version} uses apiVersion ${pack.apiVersion}, but this extension supports ` +
      `${SUPPORTED_PACK_API.join(", ")}. Update the extension or install a compatible pack.`
    );
  }
}
