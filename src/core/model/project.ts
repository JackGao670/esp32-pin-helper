export type TargetChip = "esp32s3" | "esp32c6" | "esp32p4";

export function parseSdkconfigTarget(text: string): string | undefined {
  const matches = [...text.replace(/^\uFEFF/, "").matchAll(/^\s*CONFIG_IDF_TARGET\s*=\s*"([a-z0-9]+)"\s*(?:#.*)?$/gm)];
  const targets = new Set(matches.map(match => match[1]));
  if (targets.size > 1) throw new Error("sdkconfig contains conflicting CONFIG_IDF_TARGET values.");
  return matches[0]?.[1];
}

export function projectNotice(configTarget: string, projectTarget?: string): string {
  return projectTarget && configTarget !== projectTarget
    ? `Project target ${projectTarget} differs from pin configuration target ${configTarget}. Configuration was not changed.`
    : "";
}
