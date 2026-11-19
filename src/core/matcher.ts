import type { MatchTarget } from "./types.ts";

/**
 * Normalize a pattern list from string / comma-separated string / array.
 */
export function normalizePatterns(input: string | string[] | undefined): string[] {
  if (!input) return [];
  const rawList = Array.isArray(input) ? input : [input];
  const result: string[] = [];
  for (const item of rawList) {
    if (typeof item !== "string") continue;
    for (const part of item.split(",")) {
      const trimmed = part.trim();
      if (trimmed.length > 0) {
        result.push(trimmed);
      }
    }
  }
  return result;
}

/**
 * Convert a glob pattern (* and ?) to a case-insensitive RegExp.
 * Implemented without relying on non-standard regex features so it works identically
 * in Bun and Magpie's embedded moejs runtime.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      out += ".*";
    } else if (ch === "?") {
      out += ".";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  out += "$";
  return new RegExp(out, "i");
}

export function isWildcardPattern(pattern: string): boolean {
  const clean = pattern.startsWith("!") ? pattern.slice(1) : pattern;
  return clean.includes("*") || clean.includes("?");
}

/**
 * Extract candidate strings for a model + optional provider:
 * - full: "provider/model" (when provider known or model already contains "/")
 * - bare: model segment after last "/"
 * - raw: original model string as-is
 */
export function buildModelCandidates(
  model: string,
  provider?: string,
  requestedModel?: string
): { full: string[]; bare: string[] } {
  const fullSet = new Set<string>();
  const bareSet = new Set<string>();

  const addModel = (m?: string, p?: string) => {
    const cleanModel = (m || "").trim();
    const cleanProvider = (p || "").trim();
    if (!cleanModel) return;

    const slashIdx = cleanModel.indexOf("/");
    if (slashIdx >= 0) {
      fullSet.add(cleanModel);
      const after = cleanModel.slice(slashIdx + 1);
      if (after) bareSet.add(after);
      const lastSlash = cleanModel.lastIndexOf("/");
      if (lastSlash > slashIdx) {
        bareSet.add(cleanModel.slice(lastSlash + 1));
      }
    } else {
      bareSet.add(cleanModel);
      if (cleanProvider) {
        fullSet.add(`${cleanProvider}/${cleanModel}`);
      }
    }
  };

  addModel(model, provider);

  // If resolved model is empty (e.g. pre-routing preview), fall back to requestedModel.
  // Also allow explicit rules targeting routing group names like "group/coding" via fullSet.
  if (requestedModel) {
    const req = requestedModel.trim();
    if (!model) {
      addModel(req, provider);
    } else if (req.includes("/")) {
      fullSet.add(req);
    }
  }

  return {
    full: Array.from(fullSet),
    bare: Array.from(bareSet),
  };
}

/**
 * Match a single positive/negative pattern (without leading "!") against model candidates.
 */
function matchSingleModelPattern(
  pattern: string,
  candidates: { full: string[]; bare: string[] }
): boolean {
  const regex = globToRegExp(pattern);
  if (pattern.includes("/")) {
    return candidates.full.some((c) => regex.test(c));
  }
  return (
    candidates.bare.some((c) => regex.test(c)) ||
    candidates.full.some((c) => regex.test(c))
  );
}

/**
 * Match a list of model expressions (supporting positive patterns and `!` negations).
 * Rules:
 * - Must match at least one positive pattern (or if ONLY negative patterns exist, matches everything except negated).
 * - Must NOT match any negative pattern.
 */
export function matchesModelPatterns(
  patterns: string[],
  target: Pick<MatchTarget, "provider" | "model" | "requestedModel">
): boolean {
  const normalized = normalizePatterns(patterns);
  if (normalized.length === 0) return false;

  const positives: string[] = [];
  const negatives: string[] = [];

  for (const p of normalized) {
    if (p.startsWith("!")) {
      const inner = p.slice(1).trim();
      if (inner) negatives.push(inner);
    } else {
      positives.push(p);
    }
  }

  const candidates = buildModelCandidates(
    target.model,
    target.provider,
    target.requestedModel
  );

  if (candidates.full.length === 0 && candidates.bare.length === 0) {
    return false;
  }

  for (const neg of negatives) {
    if (matchSingleModelPattern(neg, candidates)) {
      return false;
    }
  }

  if (positives.length === 0) {
    return negatives.length > 0;
  }

  return positives.some((pos) => matchSingleModelPattern(pos, candidates));
}

/**
 * Match agent filter (defaults to match all when empty or contains "*").
 * Supports negation like "!claude".
 */
export function matchesAgentPatterns(
  agents: string[] | undefined,
  agent: string | undefined
): boolean {
  const normalized = normalizePatterns(agents);
  if (normalized.length === 0) return true;

  const positives: string[] = [];
  const negatives: string[] = [];

  for (const p of normalized) {
    if (p.startsWith("!")) {
      const inner = p.slice(1).trim();
      if (inner) negatives.push(inner);
    } else {
      positives.push(p);
    }
  }

  const targetAgent = (agent || "").trim();

  if (targetAgent) {
    for (const neg of negatives) {
      if (globToRegExp(neg).test(targetAgent)) return false;
    }
  }

  if (positives.length === 0) return true;
  if (positives.includes("*")) return true;
  if (!targetAgent) return false;

  return positives.some((pos) => globToRegExp(pos).test(targetAgent));
}

/**
 * Check if all positive patterns in a list are exact (no wildcards).
 */
export function hasExactModelPattern(patterns: string[]): boolean {
  const positives = normalizePatterns(patterns).filter((p) => !p.startsWith("!"));
  if (positives.length === 0) return false;
  return positives.some((p) => !isWildcardPattern(p));
}
