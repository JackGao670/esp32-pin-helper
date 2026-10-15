/**
 * Two-language message catalog for the interface layer (§4.7 i18n).
 *
 * Pure core: no `vscode` import, so the extension host and the WebView (and node tests) share one
 * source of truth. Scope is deliberately the *interface* — WebView UI text, the Activity Bar home
 * view, and the `package.nls.json` metadata. Validator/parser diagnostics keep their own stable
 * English strings (they are asserted verbatim by many tests and read by tooling).
 */

export const LANGUAGES = ["en", "zh-cn"] as const;
export type Language = (typeof LANGUAGES)[number];
/** The `espPinPlanner.language` setting: `auto` follows the VS Code / browser display language. */
export type LanguageSetting = "auto" | Language;

export function isLanguage(value: unknown): value is Language {
  return value === "en" || value === "zh-cn";
}

export function isLanguageSetting(value: unknown): value is LanguageSetting {
  return value === "auto" || isLanguage(value);
}

/**
 * BCP-47 tags are case-insensitive and region-qualified: "zh-CN", "zh-TW" and "zh-Hans" all map to
 * Simplified Chinese; anything else falls back to English.
 */
export function normalizeLanguage(tag: string | undefined): Language {
  return (tag ?? "").toLowerCase().startsWith("zh") ? "zh-cn" : "en";
}

/** The setting wins when it is explicit; otherwise the host display language decides. */
export function resolveLanguage(setting: LanguageSetting | undefined, hostTag: string | undefined): Language {
  return setting && setting !== "auto" ? setting : normalizeLanguage(hostTag);
}

