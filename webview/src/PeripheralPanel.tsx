import { useMemo, useState } from "react";
import { usePlanner } from "./store";
import { useTranslate } from "./i18n";
import { getPeripherals, candidates, definition } from "../../src/core/resolver/peripherals";
import { resolveAssignments } from "../../src/core/model/peripherals";
import { recommendAssignment, type AssignmentPlan, type BoardHints } from "../../src/core/optimizer/assign";
import { boardShortcutsFor, type BoardShortcut } from "./boardDefaults";
import { CAMERA_PRESETS, LCD_PRESETS, presetOwnerInstance } from "./presets";
import type { PeripheralSignalPreset } from "./presets";

export function PeripheralPanel() {
  const t = useTranslate();
  const { state, send, pending, select, setCandidates, selected } = usePlanner();
  const chip = state.config.target.chip;
  const peripherals = getPeripherals(chip);
  const [type, setType] = useState("uart");
  const [instance, setInstance] = useState(0);
  const [autoAssign, setAutoAssign] = useState(true);
  const [avoidStrapping, setAvoidStrapping] = useState(true);
  const [plans, setPlans] = useState<AssignmentPlan[] | null>(null);
  const [planIndex, setPlanIndex] = useState(0);
  // Per-signal review state: accepted pins (locked) and rejected pins (tried & dismissed).
  const [pinned, setPinned] = useState<Record<string, number>>({});
  const [blocked, setBlocked] = useState<Record<string, number[]>>({});
  const available = peripherals.find(item => item.type === type) ?? peripherals[0];
  const currentInstance = available.instances.includes(instance) ? instance : available.instances[0];
  const assignments = resolveAssignments(state.config);
  const disabled = !state.writable || pending;
  // Board hints for the optimizer; BoardInfo is shape-compatible with BoardHints.
  const boardHints: BoardHints | undefined = state.board && {
    name: state.board.name, reservedGpios: state.board.reservedGpios,
    defaultRoutes: state.board.defaultSignalMap, onboardPins: state.board.onboardPins
  };
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

  // Board default signal map: owners whose every required signal is present (see boardShortcutsFor).
  const boardShortcuts = useMemo(() => boardShortcutsFor(state.board, chip), [state.board, chip]);

  function applyBoardShortcut(shortcut: BoardShortcut) {
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

  // ---- Phase 3 auto-assignment wizard (§3.3/§3.4) ----
  const planGpios = (plan: AssignmentPlan): number[] =>
    Object.values(plan.peripherals).flatMap(peripheral => Object.values(peripheral.signals).map(ref => Number(ref.slice(4))));

  // Re-solve with the given accepted pins / rejected pins and refresh the preview + highlight.
  function solve(nextPinned: Record<string, number>, nextBlocked: Record<string, number[]>,
                 nextAvoidStrapping = avoidStrapping) {
    const owner = `${available.type}${currentInstance}`;
    // Pins already assigned elsewhere are off-limits; the target owner's own routes are free to re-plan.
    const occupied = assignments.filter(item => item.owner !== owner).map(item => item.gpio);
    const result = recommendAssignment([{ type: available.type, instance: currentInstance }],
      { avoidStrapping: nextAvoidStrapping, maxPlans: 3 }, chip,
      { board: boardHints, occupied, pinned: nextPinned, blocked: nextBlocked });
    setPlans(result);
    setPlanIndex(0);
    if (result.length) {
      setCandidates(planGpios(result[0]));
      const first = planGpios(result[0])[0];
      if (first !== undefined) select(first);
    } else {
      setCandidates([]);
    }
  }

  function generatePlans() {
    if (disabled) return;
    setPinned({});
    setBlocked({});
    solve({}, {});
  }

  function previewPlan(index: number) {
    setPlanIndex(index);
    if (plans?.[index]) setCandidates(planGpios(plans[index]));
  }

  function dismissPlans() {
    setPlans(null);
    setPinned({});
    setBlocked({});
    setCandidates([]);
  }

  // Accept: lock this signal to its previewed pin, then re-route the remaining signals around it.
  function acceptSignal(key: string, gpio: number) {
    const next = { ...pinned, [key]: gpio };
    setPinned(next);
    solve(next, blocked);
  }

  // Replace: forbid the previewed pin for this signal only, then look for an alternative.
  function replaceSignal(key: string, gpio: number) {
    const next = { ...blocked, [key]: [...(blocked[key] ?? []), gpio] };
    setBlocked(next);
    solve(pinned, next);
  }

  function applyPlan() {
    if (disabled || !plans?.[planIndex]) return;
    const revision = state.revision;
    const plan = plans[planIndex];
    for (const [owner, peripheral] of Object.entries(plan.peripherals)) {
      const exists = state.config.peripherals?.[owner]?.type === peripheral.type
        && state.config.peripherals?.[owner]?.instance === peripheral.instance;
      if (!exists) send({ type: "addPeripheral", peripheral: peripheral.type, instance: peripheral.instance, revision });
      for (const [signal, ref] of Object.entries(peripheral.signals)) {
        const gpio = Number(ref.slice(4));
        if (Number.isFinite(gpio)) send({ type: "setSignal", owner, signal, gpio, revision });
      }
    }
    dismissPlans();
    const first = planGpios(plan)[0];
    if (first !== undefined) select(first);
  }

  return <div className="peripheral-panel">
    {chipHasCamera && cameraPresetsForChip.length > 0 && (
      <section>
        <h3>{t("preset.cameraTitle")}</h3>
        <label htmlFor="camera-preset">{t("preset.cameraSensor")}</label>
        <select id="camera-preset" defaultValue="" onChange={event => {
          const p = cameraPresetsForChip.find(x => x.id === event.target.value);
          event.target.value = "";
          if (p) applyPreset(p);
        }}>
          <option value="" disabled>{t("preset.cameraPick")}</option>
          {cameraPresetsForChip.map(p => (
            <option key={p.id} value={p.id}>{p.label} — {p.busWidth}</option>
          ))}
        </select>
        <p className="muted">{t("preset.cameraNote")}</p>
      </section>
    )}
    {chipHasLcd && lcdPresetsForChip.length > 0 && (
      <section>
        <h3>{t("preset.lcdTitle")}</h3>
        <label htmlFor="lcd-preset">{t("preset.lcdPanel")}</label>
        <select id="lcd-preset" defaultValue="" onChange={event => {
          const p = lcdPresetsForChip.find(x => x.id === event.target.value);
          event.target.value = "";
          if (p) applyPreset(p);
        }}>
          <option value="" disabled>{t("preset.lcdPick")}</option>
          {lcdPresetsForChip.map(p => (
            <option key={p.id} value={p.id}>{p.label} — {p.busWidth}</option>
          ))}
        </select>
        <p className="muted">{t("preset.lcdNote")}</p>
      </section>
    )}
    {boardShortcuts.length > 0 && (
      <section className="board-shortcuts">
        <h3>{t("boardDefaults.title")}</h3>
        <p className="muted">{t("boardDefaults.note", { board: state.board?.name ?? "" })}</p>
        <ul>
          {boardShortcuts.map(shortcut => (
            <li key={shortcut.owner}>
              <span>{shortcut.type.toUpperCase()}{shortcut.instance}
                <small>{Object.entries(shortcut.signals).map(([s, g]) => `${s}=${g}`).join(", ")}</small>
                {shortcut.boardPins.map(pin => (
                  <small key={pin.gpio} className={`board-pin ${pin.kind}`}>
                    {`GPIO${pin.gpio} · ${pin.kind === "reserved" ? t("boardPin.reserved") : t("boardPin.onboard")}: ${pin.note}`}
                  </small>
                ))}
              </span>
              <button className="secondary" disabled={disabled} aria-label={t("boardDefaults.applyLabel", { owner: `${shortcut.type.toUpperCase()}${shortcut.instance}` })}
                onClick={() => applyBoardShortcut(shortcut)}>
                {t("boardDefaults.apply")}
              </button>
            </li>
          ))}
        </ul>
      </section>
    )}
    <h3>{t("add.title")}</h3>
    <label htmlFor="peripheral-type">{t("add.type")}</label>
    <select id="peripheral-type" value={type} onChange={event => {
      dismissPlans();
      setType(event.target.value);
      setInstance(peripherals.find(item => item.type === event.target.value)!.instances[0]);
    }}>
      {peripherals.map(item => <option key={item.type} value={item.type}>{item.type.toUpperCase()}</option>)}
    </select>
    <label htmlFor="peripheral-instance">{t("add.instance")}</label>
    <select id="peripheral-instance" value={currentInstance} onChange={event => {
      dismissPlans();
      setInstance(Number(event.target.value));
    }}>
      {available.instances.map(item => <option key={item} value={item}>{item}</option>)}
    </select>
    <label className="checkbox" htmlFor="auto-assign">
      <input id="auto-assign" type="checkbox" checked={autoAssign} onChange={event => setAutoAssign(event.target.checked)} />
      {t("add.autoAssign")}
    </label>
    {autoAssign && <label className="checkbox" htmlFor="avoid-strapping">
      <input id="avoid-strapping" type="checkbox" checked={avoidStrapping} onChange={event => {
        const value = event.target.checked;
        setAvoidStrapping(value);
        if (plans) solve(pinned, blocked, value);
      }} />
      {t("add.avoidStrapping")}
    </label>}
    <button className="secondary add-peripheral" disabled={disabled} onClick={() =>
      autoAssign ? generatePlans()
        : send({ type: "addPeripheral", peripheral: available.type, instance: currentInstance, revision: state.revision })}>
      {autoAssign ? t("add.recommend", { owner: `${available.type.toUpperCase()}${currentInstance}` })
        : t("add.plain", { owner: `${available.type.toUpperCase()}${currentInstance}` })}</button>
    {plans && <section className="plan-preview">
      <div className="section-heading"><strong>{plans.length === 1 ? t("plan.heading", { count: plans.length }) : t("plan.headingMany", { count: plans.length })}</strong>
        <button className="secondary" onClick={dismissPlans}>{t("plan.dismiss")}</button></div>
      {plans.length === 0
        ? <p className="restriction">{t("plan.none", { owner: `${available.type.toUpperCase()}${currentInstance}`, chip: chip.toUpperCase() })}</p>
        : <>
          {plans.length > 1 && <div className="plan-tabs">{plans.map((plan, index) =>
            <button key={index} className={`secondary ${index === planIndex ? "active" : ""}`} aria-pressed={index === planIndex}
              aria-label={t("plan.tab", { index: index + 1, score: Math.round(plan.score) })} onClick={() => previewPlan(index)}>
              #{index + 1} · {Math.round(plan.score)}</button>)}</div>}
          {Object.keys(pinned).length > 0 && <p className="restriction">{t("plan.lockedNote")}</p>}
          <ul className="plan-signals">{Object.entries(plans[planIndex].peripherals).flatMap(([owner, peripheral]) =>
            Object.entries(peripheral.signals).map(([signal, ref]) => {
              const key = `${owner}.${signal}`;
              const gpio = Number(ref.slice(4));
              const target = `${owner}.${signal.toUpperCase()}`;
              return <li key={key} className={gpio === selected ? "active" : ""}>
                <span className="plan-signal-name">{target}
                  {pinned[key] !== undefined && <em className="locked">{t("plan.lockedBadge")}</em>}</span>
                <button type="button" className="link-pin" title={t("plan.selectPin")}
                  aria-label={t("plan.selectPinLabel", { ref, owner: target })} onClick={() => select(gpio)}>{ref}</button>
                <span className="plan-actions">
                  <button className="secondary" title={t("plan.acceptTitle")}
                    aria-label={t("plan.acceptLabel", { ref, owner: target })} onClick={() => acceptSignal(key, gpio)}>{t("plan.accept")}</button>
                  <button className="secondary" title={t("plan.replaceTitle")}
                    aria-label={t("plan.replaceLabel", { ref, owner: target })} onClick={() => replaceSignal(key, gpio)}>{t("plan.replace")}</button>
                </span>
              </li>;
            }))}
          </ul>
          {plans[planIndex].warnings.length > 0 && <ul className="plan-warnings">
            {plans[planIndex].warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
          <button className="secondary add-peripheral" disabled={disabled} onClick={applyPlan}>{t("plan.apply", { index: planIndex + 1 })}</button>
        </>}
    </section>}
    {Object.entries(state.config.peripherals ?? {}).map(([owner, peripheral]) => {
      const spec = definition(peripheral.type, peripheral.instance, state.config.target.chip);
      return <section className="peripheral-card" key={owner}>
        <div className="section-heading"><strong>{owner}</strong>
          <button className="secondary" disabled={disabled} aria-label={t("peripheral.removeLabel", { owner })} onClick={() =>
            send({ type: "removePeripheral", owner, revision: state.revision })}>{t("peripheral.remove")}</button></div>
        {!spec && <p className="restriction">{t("peripheral.unsupported")}</p>}
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
              <option value="">{t("signal.notAssigned")}</option>
              {current && !options.some(gpio => current === `GPIO${gpio}`) && <option value={current}>{t("signal.invalid", { value: current })}</option>}
              {options.map(gpio => <option key={gpio} value={`GPIO${gpio}`}>
                GPIO{gpio}{assignments.some(item => item.gpio === gpio && (item.owner !== owner || item.signal !== signal.id)) ? t("signal.used") : ""}
              </option>)}
            </select>
          </div>;
        })}
      </section>;
    })}
    <p className="muted">{t("peripheral.note1")}<br />{t("peripheral.note2")}<br />{t("peripheral.note3")}</p>
  </div>;
}
