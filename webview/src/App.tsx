import React from "react";
import { devices, getDevice, device as defaultDevice } from "../../src/database/loader";
import { gpioFunctions, type GpioFunction } from "../../src/core/model/config";
import { usePlanner } from "./store";
import { useTranslate } from "./i18n";
import { PeripheralPanel } from "./PeripheralPanel";
import { resolveAssignments } from "../../src/core/model/peripherals";

export function App() {
  const t = useTranslate();
  const { state, selected, select, send, pending, candidates } = usePlanner();
  const supported = getDevice(state.config.target.chip);
  const device = supported ?? defaultDevice;
  const pin = device.pins.find(pin => pin.gpio === selected)!;
  const allAssignments = resolveAssignments(state.config);
  const assignments = allAssignments.filter(assignment => assignment.gpio === selected);
  const assignment = state.config.pins.find(assignment => assignment.gpio === selected);
  const errors = state.problems.filter(problem => problem.severity === "error").length;
  const warnings = state.problems.length - errors;
  const configured = new Set(allAssignments.map(pin => pin.gpio)).size;
  const unknownFunction = assignment && !(gpioFunctions as readonly string[]).includes(assignment.function);
  const status = (gpio: number) => state.problems.some(p => p.gpio === gpio && p.severity === "error") ? "error"
    : state.problems.some(p => p.gpio === gpio) ? "warning"
    : allAssignments.some(p => p.gpio === gpio) ? "assigned" : "unused";
  const labelOf = (gpio: number): string => state.board?.labelMap[String(gpio)] ?? `GPIO${gpio}`;
  const reservedSet = new Set(state.board?.reservedGpios ?? []);
  const onboardMap = new Map((state.board?.onboardPins ?? []).map(pin => [pin.gpio, pin.usage]));
  const candidateSet = new Set(candidates);
  // A real configuration file is always named .pinconfig.json; the localized placeholders are not,
  // so they double as the "no file to open" signal without depending on the interface language.
  const hasConfigFile = state.file.endsWith(".pinconfig.json");
  const pinButton = (gpio: number) => {
    const fn = allAssignments.find(p => p.gpio === gpio)?.function;
    const boardReserved = reservedSet.has(gpio);
    // Reserved takes precedence: it is a hard "do not reuse" pin, so it never doubles as an onboard badge.
    const onboardUsage = boardReserved ? undefined : onboardMap.get(gpio);
    const recommended = candidateSet.has(gpio);
    const label = labelOf(gpio);
    const board = state.board?.name ?? "";
    const summary = fn?.replace("GPIO_", "") ?? (boardReserved ? t("pin.summaryReserved") : onboardUsage ? t("pin.summaryOnboard") : recommended ? t("pin.summaryCandidate") : t("pin.summaryUnassigned"));
    // One description feeds the tooltip and the accessible name, so a screen reader hears the same
    // context a sighted user gets from hovering (§4.7 accessibility).
    const description = boardReserved ? t("pin.descReserved", { label, board })
      : onboardUsage ? t("pin.descOnboard", { label, usage: onboardUsage, board })
      : recommended ? t("pin.descCandidate", { label })
      : t("pin.descGeneric", { label, summary });
    return <button key={gpio} className={`pin ${status(gpio)} ${selected === gpio ? "selected" : ""} ${boardReserved ? "reserved" : ""} ${onboardUsage ? "onboard" : ""} ${recommended ? "candidate" : ""}`}
      aria-pressed={selected === gpio} aria-label={description} onClick={() => select(gpio)} title={description}>
      <span className="dot" aria-hidden="true" /><strong>{label}</strong>
      <small>{summary}</small>
    </button>;
  };
  const targetSelector = <><label htmlFor="target-chip">{t("target.label")}</label>
    <select id="target-chip" value={state.config.target.chip} disabled={pending || !state.writable}
      onChange={event => send({ type: "selectTarget", chip: event.target.value, revision: state.revision })}>
      {!supported && <option value={state.config.target.chip}>{t("target.unsupportedOption", { chip: state.config.target.chip })}</option>}
      {devices.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
    </select></>;
  if (!supported) return <main>
    <header><h1>ESP Pin Planner</h1><strong>{state.config.target.chip}</strong></header>
    <section className="problems">
      <h2>{t("unsupported.title")}</h2>
      <p role="status">{state.notice || t("unsupported.body")}</p>
      <p className="muted">{t("unsupported.preserved")}</p>
      <p className="file-path">{state.file}</p>
      <button className="secondary" onClick={() => send({ type: "openJson" })}>{t("action.openJson")}</button>
    </section>
  </main>;
  return <main>
    <header>
      <div><span className="eyebrow">HARDWARE RESOURCE PLANNING</span><h1>ESP Pin Planner <span>Phase 1</span></h1></div>
      <div className="header-meta"><strong>{state.config.target.chip === device.id ? device.name : state.config.target.chip}</strong>
        <span>{t("problems.count", { errors, warnings })}</span><span className="badge">GPIO + UART / I2C / SPI / ADC / LEDC / RMT / I2S</span>
        {state.board && <span className="badge board">{t("header.board", { board: state.board.name })}</span>}</div>
    </header>
    {state.notice && <div className="notice" role="status">{state.notice}</div>}
    <div className="workspace">
      <aside className="resources" aria-label={t("resources.label")}>
        <h2>{t("resources.title")}</h2>
        <button className="resource active">GPIO <span>{device.pins.length}</span></button>
        {targetSelector}
        <PeripheralPanel key={device.id} />
        <div className="summary"><strong>{configured} / {device.pins.length}</strong><span>{t("resources.gpioCount")}</span></div>
        <p className="muted">{t("resources.configurationOnly")}<br />{t("resources.noCodegen")}</p>
      </aside>
      <section className="canvas">
        <div className="section-heading"><div><h2>{t("canvas.title")}</h2><p>{t("canvas.subtitle")}{state.board ? t("canvas.boardSuffix", { board: state.board.name }) : ""}</p></div><span>{t("canvas.count", { count: device.pins.length })}</span></div>
        <div className="legend" role="list" aria-label={t("canvas.legendLabel")}>{([["unused", "legend.unused"], ["assigned", "legend.assigned"], ["warning", "legend.warning"], ["error", "legend.error"], ["selected", "legend.selected"]] as const).map(([state_, key]) =>
          <span key={state_} className={state_} role="listitem"><i className="dot" aria-hidden="true" />{t(key)}</span>)}
          {state.board?.reservedGpios?.length && <span className="reserved" role="listitem"><i className="dot" aria-hidden="true" />{t("legend.reserved")}</span>}
          {onboardMap.size > 0 && <span className="onboard" role="listitem"><i className="dot" aria-hidden="true" />{t("legend.onboard")}</span>}
          {candidateSet.size > 0 && <span className="candidate" role="listitem"><i className="dot" aria-hidden="true" />{t("legend.candidate")}</span>}</div>
        <div className="pinout" role="group" aria-label={t("canvas.groupLabel", { chip: device.name })}>
          <div className="pin-column">{device.pins.slice(0, Math.ceil(device.pins.length / 2)).map(p => pinButton(p.gpio))}</div>
          <div className="chip"><span className="chip-mark" aria-hidden="true" /><span>ESPRESSIF</span><strong>{device.name}</strong><small>{t("canvas.chipMark")}</small></div>
          <div className="pin-column">{device.pins.slice(Math.ceil(device.pins.length / 2)).map(p => pinButton(p.gpio))}</div>
        </div>
        <p className="muted source">{t("canvas.source", { document: device.source.document, version: String(device.source.version), scope: device.scope })}</p>
      </section>
      <aside className="inspector" aria-label={t("inspector.label")}>
        <span className="eyebrow">{t("inspector.eyebrow")}</span><h2>{labelOf(selected)}</h2>
        <p className={`pin-status ${status(selected)}`} aria-live="polite">
          {assignments.length > 1 ? t("inspector.statusConflict") : assignments.length ? t("inspector.statusAssigned") : (reservedSet.has(selected) ? t("inspector.statusReserved") : t("inspector.statusUnassigned"))}
        </p>
        {reservedSet.has(selected) && state.board &&
          <p className="restriction">{t("inspector.boardReserved", { board: state.board.name })}</p>}
        {!reservedSet.has(selected) && onboardMap.has(selected) && state.board &&
          <p className="onboard-note">{t("inspector.boardWired", { board: state.board.name, usage: onboardMap.get(selected) ?? "" })}</p>}
        {assignments.filter(item => item.owner).map(item =>
          <p key={`${item.owner}:${item.signal}`} className="muted">{t("inspector.usedBy", { owner: item.owner ?? "", signal: item.signal?.toUpperCase() ?? "" })}</p>)}
        <label htmlFor="function">{t("inspector.function")}</label>
        <select id="function" value={assignment?.function ?? ""} disabled={!state.writable || pending || assignments.length > 1 || assignments.some(item => item.owner)}
          onChange={event => send({ type: "setPin", gpio: selected, function: (event.target.value || null) as GpioFunction | null, revision: state.revision })}>
          <option value="">{t("inspector.functionUnassigned")}</option>
          {unknownFunction && <option value={assignment.function}>{t("inspector.functionNotValidated", { name: assignment.function })}</option>}
          {gpioFunctions.map(fn => <option key={fn} value={fn}>{fn.replace("GPIO_", "").replaceAll("_", " ")}</option>)}
        </select>
        <h3>{t("inspector.capabilities")}</h3>
        <dl>{Object.entries(pin.capabilities).map(([name, enabled]) =>
          <React.Fragment key={name}><dt>{name}</dt><dd>{enabled ? t("boolean.yes") : t("boolean.no")}</dd></React.Fragment>)}</dl>
        <h3>{t("inspector.restrictions")}</h3>
        {pin.restrictions.length ? pin.restrictions.map(text => <p className="restriction" key={text}>{text}</p>) : <p className="muted">{t("inspector.noRestrictions")}</p>}
        <h3>{t("inspector.configuration")}</h3><p className="file-path">{state.file}</p>
        <button className="secondary" disabled={!hasConfigFile || pending} onClick={() => send({ type: "openJson" })}>{t("action.openJson")}</button>
        {pending && <p role="status">{t("inspector.syncing")}</p>}
      </aside>
    </div>
    <section className="problems">
      <div className="section-heading"><h2>{t("problems.title")}</h2><span role="status">{t("problems.count", { errors, warnings })}</span></div>
      {state.problems.length ? state.problems.map((problem, index) =>
        <button key={index} className={`problem ${problem.severity}`} onClick={() => { if (problem.gpio !== undefined && device.pins.some(pin => pin.gpio === problem.gpio)) select(problem.gpio); }}>
          <strong>{problem.severity.toUpperCase()} · {problem.gpio === undefined ? problem.owner : labelOf(problem.gpio)}</strong><span>{problem.message}</span>
        </button>) : <p className="muted">{t("problems.empty")}</p>}
    </section>
  </main>;
}