const en = {
  "target.label": "Target Chip",
  "target.unsupportedOption": "{chip} (unsupported)",
  "unsupported.title": "Unsupported target",
  "unsupported.body": "No database is available for this target. Hardware constraints were not checked.",
  "unsupported.preserved": "The existing configuration is preserved. No pin map is applied to this chip.",
  "action.openJson": "Open JSON",

  "problems.title": "Problems",
  "problems.count": "{errors} errors · {warnings} warnings",
  "problems.empty": "No issues detected by the implemented GPIO and basic peripheral checks. Package, memory mode and SDK constraints are not fully validated.",

  "resources.label": "Peripherals and target chip",
  "resources.title": "Peripherals",
  "resources.gpioCount": "GPIOs assigned",
  "resources.configurationOnly": "Configuration only.",
  "resources.noCodegen": "No C/C++ generation.",

  "canvas.title": "GPIO Overview",
  "canvas.subtitle": "Logical layout, not a package pad map",
  "canvas.boardSuffix": " · Board: {board}",
  "canvas.count": "{count} logical GPIOs",
  "canvas.legendLabel": "Pin status legend",
  "canvas.groupLabel": "GPIO overview for {chip}",
  "canvas.chipMark": "GPIO Matrix",
  "canvas.source": "Source: {document} ({version}). {scope}",

  "legend.unused": "unused",
  "legend.assigned": "assigned",
  "legend.warning": "warning",
  "legend.error": "error",
  "legend.selected": "selected",
  "legend.reserved": "reserved",
  "legend.onboard": "onboard",
  "legend.candidate": "candidate",

  "inspector.label": "Pin inspector",
  "inspector.eyebrow": "PIN INSPECTOR",
  "inspector.statusConflict": "Conflict",
  "inspector.statusAssigned": "Assigned",
  "inspector.statusReserved": "Reserved",
  "inspector.statusUnassigned": "Unassigned",
  "inspector.boardReserved": "Board reserved · {board}. Reassigning this pin may conflict with onboard hardware.",
  "inspector.boardWired": "Board-wired · {board}. {usage}. Reusing this pin disables that on-board device.",
  "inspector.usedBy": "Used by {owner}: {signal}",
  "inspector.function": "Function",
  "inspector.functionUnassigned": "Unassigned",
  "inspector.functionNotValidated": "{name} (not validated)",
  "inspector.capabilities": "Capabilities",
  "inspector.restrictions": "Restrictions",
  "inspector.noRestrictions": "No chip-level GPIO restrictions listed.",
  "inspector.configuration": "Configuration",
  "inspector.syncing": "Synchronizing...",
  "boolean.yes": "Yes",
  "boolean.no": "No",

  "pin.summaryReserved": "Reserved",
  "pin.summaryOnboard": "Onboard",
  "pin.summaryCandidate": "Candidate",
  "pin.summaryUnassigned": "Unassigned",
  "pin.descReserved": "{label} — reserved on {board}",
  "pin.descOnboard": "{label} — wired to {usage} on {board}",
  "pin.descCandidate": "{label} — recommended by auto-assign",
  "pin.descGeneric": "{label} — {summary}",

  "preset.cameraTitle": "Camera Preset",
  "preset.cameraSensor": "Sensor / bus",
  "preset.cameraPick": "Pick a camera sensor preset…",
  "preset.cameraNote": "Presets are advisory — adjust data lanes/pclk/vsync/href & SCCB pins to match your board.",
  "preset.lcdTitle": "LCD Preset",
  "preset.lcdPanel": "Panel / bus width",
  "preset.lcdPick": "Pick an LCD panel preset…",
  "preset.lcdNote": "Presets are advisory — set RGB width, MIPI lane count, WRX/DCX/CS/RST/backlight/TE pins to match your design.",

  "boardDefaults.title": "Board Defaults",
  "boardDefaults.note": "Recommended routing for {board}. Applying adds the peripheral (if missing) and fills its signals.",
  "boardDefaults.apply": "Apply",
  "boardDefaults.applyLabel": "Apply {owner} board defaults",

  "add.title": "Add Peripheral",
  "add.type": "Type",
  "add.instance": "Instance",
  "add.autoAssign": "Auto-assign pins",
  "add.avoidStrapping": "Avoid strapping / boot pins",
  "add.recommend": "Recommend pins for {owner}",
  "add.plain": "Add {owner}",

  "plan.heading": "Auto-assign · {count} plan",
  "plan.headingMany": "Auto-assign · {count} plans",
  "plan.dismiss": "Dismiss",
  "plan.none": "No viable auto-assignment for {owner} on {chip} with the current pins. Add it manually to inspect the routes.",
  "plan.lockedNote": "Accepted signals are locked to their pin; Replace tries another pin for one signal.",
  "plan.tab": "Plan {index}, score {score}",
  "plan.lockedBadge": "locked",
  "plan.selectPin": "Select this pin",
  "plan.selectPinLabel": "Select {ref} for {owner}",
  "plan.accept": "Accept",
  "plan.acceptTitle": "Lock this pin and re-route the other signals",
  "plan.acceptLabel": "Accept {ref} for {owner}",
  "plan.replace": "Replace",
  "plan.replaceTitle": "Try a different pin for this signal",
  "plan.replaceLabel": "Replace {ref} for {owner}",
  "plan.apply": "Apply plan #{index}",

  "peripheral.remove": "Remove",
  "peripheral.removeLabel": "Remove {owner}",
  "peripheral.unsupported": "Unsupported peripheral. Data preserved.",
  "signal.notAssigned": "Not assigned",
  "signal.invalid": "{value} (invalid)",
  "signal.used": " (used)",
  "peripheral.note1": "UART: full duplex. SPI: master mode. LEDC: PWM output. ADC: analog input. I2S: master mode.",
  "peripheral.note2": "I2C needs external pull-up resistors. RMT direction is not enforced. ADC2 shares hardware with Wi-Fi.",
  "peripheral.note3": "* Required in this profile.",

  "home.subtitleNoFolder": "Open a folder to plan ESP32 pins.",
  "home.subtitleNoFile": "No .pinconfig.json in {folder}.",
  "home.subtitleInvalid": ".pinconfig.json in {folder} could not be parsed.",
  "home.subtitleUnsupported": " (not supported)",
  "home.rowProblem": "Problem",
  "home.rowChip": "Chip",
  "home.rowBoard": "Board",
  "home.errors": "{count} errors",
  "home.warnings": "{count} warnings",
  "command.open": "Open Pin Planner",
  "command.create": "Create New Pin Config",
  "command.validate": "Validate Pin Config",
  "command.selectTarget": "Select Target Chip",
  "header.board": "Board: {board}",
  "boardPin.reserved": "board-reserved",
  "boardPin.onboard": "on-board",

  "flow.openWorkspaceFirst": "Open a workspace containing .pinconfig.json first.",
  "flow.noConfigCreate": "No .pinconfig.json in this workspace. Use Create New Pin Config first.",
  "flow.saveBeforeTarget": "Save or discard JSON editor changes before selecting the target chip.",
  "flow.currentTarget": "Current target: {chip}",
  "flow.targetChangedKept": "Target changed to {chip}. Existing assignments were kept; review the new diagnostics.",
  "flow.targetChanged": "Target changed to {chip}.",
  "flow.targetFailed": "Select target chip failed: {error}",
  "flow.targetChangedDuring": "Configuration changed while selecting target.",
  "flow.targetUpdateFailed": "Could not update the target chip.",
  "flow.targetSaveFailed": "Target change could not be saved.",
  "flow.openWorkspaceBeforeCreate": "Open a workspace before creating a pin configuration.",
  "flow.detectedTarget": "Detected target: {chip}",
  "flow.defaultTarget": "Default target (espPinPlanner.defaultTarget): {chip}",
  "flow.supportedDb": "Supported basic database",
  "flow.unsupportedDb": "Detected project target; database not supported yet",
  "flow.createTitle": "Create Pin Configuration",
  "flow.configAlreadyOpen": "A pin configuration is already open. Existing configuration will not be overwritten.",
  "flow.createFailedExists": "Could not create configuration; check whether it already exists.",
  "flow.saveFailed": "Configuration could not be saved.",
  "flow.createFailed": "Create pin configuration failed: {error}",
  "flow.validateResult": "ESP Pin Planner: {errors} errors, {warnings} warnings. Only implemented constraints were checked.",
  "flow.validateFailed": "Pin validation failed: {error}",
  "flow.viewInPlanner": "View in Pin Planner",
  "flow.saveBeforeEdit": "Save or discard your JSON editor changes before editing from Pin Planner.",
  "flow.applyFailed": "Could not apply configuration edit.",
  "flow.saveFailedInMemory": "Configuration changed in memory but could not be saved.",
  "flow.invalidGpio": "Invalid GPIO assignment request.",
  "flow.invalidRoute": "Invalid peripheral GPIO route.",

  "notice.previewFile": "Preview (open a workspace to save)",
  "notice.browserPreviewFile": "Browser preview (not saved to disk)",
  "notice.previewMode": "Preview mode: edits are in memory only.",
  "notice.loading": "Loading...",
  "notice.detectFailed": "Could not detect project target: {error}. ",
  "notice.detectedTarget": "Detected project target {chip}. Choose a GPIO function to create .pinconfig.json.",
  "notice.defaultTarget": "Default target {chip} (espPinPlanner.defaultTarget). Choose a GPIO function to create .pinconfig.json.",
  "notice.unsupportedTarget": "Target {chip} is not supported. Editing disabled.",
  "notice.readFailed": "Cannot read configuration: {error}. Fix it in the JSON editor.",
  "notice.readOnly": "Configuration is read-only. Open a supported workspace configuration before editing.",
  "notice.changedExternally": "Configuration changed externally. Review the refreshed state and retry.",
  "notice.targetMismatch": "Project target {project} differs from pin configuration target {config}. Configuration was not changed."
} as const;

