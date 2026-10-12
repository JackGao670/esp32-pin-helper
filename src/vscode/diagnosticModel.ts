import { findNodeAtLocation, parseTree, type ParseError } from "jsonc-parser";
import { parseConfig } from "../core/model/config";
import { validateGpio, type Problem } from "../core/validator/gpio";
import type { PlannerSettings } from "../config/userSettings";

export interface LocatedProblem extends Problem {
  offset: number;
  length: number;
}

export function diagnosticProblems(text: string,
                                   settingsOverride: Partial<PlannerSettings> = {}): LocatedProblem[] {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  const locate = (problem: Problem): LocatedProblem => {
    let path = problem.path ?? [];
    let node = tree && findNodeAtLocation(tree, path);
    while (!node && path.length) {
      path = path.slice(0, -1);
      node = tree && findNodeAtLocation(tree, path);
    }
    return { ...problem, offset: node?.offset ?? 0, length: node?.length ?? Math.min(1, text.length) };
  };
  if (errors.length) {
    return errors.map(error => ({
      severity: "error", message: "Invalid JSON syntax in pin configuration.",
      offset: error.offset, length: error.length
    }));
  }
  try {
    const config = parseConfig(text);
    return validateGpio(config, undefined, settingsOverride).map(locate);
  } catch (error) {
    return [locate({ severity: "error", message: error instanceof Error ? error.message : String(error) })];
  }
}
