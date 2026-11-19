import { matchesAgentPatterns, matchesModelPatterns, normalizePatterns } from "./matcher.ts";
import type {
  InjectionPosition,
  MatchTarget,
  ParsedConditionalBlock,
  ParsedFrontmatter,
  RuleMode,
} from "./types.ts";

const VALID_MODES = new Set<RuleMode>(["append", "replace"]);
const VALID_POSITIONS = new Set<InjectionPosition>([
  "system-end",
  "system-start",
  "developer-reminder",
]);

/**
 * Lightweight deterministic FNV-1a 32-bit hash (hex), zero dependencies, moejs-safe.
 */
export function computeSignature(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stripInlineComment(raw: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === "#" && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(raw[i - 1])) {
        return raw.slice(0, i).trim();
      }
    }
  }
  return raw.trim();
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseListValue(raw: string): string[] {
  const cleaned = stripInlineComment(raw);
  if (!cleaned) return [];
  if (cleaned.startsWith("[") && cleaned.endsWith("]")) {
    const inner = cleaned.slice(1, -1).trim();
    if (!inner) return [];
    const items: string[] = [];
    let current = "";
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
        current += ch;
      } else if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
        current += ch;
      } else if (ch === "," && !inSingle && !inDouble) {
        const val = unquote(current);
        if (val) items.push(val);
        current = "";
      } else {
        current += ch;
      }
    }
    const last = unquote(current);
    if (last) items.push(last);
    return normalizePatterns(items);
  }
  return normalizePatterns(unquote(cleaned));
}

function parseBooleanValue(raw: string): boolean | undefined {
  const val = unquote(stripInlineComment(raw)).toLowerCase();
  if (val === "true" || val === "yes" || val === "1") return true;
  if (val === "false" || val === "no" || val === "0") return false;
  return undefined;
}

/**
 * Parse YAML-like frontmatter from a markdown file.
 * Returns parsed metadata and the remaining markdown body.
 */
export function parseFrontmatter(markdown: string): {
  meta: ParsedFrontmatter;
  body: string;
} {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n") && normalized !== "---") {
    return { meta: {}, body: normalized.trim() };
  }

  const endMarkerIdx = normalized.indexOf("\n---", 3);
  if (endMarkerIdx === -1) {
    return { meta: {}, body: normalized.trim() };
  }

  const afterMarker = endMarkerIdx + 4;
  if (
    afterMarker < normalized.length &&
    normalized[afterMarker] !== "\n" &&
    normalized[afterMarker] !== " " &&
    normalized[afterMarker] !== "\t"
  ) {
    return { meta: {}, body: normalized.trim() };
  }

  const headerText = normalized.slice(4, endMarkerIdx);
  const nextNewline = normalized.indexOf("\n", afterMarker);
  const body = (nextNewline === -1 ? "" : normalized.slice(nextNewline + 1)).trim();

  const meta: ParsedFrontmatter = {};
  const lines = headerText.split("\n");
  let activeListKey: "models" | "agents" | null = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (activeListKey && /^-\s+/.test(trimmed)) {
      const itemVal = unquote(stripInlineComment(trimmed.replace(/^-\s+/, "")));
      if (itemVal) {
        const list = (meta[activeListKey] ??= []);
        list.push(...normalizePatterns(itemVal));
      }
      continue;
    }

    activeListKey = null;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim().toLowerCase();
    const rawValue = trimmed.slice(colonIdx + 1).trim();

    if (key === "models" || key === "model" || key === "match") {
      if (!rawValue) {
        meta.models = meta.models ?? [];
        activeListKey = "models";
      } else {
        meta.models = [...(meta.models ?? []), ...parseListValue(rawValue)];
      }
    } else if (key === "agents" || key === "agent") {
      if (!rawValue) {
        meta.agents = meta.agents ?? [];
        activeListKey = "agents";
      } else {
        meta.agents = [...(meta.agents ?? []), ...parseListValue(rawValue)];
      }
    } else if (key === "mode") {
      const v = unquote(stripInlineComment(rawValue)).toLowerCase() as RuleMode;
      if (VALID_MODES.has(v)) meta.mode = v;
    } else if (key === "position") {
      const v = unquote(stripInlineComment(rawValue)).toLowerCase() as InjectionPosition;
      if (VALID_POSITIONS.has(v)) meta.position = v;
    } else if (key === "priority") {
      const num = Number(unquote(stripInlineComment(rawValue)));
      if (Number.isFinite(num)) meta.priority = num;
    } else if (key === "includeutility" || key === "include_utility") {
      const b = parseBooleanValue(rawValue);
      if (b !== undefined) meta.includeUtility = b;
    } else if (key === "enabled") {
      const b = parseBooleanValue(rawValue);
      if (b !== undefined) meta.enabled = b;
    }
  }

  return { meta, body };
}

/**
 * Parse directive header inside `<!-- @model: ... -->`.
 * Example:
 *   `gpt-6*, !gpt-6-mini agents=pi,codex mode=replace position=developer-reminder`
 */
