export type ProtocolName = "anthropic" | "chat" | "responses" | "gemini" | "unknown";

export type RuleMode = "append" | "replace";

export type InjectionPosition =
  | "system-end"
  | "system-start"
  | "developer-reminder";

export type RuleScope =
  | "global-wildcard"
  | "global-exact"
  | "project-block"
  | "project-dir"
  | "project-sibling";

export interface PromptRule {
  /** Stable identifier (usually relative or absolute file path + optional block index). */
  id: string;
  /** Human-readable display label. */
  name: string;
  /** Source file path on disk (for debugging / UI). */
  sourcePath: string;
  /** Source scope determining merge priority. */
  scope: RuleScope;
  /** Directory depth from git root (0 for global, 1 for git root, 2+ for subdirs). */
  depth: number;
  /** Model match expressions (supports glob, provider/model, !negation). */
  models: string[];
  /** Optional agent filter (defaults to ["*"]). */
  agents: string[];
  /** Merge behavior: append (default) or replace lower layers. */
  mode: RuleMode;
  /** Where to inject in protocol payload. */
  position: InjectionPosition;
  /** Fine-grained tie-breaker within same scope & depth. */
  priority: number;
  /** Whether rule applies even to lightweight utility requests. */
  includeUtility: boolean;
  /** Whether rule is enabled. */
  enabled: boolean;
  /** Prompt markdown content (trimmed). */
  content: string;
  /**
   * Optional normalized block fingerprint when derived from an AGENTS.md
   * conditional block, used to avoid double injection when already present in body.
   */
  blockSignature?: string;
}

export interface ParsedFrontmatter {
  models?: string[];
  agents?: string[];
  mode?: RuleMode;
  position?: InjectionPosition;
  priority?: number;
  includeUtility?: boolean;
  enabled?: boolean;
}

export interface ParsedConditionalBlock {
  rawMatch: string;
  models: string[];
  agents: string[];
  mode: RuleMode;
  position: InjectionPosition;
  priority: number;
  includeUtility: boolean;
  content: string;
  startIndex: number;
  endIndex: number;
  signature: string;
}

export interface PluginOptions {
  enabled: boolean;
  promptsDir: string;
  extraInstructionFiles: string[];
  skipUtilityRequests: boolean;
  uiPort: number;
  debug: boolean;
}

export interface MatchTarget {
  /** Upstream provider id (e.g. "openai", "workbuddy", "antigravity-bridge"). */
  provider?: string;
  /** Resolved upstream model id (e.g. "gpt-6.2", "openai/gpt-6.2"). */
  model: string;
  /** Original requested model from client before routing (e.g. "group/coding"). */
  requestedModel?: string;
  /** Calling coding agent (e.g. "pi", "codex", "claude", "opencode"). */
  agent?: string;
  /** Whether request was classified as a lightweight utility request. */
  isUtility?: boolean;
}

export interface ResolvedRulePlan {
  matchedRules: PromptRule[];
  /** Rules grouped by injection position after mode:replace resolution. */
  byPosition: Record<InjectionPosition, PromptRule[]>;
  /** Conditional block signatures that matched and were already present inline. */
  inlineMatchedSignatures: string[];
  /** Number of unmatched inline conditional blocks stripped from body. */
  strippedInlineBlocks: number;
  /** Number of matched inline conditional blocks unwrapped in-place. */
  unwrappedInlineBlocks: number;
}

export interface CarrierRule {
  id: string;
  name: string;
  scope: RuleScope;
  depth: number;
  models: string[];
  agents: string[];
  mode: RuleMode;
  position: InjectionPosition;
  priority: number;
  includeUtility: boolean;
  content: string;
  blockSignature?: string;
}

export interface CarrierPayload {
  /** Version tag for forward compatibility. */
  v: 1;
  /** Request tracking id for log correlation. */
  reqId: string;
  /** Agent name from hooks ctx. */
  agent?: string;
  /** Requested model before routing. */
  requestedModel?: string;
  /** Whether hooks detected this as a utility request. */
  isUtility: boolean;
  /** Compact candidate rules gathered from global + project dirs. */
  rules: CarrierRule[];
}

export interface HitLogEntry {
  id: string;
  timestamp: string;
  agent: string;
  cwd: string;
  protocol: ProtocolName;
  requestedModel: string;
  resolvedModel: string;
  provider?: string;
  stage: "hooks" | "provider" | "response";
  status: "matched" | "no-match" | "skipped-utility" | "skipped-disabled" | "deferred";
  matchedRuleNames: string[];
  strippedBlocks: number;
  injectedBytes: number;
  note?: string;
}
