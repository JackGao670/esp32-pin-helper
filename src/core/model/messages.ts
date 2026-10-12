import type { PinConfigDocument, GpioFunction } from "./config";
import type { Problem } from "../validator/gpio";

export interface BoardInfo {
  vendor: string;
  id: string;
  name: string;
  labelMap: Record<string, string>;
  reservedGpios: number[];
  defaultSignalMap: Record<string, Record<string, string>>;
}

export interface PlannerState {
  config: PinConfigDocument;
  revision: number;
  file: string;
  writable: boolean;
  problems: Problem[];
  notice: string;
  board?: BoardInfo;
}

export type ClientMessage =
  | { type: "ready" }
  | { type: "openJson" }
  | { type: "selectTarget"; chip: string; revision: number }
  | { type: "addPeripheral"; peripheral: string; instance: number; revision: number }
  | { type: "removePeripheral"; owner: string; revision: number }
  | { type: "setSignal"; owner: string; signal: string; gpio: number | null; revision: number }
  | { type: "setPin"; gpio: number; function: GpioFunction | null; revision: number };

export type HostMessage = { type: "state"; state: PlannerState } | { type: "focus"; gpio: number };
