import { useMemo, useState } from "react";
import { usePlanner } from "./store";
import { getPeripherals, candidates, definition } from "../../src/core/resolver/peripherals";
import { resolveAssignments } from "../../src/core/model/peripherals";
import { CAMERA_PRESETS, LCD_PRESETS, presetOwnerInstance } from "./presets";
import type { PeripheralSignalPreset } from "./presets";

/** Board default-signal-map owner keys use the `<type><instance>` convention (e.g. "spi2", "lcd_mipi0").
 *  The type may itself contain digits, so allow them after the leading letter ("i2c0", "i2s0"). */
function parseOwner(owner: string): { type: string; instance: number } | undefined {
  const match = owner.match(/^([a-z][a-z0-9_]*?)(\d+)$/);
  if (!match) return undefined;
  return { type: match[1], instance: Number(match[2]) };
}

export function PeripheralPanel() {
  const { state, send, pending, select } = usePlanner();
  const chip = state.config.target.chip;
  const peripherals = getPeripherals(chip);
  const [type, setType] = useState("uart");
  const [instance, setInstance] = useState(0);
  const available = peripherals.find(item => item.type === type) ?? peripherals[0];
  const currentInstance = available.instances.includes(instance) ? instance : available.instances[0];
  const assignments = resolveAssignments(state.config);
  const disabled = !state.writable || pending;
  const chipHasCamera = useMemo(() => peripherals.some(p => p.type === "camera" || p.type === "camera_mipi"), [peripherals]);
  const chipHasLcd    = useMemo(() => peripherals.some(p => p.type === "lcd"    || p.type === "lcd_mipi"),    [peripherals]);
  const cameraPresetsForChip = CAMERA_PRESETS.filter(p => p.targetChips.includes(chip as any));
  const lcdPresetsForChip    = LCD_PRESETS.filter(p => p.targetChips.includes(chip as any));

  function applyPreset(preset: PeripheralSignalPreset) {
    if (disabled) return;
    const { type: presetType, instance: presetInstance } = presetOwnerInstance(preset);
    const existingOwner = Object.entries(state.config.peripherals ?? {}).find(([, p]) =>
      p.type === presetType && p.instance === presetInstance)?.[0] ?? preset.owner;
    const ownerExists = state.config.peripherals?.[existingOwner]?.type === presetType
      && state.config.peripherals[existingOwner]?.instance === presetInstance;
    const revision = state.revision;
    // Step 1: add peripheral (if not there)
    if (!ownerExists) {
      send({ type: "addPeripheral", peripheral: presetType, instance: presetInstance, revision });
    }
    // Step 2: batch setSignal for each preset signal that exists on the peripheral definition
    //         (send() queue is FIFO in the extension side, so revision may advance; we use per-msg fresh revision of the
    //          enqueuer side, the extension accepts stale if the caller hasn't changed the peripheral yet)
    const def = definition(presetType, presetInstance, chip);
    const validIds = new Set(def?.signals.map(s => s.id) ?? []);
    for (const [signalId, gpioRef] of Object.entries(preset.signals)) {
      if (!validIds.has(signalId)) continue;
      const gpio = Number(gpioRef.slice(4));
      if (!Number.isFinite(gpio)) continue;
      select(gpio);
      send({ type: "setSignal", owner: existingOwner, signal: signalId, gpio, revision });
    }
    if (preset.notes?.length) {
      // best-effort focus first non-strapping signal pin to confirm
      const firstSignal = Object.entries(preset.signals).find(([s]) => validIds.has(s));
      if (firstSignal) {
        const firstGpio = Number(firstSignal[1].slice(4));
        if (Number.isFinite(firstGpio)) select(firstGpio);
      }
    }
  }

  // Board default signal map: only expose owners whose every required signal is present,
  // so a one-click apply never leaves a half-configured peripheral behind.
  const boardShortcuts = useMemo(() => {
    const map = state.board?.defaultSignalMap;
    if (!map) return [] as { owner: string; type: string; instance: number; signals: Record<string, string> }[];
    const out: { owner: string; type: string; instance: number; signals: Record<string, string> }[] = [];
    for (const [owner, signals] of Object.entries(map)) {
      const parsed = parseOwner(owner);
      if (!parsed) continue;
      const def = definition(parsed.type, parsed.instance, chip);
      if (!def) continue;
      const required = def.signals.filter(s => s.required).map(s => s.id);
      if (!required.every(id => signals[id] !== undefined)) continue;
      out.push({ owner, type: parsed.type, instance: parsed.instance, signals });
    }
    return out;
  }, [state.board, chip]);

  function applyBoardShortcut(shortcut: { owner: string; type: string; instance: number; signals: Record<string, string> }) {
    if (disabled) return;
    const revision = state.revision;
    const exists = state.config.peripherals?.[shortcut.owner]?.type === shortcut.type
      && state.config.peripherals?.[shortcut.owner]?.instance === shortcut.instance;
    if (!exists) send({ type: "addPeripheral", peripheral: shortcut.type, instance: shortcut.instance, revision });
    for (const [signalId, gpioRef] of Object.entries(shortcut.signals)) {
      const gpio = Number(gpioRef.slice(4));
      if (!Number.isFinite(gpio)) continue;
      select(gpio);
      send({ type: "setSignal", owner: shortcut.owner, signal: signalId, gpio, revision });
    }
  }

  return <div className="peripheral-panel">
    {chipHasCamera && cameraPresetsForChip.length > 0 && (
      <section>
        <h3>Camera Preset</h3>
        <label htmlFor="camera-preset">Sensor / bus</label>
        <select id="camera-preset" defaultValue="" onChange={event => {
          const p = cameraPresetsForChip.find(x => x.id === event.target.value);
          event.target.value = "";
          if (p) applyPreset(p);
        }}>
          <option value="" disabled>Pick a camera sensor preset…</option>
          {cameraPresetsForChip.map(p => (
            <option key={p.id} value={p.id}>{p.label} — {p.busWidth}</option>
          ))}
        </select>
        <p className="muted">Presets are advisory — adjust data lanes/pclk/vsync/href &amp; SCCB pins to match your board.</p>
      </section>
    )}
    {chipHasLcd && lcdPresetsForChip.length > 0 && (
      <section>
        <h3>LCD Preset</h3>
        <label htmlFor="lcd-preset">Panel / bus width</label>
        <select id="lcd-preset" defaultValue="" onChange={event => {
          const p = lcdPresetsForChip.find(x => x.id === event.target.value);
          event.target.value = "";
          if (p) applyPreset(p);
        }}>
          <option value="" disabled>Pick an LCD panel preset…</option>
          {lcdPresetsForChip.map(p => (
            <option key={p.id} value={p.id}>{p.label} — {p.busWidth}</option>
          ))}
        </select>
        <p className="muted">Presets are advisory — set RGB width, MIPI lane count, WRX/DCX/CS/RST/backlight/TE pins to match your design.</p>
      </section>
    )}
    {boardShortcuts.length > 0 && (
      <section className="board-shortcuts">
        <h3>Board Defaults</h3>
        <p className="muted">Recommended routing for {state.board?.name}. Applying adds the peripheral (if missing) and fills its signals.</p>
        <ul>
          {boardShortcuts.map(shortcut => (
            <li key={shortcut.owner}>
              <span>{shortcut.type.toUpperCase()}{shortcut.instance}
                <small>{Object.entries(shortcut.signals).map(([s, g]) => `${s}=${g}`).join(", ")}</small></span>
              <button className="secondary" disabled={disabled} onClick={() => applyBoardShortcut(shortcut)}>
                Apply
              </button>
            </li>
          ))}
        </ul>
      </section>
    )}
    <h3>Add Peripheral</h3>
    <label htmlFor="peripheral-type">Type</label>
    <select id="peripheral-type" value={type} onChange={event => {
      setType(event.target.value);
      setInstance(peripherals.find(item => item.type === event.target.value)!.instances[0]);
    }}>
      {peripherals.map(item => <option key={item.type} value={item.type}>{item.type.toUpperCase()}</option>)}
    </select>
    <label htmlFor="peripheral-instance">Instance</label>
    <select id="peripheral-instance" value={currentInstance} onChange={event => setInstance(Number(event.target.value))}>
      {available.instances.map(item => <option key={item} value={item}>{item}</option>)}
    </select>
    <button className="secondary add-peripheral" disabled={disabled} onClick={() =>
      send({ type: "addPeripheral", peripheral: available.type, instance: currentInstance, revision: state.revision })}>Add {available.type.toUpperCase()}{currentInstance}</button>
    {Object.entries(state.config.peripherals ?? {}).map(([owner, peripheral]) => {
      const spec = definition(peripheral.type, peripheral.instance, state.config.target.chip);
      return <section className="peripheral-card" key={owner}>
        <div className="section-heading"><strong>{owner}</strong>
          <button className="secondary" disabled={disabled} aria-label={`Remove ${owner}`} onClick={() =>
            send({ type: "removePeripheral", owner, revision: state.revision })}>Remove</button></div>
        {!spec && <p className="restriction">Unsupported peripheral. Data preserved.</p>}
        {spec?.signals.map(signal => {
          const current = peripheral.signals[signal.id] ?? "";
          const options = candidates(signal, state.config.target.chip, peripheral.instance);
          return <div key={signal.id}>
            <label htmlFor={`${owner}-${signal.id}`}>{signal.id.toUpperCase()}{signal.required ? " *" : ""}</label>
            <select id={`${owner}-${signal.id}`} value={current} disabled={disabled} onChange={event => {
              const gpio = event.target.value ? Number(event.target.value.slice(4)) : null;
              if (gpio !== null) select(gpio);
              send({ type: "setSignal", owner, signal: signal.id, gpio, revision: state.revision });
            }}>
              <option value="">Not assigned</option>
              {current && !options.some(gpio => current === `GPIO${gpio}`) && <option value={current}>{current} (invalid)</option>}
              {options.map(gpio => <option key={gpio} value={`GPIO${gpio}`}>
                GPIO{gpio}{assignments.some(item => item.gpio === gpio && (item.owner !== owner || item.signal !== signal.id)) ? " (used)" : ""}
              </option>)}
            </select>
          </div>;
        })}
      </section>;
    })}
    <p className="muted">UART: full duplex. SPI: master mode. LEDC: PWM output. ADC: analog input. I2S: master mode.<br />I2C needs external pull-up resistors. RMT direction is not enforced. ADC2 shares hardware with Wi-Fi.<br />* Required in this profile.</p>
  </div>;
}

