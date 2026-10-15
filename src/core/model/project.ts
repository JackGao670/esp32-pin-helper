import { defaultTranslate, type Translate } from "../../i18n/messages";

export type TargetChip = "esp32s3" | "esp32c6" | "esp32p4" | "esp32c3" | "esp32c2" | "esp32" | "esp32s2" | "esp32c5" | "esp32h2";

export function parseSdkconfigTarget(text: string): string | undefined {
  const matches = [...text.replace(/^\uFEFF/, "").matchAll(/^\s*CONFIG_IDF_TARGET\s*=\s*"([a-z0-9]+)"\s*(?:#.*)?$/gm)];
  const targets = new Set(matches.map(match => match[1]));
  if (targets.size > 1) throw new Error("sdkconfig contains conflicting CONFIG_IDF_TARGET values.");
  return matches[0]?.[1];
}

/** The notice is rendered inside the WebView, so it follows the interface language. */
export function projectNotice(configTarget: string, projectTarget?: string, t: Translate = defaultTranslate): string {
  return projectTarget && configTarget !== projectTarget
    ? t("notice.targetMismatch", { project: projectTarget, config: configTarget })
    : "";
}
