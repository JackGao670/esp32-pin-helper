import { useMemo } from "react";
import { normalizeLanguage, translator, type Language, type Translate } from "../../src/i18n/messages";
import { usePlanner } from "./store";

/**
 * The host resolves the configured language (setting > VS Code display language) and sends it in
 * every state message. Standalone browser previews have no host, so fall back to the browser locale.
 */
export function useLanguage(): Language {
  return usePlanner(store => store.state.language
    ?? normalizeLanguage(typeof navigator !== "undefined" ? navigator.language : undefined));
}

export function useTranslate(): Translate {
  const language = useLanguage();
  return useMemo(() => translator(language), [language]);
}