function parseDirectiveHeader(rawHeader: string): {
  models: string[];
  agents: string[];
  mode: RuleMode;
  position: InjectionPosition;
  priority: number;
  includeUtility: boolean;
} {
  let agents: string[] = ["*"];
  let mode: RuleMode = "append";
  let position: InjectionPosition = "system-end";
  let priority = 0;
  let includeUtility = false;

  // Extract key=value attributes (which contain "=" and no leading spaces)
  const attrRegex = /\b(agents|agent|mode|position|priority|includeUtility|include_utility)=([^\s]+)/gi;
  const cleanedModelPart = rawHeader.replace(attrRegex, (_m, k: string, v: string) => {
    const key = k.toLowerCase();
    const val = unquote(v);
    if (key === "agents" || key === "agent") {
      const parsed = normalizePatterns(val);
      if (parsed.length > 0) agents = parsed;
    } else if (key === "mode") {
      const lower = val.toLowerCase() as RuleMode;
      if (VALID_MODES.has(lower)) mode = lower;
    } else if (key === "position") {
      const lower = val.toLowerCase() as InjectionPosition;
      if (VALID_POSITIONS.has(lower)) position = lower;
    } else if (key === "priority") {
      const num = Number(val);
      if (Number.isFinite(num)) priority = num;
    } else if (key === "includeutility" || key === "include_utility") {
      const b = parseBooleanValue(val);
      if (b !== undefined) includeUtility = b;
    }
    return "";
  });

  const models = normalizePatterns(cleanedModelPart);
  return { models, agents, mode, position, priority, includeUtility };
}

const OPEN_TAG_RE = /<!--\s*@model\s*:\s*([\s\S]*?)-->/gi;
const CLOSE_TAG_RE = /<!--\s*@end(?:model)?\s*-->/gi;

/**
 * Parse all well-formed `<!-- @model: ... --> ... <!-- @end -->` blocks in markdown text.
 * Unclosed or malformed tags are safely ignored (fail-open).
 */
export function parseConditionalBlocks(text: string): ParsedConditionalBlock[] {
  if (!text || !text.includes("@model")) return [];

  const blocks: ParsedConditionalBlock[] = [];
  OPEN_TAG_RE.lastIndex = 0;

  let openMatch: RegExpExecArray | null;
  while ((openMatch = OPEN_TAG_RE.exec(text)) !== null) {
    const openStart = openMatch.index;
    const openEnd = openMatch.index + openMatch[0].length;
    const rawHeader = (openMatch[1] || "").trim();

    CLOSE_TAG_RE.lastIndex = openEnd;
    const closeMatch = CLOSE_TAG_RE.exec(text);
    if (!closeMatch) {
      // Unclosed tag: fail-open, stop parsing further blocks from this point
      break;
    }

    // Ensure there isn't a nested unclosed @model before @end; if there is, skip the malformed outer tag
    const innerSlice = text.slice(openEnd, closeMatch.index);
    if (/<!--\s*@model\s*:/i.test(innerSlice)) {
      OPEN_TAG_RE.lastIndex = openEnd;
      continue;
    }

    const closeEnd = closeMatch.index + closeMatch[0].length;
    const parsed = parseDirectiveHeader(rawHeader);
    const trimmedContent = innerSlice.trim();

    if (parsed.models.length > 0) {
      blocks.push({
        rawMatch: rawHeader,
        models: parsed.models,
        agents: parsed.agents,
        mode: parsed.mode,
        position: parsed.position,
        priority: parsed.priority,
        includeUtility: parsed.includeUtility,
        content: trimmedContent,
        startIndex: openStart,
        endIndex: closeEnd,
        signature: computeSignature(`${rawHeader}\n${trimmedContent}`),
      });
    }

    OPEN_TAG_RE.lastIndex = closeEnd;
  }

  return blocks;
}

/**
 * Process inline `<!-- @model: ... --> ... <!-- @end -->` blocks inside a request text string:
 * - Unmatched blocks are stripped completely.
 * - Matched blocks have their wrapper comments removed (preserving body text) and their
 *   signatures returned so we never double-inject them.
 */
export function rewriteInlineConditionalBlocks(
  text: string,
  target: MatchTarget
): {
  text: string;
  changed: boolean;
  strippedCount: number;
  unwrappedCount: number;
  matchedSignatures: string[];
} {
  const blocks = parseConditionalBlocks(text);
  if (blocks.length === 0) {
    return {
      text,
      changed: false,
      strippedCount: 0,
      unwrappedCount: 0,
      matchedSignatures: [],
    };
  }

  let out = "";
  let cursor = 0;
  let strippedCount = 0;
  let unwrappedCount = 0;
  const matchedSignatures: string[] = [];

  for (const block of blocks) {
    out += text.slice(cursor, block.startIndex);

    const utilityBlocked = Boolean(target.isUtility && !block.includeUtility);
    const matched =
      !utilityBlocked &&
      matchesModelPatterns(block.models, target) &&
      matchesAgentPatterns(block.agents, target.agent);

    if (matched) {
      out += block.content;
      unwrappedCount += 1;
      matchedSignatures.push(block.signature);
    } else {
      strippedCount += 1;
    }

    cursor = block.endIndex;
  }

  out += text.slice(cursor);

  // Collapse 3+ consecutive newlines left by stripped blocks into 2 newlines
  if (strippedCount > 0) {
    out = out.replace(/\n{3,}/g, "\n\n").trim();
  }

  return {
    text: out,
    changed: strippedCount > 0 || unwrappedCount > 0,
    strippedCount,
    unwrappedCount,
    matchedSignatures,
  };
}
