import { matchesAgentPatterns, matchesModelPatterns } from "./matcher.ts";
import type {
  CarrierRule,
  InjectionPosition,
  MatchTarget,
  PromptRule,
  ResolvedRulePlan,
  RuleScope,
} from "./types.ts";

const SCOPE_ORDER: Record<RuleScope, number> = {
  "global-wildcard": 1,
  "global-exact": 2,
  "project-block": 3,
  "project-dir": 4,
  "project-sibling": 5,
};

type EvaluableRule = Pick<
  PromptRule,
  | "id"
  | "name"
  | "scope"
  | "depth"
  | "models"
  | "agents"
  | "mode"
  | "position"
  | "priority"
  | "includeUtility"
  | "content"
  | "blockSignature"
> & {
  sourcePath?: string;
  enabled?: boolean;
};

/**
 * Deterministic ordering:
 * 1. Global layers before project layers
 * 2. Within global: wildcard -> exact -> priority -> name
 * 3. Within project: outer dir (git root, depth 1) -> inner subdir (depth N),
 *    then scope (block -> dir -> sibling) -> priority -> name
 */
export function sortRules<T extends EvaluableRule>(rules: T[]): T[] {
  return [...rules].sort((a, b) => {
    const aGlobal = a.scope === "global-wildcard" || a.scope === "global-exact";
    const bGlobal = b.scope === "global-wildcard" || b.scope === "global-exact";
    if (aGlobal !== bGlobal) return aGlobal ? -1 : 1;

    if (!aGlobal && a.depth !== b.depth) {
      return a.depth - b.depth;
    }

    const scopeDiff = SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope];
    if (scopeDiff !== 0) return scopeDiff;

    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Evaluate candidate rules against a concrete match target, handling:
 * - enabled flag & utility guard
 * - model glob / provider/model / negation matching
 * - agent filtering
 * - mode: replace (clears previously accumulated lower-precedence rules)
 * - deduplication of inline-matched AGENTS.md conditional blocks
 */
export function resolveRules(
  candidates: Array<PromptRule | CarrierRule>,
  target: MatchTarget,
  inlineMatchedSignatures: string[] = [],
  strippedInlineBlocks = 0,
  unwrappedInlineBlocks = 0
): ResolvedRulePlan {
  const inlineSigSet = new Set(inlineMatchedSignatures);
  const sorted = sortRules(candidates);

  let active: PromptRule[] = [];

  for (const candidate of sorted) {
    if ("enabled" in candidate && candidate.enabled === false) continue;
    if (!candidate.content || !candidate.content.trim()) continue;
    if (target.isUtility && !candidate.includeUtility) continue;
    if (!matchesAgentPatterns(candidate.agents, target.agent)) continue;
    if (!matchesModelPatterns(candidate.models, target)) continue;

    // If this rule originated from an AGENTS.md conditional block that was ALREADY
    // present inline in the request body (and unwrapped in-place), do not double-inject.
    // Still honor its `mode: replace` if declared!
    if (candidate.mode === "replace") {
      active = [];
    }

    if (candidate.blockSignature && inlineSigSet.has(candidate.blockSignature)) {
      continue;
    }

    const normalized: PromptRule = {
      id: candidate.id,
      name: candidate.name,
      sourcePath: "sourcePath" in candidate ? candidate.sourcePath : candidate.id,
      scope: candidate.scope,
      depth: candidate.depth,
      models: candidate.models,
      agents: candidate.agents,
      mode: candidate.mode,
      position: candidate.position,
      priority: candidate.priority,
      includeUtility: candidate.includeUtility,
      enabled: true,
      content: candidate.content,
      blockSignature: candidate.blockSignature,
    };

    active.push(normalized);
  }

  const byPosition: Record<InjectionPosition, PromptRule[]> = {
    "system-end": [],
    "system-start": [],
    "developer-reminder": [],
  };

  for (const rule of active) {
    byPosition[rule.position].push(rule);
  }

  return {
    matchedRules: active,
    byPosition,
    inlineMatchedSignatures: Array.from(inlineSigSet),
    strippedInlineBlocks,
    unwrappedInlineBlocks,
  };
}

/**
 * Format a group of matched rules into a clean prompt block for injection.
 */
export function formatInjectedBlock(
  rules: PromptRule[],
  position: InjectionPosition,
  modelLabel: string
): string {
  if (rules.length === 0) return "";
  const sections = rules.map((r) => r.content.trim()).filter(Boolean);
  if (sections.length === 0) return "";

  const body = sections.join("\n\n");
  if (position === "developer-reminder") {
    return `<model-instructions model="${modelLabel}">\n${body}\n</model-instructions>`;
  }
  return body;
}
