import React from "react";
import { createRoot } from "react-dom/client";
import { devices, getDevice, device as defaultDevice } from "../../src/database/loader";
import { gpioFunctions, type GpioFunction } from "../../src/core/model/config";
import { usePlanner } from "./store";
import "./styles.css";
import { PeripheralPanel } from "./PeripheralPanel";
import { resolveAssignments } from "../../src/core/model/peripherals";

function App() {
  const { state, selected, select, send, pending } = usePlanner();
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
  const pinButton = (gpio: number) => {
    const fn = allAssignments.find(p => p.gpio === gpio)?.function;
    const boardReserved = reservedSet.has(gpio);
    return <button key={gpio} className={`pin ${status(gpio)} ${selected === gpio ? "selected" : ""} ${boardReserved ? "reserved" : ""}`}
      aria-pressed={selected === gpio} onClick={() => select(gpio)} title={boardReserved ? `${labelOf(gpio)} — reserved on ${state.board?.name}` : labelOf(gpio)}>
      <span className="dot" /><strong>{labelOf(gpio)}</strong><small>{fn?.replace("GPIO_", "") ?? (boardReserved ? "Reserved" : "Unassigned")}</small>
    </button>;
  };
  const targetSelector = <><label htmlFor="target-chip">Target Chip</label>
    <select id="target-chip" value={state.config.target.chip} disabled={pending || !state.writable}
      onChange={event => send({ type: "selectTarget", chip: event.target.value, revision: state.revision })}>
      {!supported && <option value={state.config.target.chip}>{state.config.target.chip} (unsupported)</option>}
      {devices.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
    </select></>;
  if (!supported) return <main>
    <header><h1>ESP Pin Planner</h1><strong>{state.config.target.chip}</strong></header>
    <section className="problems">
      <h2>Unsupported target</h2>
      <p role="status">{state.notice || "No database is available for this target. Hardware constraints were not checked."}</p>
      <p className="muted">The existing configuration is preserved. No ESP32-S3 pin map is used for this chip.</p>
      <p className="file-path">{state.file}</p>
      <button className="secondary" onClick={() => send({ type: "openJson" })}>Open JSON</button>
    </section>
  </main>;
  return <main>
    <header>
      <div><span className="eyebrow">HARDWARE RESOURCE PLANNING</span><h1>ESP Pin Planner <span>Phase 1</span></h1></div>
      <div className="header-meta"><strong>{state.config.target.chip === device.id ? device.name : state.config.target.chip}</strong>
        <span>{errors} errors · {warnings} warnings</span><span className="badge">GPIO + UART / I2C / SPI / ADC / LEDC / RMT / I2S</span>
        {state.board && <span className="badge board">Board: {state.board.name}</span>}</div>
    </header>
    {state.notice && <div className="notice" role="status">{state.notice}</div>}
    <div className="workspace">
      <aside className="resources">
        <h2>Peripherals</h2>
        <button className="resource active">GPIO <span>{device.pins.length}</span></button>
        {targetSelector}
        <PeripheralPanel key={device.id} />
        <div className="summary"><strong>{configured} / {device.pins.length}</strong><span>GPIOs assigned</span></div>
        <p className="muted">Configuration only.<br />No C/C++ generation.</p>
      </aside>
      <section className="canvas">
        <div className="section-heading"><div><h2>GPIO Overview</h2><p>Logical layout, not a package pad map{state.board ? ` · Board: ${state.board.name}` : ""}</p></div><span>{device.pins.length} logical GPIOs</span></div>
        <div className="legend">{["unused", "assigned", "warning", "error", "selected"].map(s =>
          <span key={s} className={s}><i className="dot" />{s}</span>)}
          {state.board?.reservedGpios?.length && <span className="reserved"><i className="dot" />reserved</span>}</div>
        <div className="pinout">
          <div className="pin-column">{device.pins.slice(0, Math.ceil(device.pins.length / 2)).map(p => pinButton(p.gpio))}</div>
          <div className="chip"><span className="chip-mark" /><span>ESPRESSIF</span><strong>{device.name}</strong><small>GPIO Matrix</small></div>
          <div className="pin-column">{device.pins.slice(Math.ceil(device.pins.length / 2)).map(p => pinButton(p.gpio))}</div>
        </div>
        <p className="muted source">Source: {device.source.document} ({device.source.version}). {device.scope}</p>
      </section>
      <aside className="inspector">
        <span className="eyebrow">PIN INSPECTOR</span><h2>{labelOf(selected)}</h2>
        <p className={`pin-status ${status(selected)}`}>
          {assignments.length > 1 ? "Conflict" : assignments.length ? "Assigned" : (reservedSet.has(selected) ? "Reserved" : "Unassigned")}
        </p>
        {reservedSet.has(selected) && state.board &&
          <p className="restriction">Board reserved · {state.board.name}. Reassigning this pin may conflict with onboard hardware.</p>}
        {assignments.filter(item => item.owner).map(item =>
          <p key={`${item.owner}:${item.signal}`} className="muted">Used by {item.owner}: {item.signal?.toUpperCase()}</p>)}
        <label htmlFor="function">Function</label>
        <select id="function" value={assignment?.function ?? ""} disabled={!state.writable || pending || assignments.length > 1 || assignments.some(item => item.owner)}
          onChange={event => send({ type: "setPin", gpio: selected, function: (event.target.value || null) as GpioFunction | null, revision: state.revision })}>
          <option value="">Unassigned</option>
          {unknownFunction && <option value={assignment.function}>{assignment.function} (not validated)</option>}
          {gpioFunctions.map(fn => <option key={fn} value={fn}>{fn.replace("GPIO_", "").replaceAll("_", " ")}</option>)}
        </select>
        <h3>Capabilities</h3>
        <dl>{Object.entries(pin.capabilities).map(([name, enabled]) =>
          <React.Fragment key={name}><dt>{name}</dt><dd>{enabled ? "Yes" : "No"}</dd></React.Fragment>)}</dl>
        <h3>Restrictions</h3>
        {pin.restrictions.length ? pin.restrictions.map(text => <p className="restriction" key={text}>{text}</p>) : <p className="muted">No chip-level GPIO restrictions listed.</p>}
        <h3>Configuration</h3><p className="file-path">{state.file}</p>
        <button className="secondary" disabled={state.file.startsWith("Browser") || state.file.startsWith("Preview")} onClick={() => send({ type: "openJson" })}>Open JSON</button>
        {pending && <p role="status">Synchronizing...</p>}
      </aside>
    </div>
    <section className="problems">
      <div className="section-heading"><h2>Problems</h2><span>{errors} errors · {warnings} warnings</span></div>
      {state.problems.length ? state.problems.map((problem, index) =>
        <button key={index} className={`problem ${problem.severity}`} onClick={() => { if (problem.gpio !== undefined && device.pins.some(pin => pin.gpio === problem.gpio)) select(problem.gpio); }}>
          <strong>{problem.severity.toUpperCase()} · {problem.gpio === undefined ? problem.owner : labelOf(problem.gpio)}</strong><span>{problem.message}</span>
        </button>) : <p className="muted">No issues detected by the implemented GPIO and basic peripheral checks. Package, memory mode and SDK constraints are not fully validated.</p>}
    </section>
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
