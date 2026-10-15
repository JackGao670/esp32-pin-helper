import { create } from "zustand";
import { createConfig, setPin } from "../../src/core/model/config";
import type { ClientMessage, HostMessage, PlannerState } from "../../src/core/model/messages";
import { validateGpio } from "../../src/core/validator/gpio";
import { addPeripheral, removePeripheral, setSignal, selectTarget } from "../../src/core/model/peripherals";
import { getDevice } from "../../src/database/loader";
import { resolveBoardFromSettings, boardInfoOf } from "../../src/database/boardLoader";
import { DEFAULT_SETTINGS, isTargetChip } from "../../src/config/userSettings";
import { resolveLanguage, translator, type Language } from "../../src/i18n/messages";

declare const acquireVsCodeApi: undefined | (() => { postMessage(message: ClientMessage): void });
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

// Before the host sends its resolved language, mirror the WebView's own locale (§4.7 i18n).
const startupLanguage: Language = resolveLanguage(DEFAULT_SETTINGS.language,
  typeof navigator !== "undefined" ? navigator.language : undefined);
const startupTranslate = translator(startupLanguage);

interface Store {
  state: PlannerState;
  selected: number;
  pending: boolean;
  // GPIOs of the currently previewed auto-assign plan, highlighted in the pinout (§3.4).
  candidates: number[];
  select: (gpio: number) => void;
  setCandidates: (gpios: number[]) => void;
  send: (message: ClientMessage) => void;
}

function makeInitialState(): PlannerState {
  const config = createConfig();
  const chip = config.target.chip;
  const board = resolveBoardFromSettings(DEFAULT_SETTINGS.board,
    isTargetChip(chip) ? chip : "esp32s3");
  const state: PlannerState = {
    config,
    revision: 0,
    file: vscode ? startupTranslate("notice.loading") : startupTranslate("notice.browserPreviewFile"),
    writable: !vscode,
    problems: vscode ? [] : validateGpio(config),
    notice: vscode ? "" : startupTranslate("notice.previewMode"),
    board: board ? boardInfoOf(board) : undefined,
    language: startupLanguage
  };
  return state;
}

export const usePlanner = create<Store>((set, get) => ({
  state: makeInitialState(),
  selected: 0,
  pending: Boolean(vscode),
  candidates: [],
  select: selected => set({ selected }),
  setCandidates: gpios => set({ candidates: gpios }),
  send: message => {
    if (vscode) {
      if (!["ready", "openJson"].includes(message.type)) set({ pending: true });
      vscode.postMessage(message);
    } else if (message.type !== "ready" && message.type !== "openJson") {
      try {
        const state = get().state;
        const config = message.type === "setPin" ? setPin(state.config, message.gpio, message.function)
          : message.type === "addPeripheral" ? addPeripheral(state.config, message.peripheral, message.instance)
          : message.type === "removePeripheral" ? removePeripheral(state.config, message.owner)
          : message.type === "selectTarget" ? selectTarget(state.config, message.chip)
          : setSignal(state.config, message.owner, message.signal, message.gpio);
        const chip = config.target.chip;
        const board = resolveBoardFromSettings(DEFAULT_SETTINGS.board,
          isTargetChip(chip) ? chip : "esp32s3");
        set({
          selected: getDevice(config.target.chip)?.pins.some(pin => pin.gpio === get().selected) ? get().selected : 0,
          state: {
            ...state,
            config,
            revision: state.revision + 1,
            problems: validateGpio(config),
            board: board ? boardInfoOf(board) : undefined
          }
        });
      } catch (error) {
        set({ state: { ...get().state, notice: String(error) } });
      }
    }
  }
}));

window.addEventListener("message", event => {
  const message = event.data as HostMessage;
  if (message?.type === "state") usePlanner.setState({ state: message.state, pending: false, candidates: [],
    selected: getDevice(message.state.config.target.chip)?.pins.some(pin => pin.gpio === usePlanner.getState().selected) ? usePlanner.getState().selected : 0 });
  if (message?.type === "focus") usePlanner.setState({ selected: message.gpio });
});
usePlanner.getState().send({ type: "ready" });