export type MessageKey = keyof typeof en;

const zhCn: Record<MessageKey, string> = {
  "target.label": "目标芯片",
  "target.unsupportedOption": "{chip}（不支持）",
  "unsupported.title": "不支持的目标芯片",
  "unsupported.body": "该目标芯片没有可用数据库，硬件约束未做校验。",
  "unsupported.preserved": "现有配置已保留，不会为该芯片套用任何引脚映射。",
  "action.openJson": "打开 JSON",

  "problems.title": "问题",
  "problems.count": "{errors} 个错误 · {warnings} 个警告",
  "problems.empty": "已实现的 GPIO 与外设基础检查未发现问题。封装、内存模式与 SDK 约束尚未完整校验。",

  "resources.label": "外设与目标芯片",
  "resources.title": "外设",
  "resources.gpioCount": "已分配 GPIO",
  "resources.configurationOnly": "仅做配置。",
  "resources.noCodegen": "不生成 C/C++ 代码。",

  "canvas.title": "GPIO 总览",
  "canvas.subtitle": "逻辑布局，非封装焊盘图",
  "canvas.boardSuffix": " · 开发板：{board}",
  "canvas.count": "{count} 个逻辑 GPIO",
  "canvas.legendLabel": "引脚状态图例",
  "canvas.groupLabel": "{chip} 的 GPIO 总览",
  "canvas.chipMark": "GPIO 矩阵",
  "canvas.source": "数据来源：{document}（{version}）。{scope}",

  "legend.unused": "未使用",
  "legend.assigned": "已分配",
  "legend.warning": "警告",
  "legend.error": "错误",
  "legend.selected": "已选中",
  "legend.reserved": "板载保留",
  "legend.onboard": "板载外设",
  "legend.candidate": "推荐候选",

  "inspector.label": "引脚检查器",
  "inspector.eyebrow": "引脚检查器",
  "inspector.statusConflict": "冲突",
  "inspector.statusAssigned": "已分配",
  "inspector.statusReserved": "板载保留",
  "inspector.statusUnassigned": "未分配",
  "inspector.boardReserved": "板载保留 · {board}。重新分配此引脚可能与板载硬件冲突。",
  "inspector.boardWired": "板载接线 · {board}。{usage}。复用此引脚将使该板载器件失效。",
  "inspector.usedBy": "被 {owner} 占用：{signal}",
  "inspector.function": "功能",
  "inspector.functionUnassigned": "未分配",
  "inspector.functionNotValidated": "{name}（未校验）",
  "inspector.capabilities": "能力",
  "inspector.restrictions": "限制",
  "inspector.noRestrictions": "未列出芯片级 GPIO 限制。",
  "inspector.configuration": "配置",
  "inspector.syncing": "正在同步…",
  "boolean.yes": "是",
  "boolean.no": "否",

  "pin.summaryReserved": "板载保留",
  "pin.summaryOnboard": "板载外设",
  "pin.summaryCandidate": "候选",
  "pin.summaryUnassigned": "未分配",
  "pin.descReserved": "{label} — 在 {board} 上为板载保留",
  "pin.descOnboard": "{label} — 在 {board} 上接至 {usage}",
  "pin.descCandidate": "{label} — 由自动分配推荐",
  "pin.descGeneric": "{label} — {summary}",

  "preset.cameraTitle": "摄像头预设",
  "preset.cameraSensor": "传感器 / 总线",
  "preset.cameraPick": "选择摄像头传感器预设…",
  "preset.cameraNote": "预设仅供参考 — 请按实际板子调整数据线、pclk/vsync/href 与 SCCB 引脚。",
  "preset.lcdTitle": "LCD 预设",
  "preset.lcdPanel": "面板 / 总线位宽",
  "preset.lcdPick": "选择 LCD 面板预设…",
  "preset.lcdNote": "预设仅供参考 — 请按设计设置 RGB 位宽、MIPI lane 数以及 WRX/DCX/CS/RST/背光/TE 引脚。",

  "boardDefaults.title": "开发板默认接线",
  "boardDefaults.note": "{board} 的推荐接线。应用后会补建外设（如缺失）并填入其信号。",
  "boardDefaults.apply": "应用",
  "boardDefaults.applyLabel": "应用 {owner} 的开发板默认接线",

  "add.title": "添加外设",
  "add.type": "类型",
  "add.instance": "实例",
  "add.autoAssign": "自动分配引脚",
  "add.avoidStrapping": "避开 strapping / 启动引脚",
  "add.recommend": "为 {owner} 推荐引脚",
  "add.plain": "添加 {owner}",

  "plan.heading": "自动分配 · {count} 个方案",
  "plan.headingMany": "自动分配 · {count} 个方案",
  "plan.dismiss": "关闭",
  "plan.none": "在当前引脚占用下，{chip} 上的 {owner} 无法自动分配。可手动添加后逐个查看路由。",
  "plan.lockedNote": "已接受的信号会锁定到该引脚；「替换」只为其重新尝试其它引脚。",
  "plan.tab": "方案 {index}，评分 {score}",
  "plan.lockedBadge": "已锁定",
  "plan.selectPin": "选中此引脚",
  "plan.selectPinLabel": "为 {owner} 选中 {ref}",
  "plan.accept": "接受",
  "plan.acceptTitle": "锁定此引脚并重新规划其它信号",
  "plan.acceptLabel": "为 {owner} 接受 {ref}",
  "plan.replace": "替换",
  "plan.replaceTitle": "为该信号尝试其它引脚",
  "plan.replaceLabel": "为 {owner} 替换 {ref}",
  "plan.apply": "应用方案 #{index}",

  "peripheral.remove": "移除",
  "peripheral.removeLabel": "移除 {owner}",
  "peripheral.unsupported": "不支持的外设，数据已保留。",
  "signal.notAssigned": "未分配",
  "signal.invalid": "{value}（无效）",
  "signal.used": "（已占用）",
  "peripheral.note1": "UART：全双工。SPI：主机模式。LEDC：PWM 输出。ADC：模拟输入。I2S：主机模式。",
  "peripheral.note2": "I2C 需要外部上拉电阻。RMT 方向不做强制校验。ADC2 与 Wi-Fi 共用硬件。",
  "peripheral.note3": "* 该配置下为必填。",

  "home.subtitleNoFolder": "打开一个文件夹以规划 ESP32 引脚。",
  "home.subtitleNoFile": "{folder} 中没有 .pinconfig.json。",
  "home.subtitleInvalid": "{folder} 中的 .pinconfig.json 解析失败。",
  "home.subtitleUnsupported": "（不支持）",
  "home.rowProblem": "问题",
  "home.rowChip": "芯片",
  "home.rowBoard": "开发板",
  "home.errors": "{count} 个错误",
  "home.warnings": "{count} 个警告",
  "command.open": "打开引脚规划器",
  "command.create": "新建引脚配置",
  "command.validate": "校验引脚配置",
  "command.selectTarget": "选择目标芯片",
  "header.board": "开发板：{board}",
  "boardPin.reserved": "板载保留",
  "boardPin.onboard": "板载接线",

  "flow.openWorkspaceFirst": "请先打开包含 .pinconfig.json 的工作区。",
  "flow.noConfigCreate": "该工作区没有 .pinconfig.json。请先执行「新建引脚配置」。",
  "flow.saveBeforeTarget": "请先保存或放弃 JSON 编辑器中的修改，再选择目标芯片。",
  "flow.currentTarget": "当前目标芯片：{chip}",
  "flow.targetChangedKept": "目标芯片已切换为 {chip}。原有分配已保留，请检查新的诊断结果。",
  "flow.targetChanged": "目标芯片已切换为 {chip}。",
  "flow.targetFailed": "选择目标芯片失败：{error}",
  "flow.targetChangedDuring": "选择目标芯片期间配置已变化。",
  "flow.targetUpdateFailed": "无法更新目标芯片。",
  "flow.targetSaveFailed": "目标芯片变更无法保存。",
  "flow.openWorkspaceBeforeCreate": "请先打开工作区，再新建引脚配置。",
  "flow.detectedTarget": "已识别目标芯片：{chip}",
  "flow.defaultTarget": "默认目标芯片（espPinPlanner.defaultTarget）：{chip}",
  "flow.supportedDb": "具备基础数据库",
  "flow.unsupportedDb": "识别到的项目目标芯片；数据库暂不支持",
  "flow.createTitle": "新建引脚配置",
  "flow.configAlreadyOpen": "已有一个引脚配置处于打开状态，现有配置不会被覆盖。",
  "flow.createFailedExists": "无法创建配置，请检查是否已存在同名文件。",
  "flow.saveFailed": "配置无法保存。",
  "flow.createFailed": "新建引脚配置失败：{error}",
  "flow.validateResult": "ESP Pin Planner：{errors} 个错误，{warnings} 个警告。仅校验了已实现的约束。",
  "flow.validateFailed": "引脚校验失败：{error}",
  "flow.viewInPlanner": "在引脚规划器中查看",
  "flow.saveBeforeEdit": "请先保存或放弃 JSON 编辑器中的修改，再从引脚规划器编辑。",
  "flow.applyFailed": "无法应用配置修改。",
  "flow.saveFailedInMemory": "配置在内存中已变更，但无法保存。",
  "flow.invalidGpio": "无效的 GPIO 分配请求。",
  "flow.invalidRoute": "无效的外设 GPIO 路由。",

  "notice.previewFile": "预览（打开工作区后可保存）",
  "notice.browserPreviewFile": "浏览器预览（不会写入磁盘）",
  "notice.previewMode": "预览模式：修改仅保存在内存中。",
  "notice.loading": "加载中…",
  "notice.detectFailed": "无法识别项目目标芯片：{error}。",
  "notice.detectedTarget": "已识别项目目标芯片 {chip}。选择一个 GPIO 功能即可创建 .pinconfig.json。",
  "notice.defaultTarget": "默认目标芯片 {chip}（espPinPlanner.defaultTarget）。选择一个 GPIO 功能即可创建 .pinconfig.json。",
  "notice.unsupportedTarget": "不支持目标芯片 {chip}，编辑已禁用。",
  "notice.readFailed": "无法读取配置：{error}。请在 JSON 编辑器中修复。",
  "notice.readOnly": "配置为只读。请先打开受支持的工作区配置再编辑。",
  "notice.changedExternally": "配置已被外部修改。请检查刷新后的状态后重试。",
  "notice.targetMismatch": "项目目标芯片 {project} 与引脚配置目标 {config} 不一致，配置未被修改。"
};

export const catalogs: Record<Language, Record<MessageKey, string>> = { en, "zh-cn": zhCn };

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

/**
 * `{name}` placeholders are substituted from `params`; a placeholder with no matching param is left
 * verbatim so a missing value is visible instead of silently rendering "undefined".
 */
export function translator(language: Language): Translate {
  const catalog = catalogs[language];
  return (key, params) => {
    const template = catalog[key];
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      params[name] === undefined ? match : String(params[name]));
  };
}

/** English fallback for core helpers that run before a language has been resolved. */
export const defaultTranslate: Translate = translator("en");
