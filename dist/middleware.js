// src/core/matcher.ts
function normalizePatterns(input) {
  if (!input)
    return [];
  const rawList = Array.isArray(input) ? input : [input];
  const result = [];
  for (const item of rawList) {
    if (typeof item !== "string")
      continue;
    for (const part of item.split(",")) {
      const trimmed = part.trim();
      if (trimmed.length > 0) {
        result.push(trimmed);
      }
    }
  }
  return result;
}
function globToRegExp(pattern) {
  let out = "^";
  for (let i = 0;i < pattern.length; i++) {
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
function buildModelCandidates(model, provider, requestedModel) {
  const fullSet = new Set;
  const bareSet = new Set;
  const addModel = (m, p) => {
    const cleanModel = (m || "").trim();
    const cleanProvider = (p || "").trim();
    if (!cleanModel)
      return;
    const slashIdx = cleanModel.indexOf("/");
    if (slashIdx >= 0) {
      fullSet.add(cleanModel);
      const after = cleanModel.slice(slashIdx + 1);
      if (after)
        bareSet.add(after);
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
    bare: Array.from(bareSet)
  };
}
function matchSingleModelPattern(pattern, candidates) {
  const regex = globToRegExp(pattern);
  if (pattern.includes("/")) {
    return candidates.full.some((c) => regex.test(c));
  }
  return candidates.bare.some((c) => regex.test(c)) || candidates.full.some((c) => regex.test(c));
}
function matchesModelPatterns(patterns, target) {
  const normalized = normalizePatterns(patterns);
  if (normalized.length === 0)
    return false;
  const positives = [];
  const negatives = [];
  for (const p of normalized) {
    if (p.startsWith("!")) {
      const inner = p.slice(1).trim();
      if (inner)
        negatives.push(inner);
    } else {
      positives.push(p);
    }
  }
  const candidates = buildModelCandidates(target.model, target.provider, target.requestedModel);
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
function matchesAgentPatterns(agents, agent) {
  const normalized = normalizePatterns(agents);
  if (normalized.length === 0)
    return true;
  const positives = [];
  const negatives = [];
  for (const p of normalized) {
    if (p.startsWith("!")) {
      const inner = p.slice(1).trim();
      if (inner)
        negatives.push(inner);
    } else {
      positives.push(p);
    }
  }
  const targetAgent = (agent || "").trim();
  if (targetAgent) {
    for (const neg of negatives) {
      if (globToRegExp(neg).test(targetAgent))
        return false;
    }
  }
  if (positives.length === 0)
    return true;
  if (positives.includes("*"))
    return true;
  if (!targetAgent)
    return false;
  return positives.some((pos) => globToRegExp(pos).test(targetAgent));
}

// src/core/parser.ts
var VALID_MODES = new Set(["append", "replace"]);
var VALID_POSITIONS = new Set([
  "system-end",
  "system-start",
  "developer-reminder"
]);
function computeSignature(input) {
  let hash = 2166136261;
  for (let i = 0;i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function stripInlineComment(raw) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0;i < raw.length; i++) {
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
function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') || trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
function parseBooleanValue(raw) {
  const val = unquote(stripInlineComment(raw)).toLowerCase();
  if (val === "true" || val === "yes" || val === "1")
    return true;
  if (val === "false" || val === "no" || val === "0")
    return false;
  return;
}
function parseDirectiveHeader(rawHeader) {
  let agents = ["*"];
  let mode = "append";
  let position = "system-end";
  let priority = 0;
  let includeUtility = false;
  const attrRegex = /\b(agents|agent|mode|position|priority|includeUtility|include_utility)=([^\s]+)/gi;
  const cleanedModelPart = rawHeader.replace(attrRegex, (_m, k, v) => {
    const key = k.toLowerCase();
    const val = unquote(v);
    if (key === "agents" || key === "agent") {
      const parsed = normalizePatterns(val);
      if (parsed.length > 0)
        agents = parsed;
    } else if (key === "mode") {
      const lower = val.toLowerCase();
      if (VALID_MODES.has(lower))
        mode = lower;
    } else if (key === "position") {
      const lower = val.toLowerCase();
      if (VALID_POSITIONS.has(lower))
        position = lower;
    } else if (key === "priority") {
      const num = Number(val);
      if (Number.isFinite(num))
        priority = num;
    } else if (key === "includeutility" || key === "include_utility") {
      const b = parseBooleanValue(val);
      if (b !== undefined)
        includeUtility = b;
    }
    return "";
  });
  const models = normalizePatterns(cleanedModelPart);
  return { models, agents, mode, position, priority, includeUtility };
}
var OPEN_TAG_RE = /<!--\s*@model\s*:\s*([\s\S]*?)-->/gi;
var CLOSE_TAG_RE = /<!--\s*@end(?:model)?\s*-->/gi;
function parseConditionalBlocks(text) {
  if (!text || !text.includes("@model"))
    return [];
  const blocks = [];
  OPEN_TAG_RE.lastIndex = 0;
  let openMatch;
  while ((openMatch = OPEN_TAG_RE.exec(text)) !== null) {
    const openStart = openMatch.index;
    const openEnd = openMatch.index + openMatch[0].length;
    const rawHeader = (openMatch[1] || "").trim();
    CLOSE_TAG_RE.lastIndex = openEnd;
    const closeMatch = CLOSE_TAG_RE.exec(text);
    if (!closeMatch) {
      break;
    }
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
        signature: computeSignature(`${rawHeader}
${trimmedContent}`)
      });
    }
    OPEN_TAG_RE.lastIndex = closeEnd;
  }
  return blocks;
}
function rewriteInlineConditionalBlocks(text, target) {
  const blocks = parseConditionalBlocks(text);
  if (blocks.length === 0) {
    return {
      text,
      changed: false,
      strippedCount: 0,
      unwrappedCount: 0,
      matchedSignatures: []
    };
  }
  let out = "";
  let cursor = 0;
  let strippedCount = 0;
  let unwrappedCount = 0;
  const matchedSignatures = [];
  for (const block of blocks) {
    out += text.slice(cursor, block.startIndex);
    const utilityBlocked = Boolean(target.isUtility && !block.includeUtility);
    const matched = !utilityBlocked && matchesModelPatterns(block.models, target) && matchesAgentPatterns(block.agents, target.agent);
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
  if (strippedCount > 0) {
    out = out.replace(/\n{3,}/g, `

`).trim();
  }
  return {
    text: out,
    changed: strippedCount > 0 || unwrappedCount > 0,
    strippedCount,
    unwrappedCount,
    matchedSignatures
  };
}

// src/core/resolver.ts
var SCOPE_ORDER = {
  "global-wildcard": 1,
  "global-exact": 2,
  "project-block": 3,
  "project-dir": 4,
  "project-sibling": 5
};
function sortRules(rules) {
  return [...rules].sort((a, b) => {
    const aGlobal = a.scope === "global-wildcard" || a.scope === "global-exact";
    const bGlobal = b.scope === "global-wildcard" || b.scope === "global-exact";
    if (aGlobal !== bGlobal)
      return aGlobal ? -1 : 1;
    if (!aGlobal && a.depth !== b.depth) {
      return a.depth - b.depth;
    }
    const scopeDiff = SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope];
    if (scopeDiff !== 0)
      return scopeDiff;
    if (a.priority !== b.priority)
      return a.priority - b.priority;
    return a.name.localeCompare(b.name);
  });
}
function resolveRules(candidates, target, inlineMatchedSignatures = [], strippedInlineBlocks = 0, unwrappedInlineBlocks = 0) {
  const inlineSigSet = new Set(inlineMatchedSignatures);
  const sorted = sortRules(candidates);
  let active = [];
  for (const candidate of sorted) {
    if ("enabled" in candidate && candidate.enabled === false)
      continue;
    if (!candidate.content || !candidate.content.trim())
      continue;
    if (target.isUtility && !candidate.includeUtility)
      continue;
    if (!matchesAgentPatterns(candidate.agents, target.agent))
      continue;
    if (!matchesModelPatterns(candidate.models, target))
      continue;
    if (candidate.mode === "replace") {
      active = [];
    }
    if (candidate.blockSignature && inlineSigSet.has(candidate.blockSignature)) {
      continue;
    }
    const normalized = {
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
      blockSignature: candidate.blockSignature
    };
    active.push(normalized);
  }
  const byPosition = {
    "system-end": [],
    "system-start": [],
    "developer-reminder": []
  };
  for (const rule of active) {
    byPosition[rule.position].push(rule);
  }
  return {
    matchedRules: active,
    byPosition,
    inlineMatchedSignatures: Array.from(inlineSigSet),
    strippedInlineBlocks,
    unwrappedInlineBlocks
  };
}
function formatInjectedBlock(rules, position, modelLabel) {
  if (rules.length === 0)
    return "";
  const sections = rules.map((r) => r.content.trim()).filter(Boolean);
  if (sections.length === 0)
    return "";
  const body = sections.join(`

`);
  if (position === "developer-reminder") {
    return `<model-instructions model="${modelLabel}">
${body}
</model-instructions>`;
  }
  return body;
}

// src/core/protocols.ts
function detectProtocol(body, hint) {
  if (body && typeof body === "object") {
    if (body.systemInstruction !== undefined || Array.isArray(body.contents)) {
      return "gemini";
    }
    if ((body.input !== undefined || body.instructions !== undefined) && !Array.isArray(body.messages)) {
      return "responses";
    }
    if (body.system !== undefined || body.anthropic_version !== undefined) {
      return "anthropic";
    }
    if (Array.isArray(body.messages)) {
      if (hint === "anthropic")
        return "anthropic";
      return "chat";
    }
  }
  if (hint === "anthropic" || hint === "chat" || hint === "responses" || hint === "gemini") {
    return hint;
  }
  return "unknown";
}
function shallowClone(obj) {
  return { ...obj };
}
function transformProtocolTexts(body, protocol, transform) {
  let mutated = false;
  let next = body;
  const ensureClone = () => {
    if (!mutated) {
      next = shallowClone(body);
      mutated = true;
    }
  };
  if (protocol === "anthropic") {
    if (typeof body.system === "string") {
      const res = transform(body.system);
      if (res.changed) {
        ensureClone();
        next.system = res.text;
      }
    } else if (Array.isArray(body.system)) {
      let arrChanged = false;
      const newSys = body.system.map((item) => {
        if (item && typeof item === "object" && typeof item.text === "string") {
          const res = transform(item.text);
          if (res.changed) {
            arrChanged = true;
            return { ...item, text: res.text };
          }
        }
        return item;
      });
      if (arrChanged) {
        ensureClone();
        next.system = newSys.filter((item) => !(item && typeof item === "object" && item.type === "text" && item.text === ""));
      }
    }
  }
  if (protocol === "responses" && typeof body.instructions === "string") {
    const res = transform(body.instructions);
    if (res.changed) {
      ensureClone();
      next.instructions = res.text;
    }
  }
  if (protocol === "responses" && Array.isArray(body.input)) {
    let arrChanged = false;
    const newInput = body.input.map((item) => {
      if (!item || typeof item !== "object")
        return item;
      const rec = item;
      if (typeof rec.content === "string") {
        const res = transform(rec.content);
        if (res.changed) {
          arrChanged = true;
          return { ...rec, content: res.text };
        }
      } else if (Array.isArray(rec.content)) {
        let partsChanged = false;
        const newParts = rec.content.map((part) => {
          if (part && typeof part === "object" && typeof part.text === "string") {
            const res = transform(part.text);
            if (res.changed) {
              partsChanged = true;
              return { ...part, text: res.text };
            }
          }
          return part;
        });
        if (partsChanged) {
          arrChanged = true;
          return { ...rec, content: newParts };
        }
      }
      return item;
    });
    if (arrChanged) {
      ensureClone();
      next.input = newInput;
    }
  }
  if (Array.isArray(body.messages)) {
    let msgChanged = false;
    const newMessages = body.messages.map((msg) => {
      if (!msg || typeof msg !== "object")
        return msg;
      const rec = msg;
      if (typeof rec.content === "string") {
        const res = transform(rec.content);
        if (res.changed) {
          msgChanged = true;
          return { ...rec, content: res.text };
        }
      } else if (Array.isArray(rec.content)) {
        let partsChanged = false;
        const newParts = rec.content.map((part) => {
          if (part && typeof part === "object" && typeof part.text === "string") {
            const res = transform(part.text);
            if (res.changed) {
              partsChanged = true;
              return { ...part, text: res.text };
            }
          }
          return part;
        });
        if (partsChanged) {
          msgChanged = true;
          return { ...rec, content: newParts };
        }
      }
      return msg;
    });
    if (msgChanged) {
      ensureClone();
      next.messages = newMessages;
    }
  }
  if (protocol === "gemini") {
    const sysInst = body.systemInstruction;
    if (sysInst && typeof sysInst === "object" && Array.isArray(sysInst.parts)) {
      let partsChanged = false;
      const newParts = sysInst.parts.map((part) => {
        if (part && typeof part === "object" && typeof part.text === "string") {
          const res = transform(part.text);
          if (res.changed) {
            partsChanged = true;
            return { ...part, text: res.text };
          }
        }
        return part;
      });
      if (partsChanged) {
        ensureClone();
        next.systemInstruction = { ...sysInst, parts: newParts };
      }
    }
    if (Array.isArray(body.contents)) {
      let contentsChanged = false;
      const newContents = body.contents.map((item) => {
        if (!item || typeof item !== "object")
          return item;
        const rec = item;
        if (!Array.isArray(rec.parts))
          return item;
        let partsChanged = false;
        const newParts = rec.parts.map((part) => {
          if (part && typeof part === "object" && typeof part.text === "string") {
            const res = transform(part.text);
            if (res.changed) {
              partsChanged = true;
              return { ...part, text: res.text };
            }
          }
          return part;
        });
        if (partsChanged) {
          contentsChanged = true;
          return { ...item, parts: newParts };
        }
        return item;
      });
      if (contentsChanged) {
        ensureClone();
        next.contents = newContents;
      }
    }
  }
  return { body: next, changed: mutated };
}
function filterInlineConditionalBlocks(body, protocol, target) {
  let strippedCount = 0;
  let unwrappedCount = 0;
  const sigSet = new Set;
  const result = transformProtocolTexts(body, protocol, (text) => {
    if (!text.includes("@model")) {
      return { text, changed: false };
    }
    const rewritten = rewriteInlineConditionalBlocks(text, target);
    if (rewritten.changed) {
      strippedCount += rewritten.strippedCount;
      unwrappedCount += rewritten.unwrappedCount;
      for (const sig of rewritten.matchedSignatures) {
        sigSet.add(sig);
      }
    }
    return { text: rewritten.text, changed: rewritten.changed };
  });
  return {
    body: result.body,
    changed: result.changed,
    strippedCount,
    unwrappedCount,
    matchedSignatures: Array.from(sigSet)
  };
}
function injectPromptText(body, protocol, position, text) {
  if (!text)
    return body;
  const next = shallowClone(body);
  if (protocol === "anthropic") {
    if (position === "developer-reminder" && Array.isArray(next.messages)) {
      const msgs = [...next.messages];
      for (let i = msgs.length - 1;i >= 0; i--) {
        const msg = msgs[i];
        if (msg && msg.role === "user") {
          if (typeof msg.content === "string") {
            msgs[i] = { ...msg, content: `${msg.content}

${text}` };
          } else if (Array.isArray(msg.content)) {
            msgs[i] = {
              ...msg,
              content: [...msg.content, { type: "text", text }]
            };
          }
          next.messages = msgs;
          return next;
        }
      }
    }
    if (Array.isArray(next.system)) {
      const block = { type: "text", text };
      next.system = position === "system-start" ? [block, ...next.system] : [...next.system, block];
    } else if (typeof next.system === "string" && next.system.length > 0) {
      next.system = position === "system-start" ? `${text}

${next.system}` : `${next.system}

${text}`;
    } else {
      next.system = [{ type: "text", text }];
    }
    return next;
  }
  if (protocol === "chat") {
    const msgs = Array.isArray(next.messages) ? [...next.messages] : [];
    const usesDeveloper = msgs.some((m) => m && typeof m === "object" && m.role === "developer");
    const sysRole = usesDeveloper ? "developer" : "system";
    if (position === "system-start") {
      msgs.unshift({ role: sysRole, content: text });
    } else if (position === "developer-reminder") {
      let lastUserIdx = -1;
      for (let i = msgs.length - 1;i >= 0; i--) {
        const m = msgs[i];
        if (m && m.role === "user") {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx >= 0) {
        msgs.splice(lastUserIdx, 0, { role: sysRole, content: text });
      } else {
        msgs.push({ role: sysRole, content: text });
      }
    } else {
      let insertIdx = 0;
      while (insertIdx < msgs.length) {
        const role = msgs[insertIdx]?.role;
        if (role === "system" || role === "developer") {
          insertIdx += 1;
        } else {
          break;
        }
      }
      msgs.splice(insertIdx, 0, { role: sysRole, content: text });
    }
    next.messages = msgs;
    return next;
  }
  if (protocol === "responses") {
    if (position === "developer-reminder") {
      if (Array.isArray(next.input)) {
        next.input = [...next.input, { role: "developer", content: text }];
        return next;
      }
    }
    if (typeof next.instructions === "string" && next.instructions.length > 0) {
      next.instructions = position === "system-start" ? `${text}

${next.instructions}` : `${next.instructions}

${text}`;
    } else {
      next.instructions = text;
    }
    return next;
  }
  if (protocol === "gemini") {
    if (position === "developer-reminder" && Array.isArray(next.contents)) {
      const contents = [...next.contents];
      for (let i = contents.length - 1;i >= 0; i--) {
        const item = contents[i];
        if (item && (item.role === "user" || item.role === undefined) && Array.isArray(item.parts)) {
          contents[i] = { ...item, parts: [...item.parts, { text }] };
          next.contents = contents;
          return next;
        }
      }
    }
    const existing = next.systemInstruction;
    const existingParts = existing && Array.isArray(existing.parts) ? [...existing.parts] : [];
    const newParts = position === "system-start" ? [{ text }, ...existingParts] : [...existingParts, { text }];
    next.systemInstruction = { ...existing || {}, parts: newParts };
    return next;
  }
  return body;
}
function applyResolvedPlan(body, protocol, plan, modelLabel) {
  let current = body;
  let injectedBytes = 0;
  const positions = [
    "system-start",
    "system-end",
    "developer-reminder"
  ];
  for (const pos of positions) {
    const rules = plan.byPosition[pos];
    if (!rules || rules.length === 0)
      continue;
    const text = formatInjectedBlock(rules, pos, modelLabel);
    if (!text)
      continue;
    current = injectPromptText(current, protocol, pos, text);
    injectedBytes += text.length;
  }
  return { body: current, injectedBytes };
}

// src/core/carrier.ts
var CARRIER_PREFIX = "<!--magpie-prompt-match-carrier:";
var CARRIER_RE = /<!--magpie-prompt-match-carrier:([A-Za-z0-9+/=_-]+)-->/g;
var B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64ToUtf8(b64) {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, "");
  const bytes = [];
  for (let i = 0;i < clean.length; i += 4) {
    const c0 = B64_CHARS.indexOf(clean[i]);
    const c1 = B64_CHARS.indexOf(clean[i + 1]);
    const c2 = clean[i + 2] === "=" ? -1 : B64_CHARS.indexOf(clean[i + 2]);
    const c3 = clean[i + 3] === "=" ? -1 : B64_CHARS.indexOf(clean[i + 3]);
    if (c0 < 0 || c1 < 0)
      break;
    bytes.push(c0 << 2 | c1 >> 4);
    if (c2 >= 0) {
      bytes.push((c1 & 15) << 4 | c2 >> 2);
      if (c3 >= 0) {
        bytes.push((c2 & 3) << 6 | c3);
      }
    }
  }
  let out = "";
  for (let i = 0;i < bytes.length; ) {
    const b0 = bytes[i++];
    if (b0 < 128) {
      out += String.fromCharCode(b0);
    } else if ((b0 & 224) === 192 && i < bytes.length) {
      const b1 = bytes[i++];
      out += String.fromCharCode((b0 & 31) << 6 | b1 & 63);
    } else if ((b0 & 240) === 224 && i + 1 < bytes.length) {
      const b1 = bytes[i++];
      const b2 = bytes[i++];
      out += String.fromCharCode((b0 & 15) << 12 | (b1 & 63) << 6 | b2 & 63);
    } else if ((b0 & 248) === 240 && i + 2 < bytes.length) {
      const b1 = bytes[i++];
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      const cp = ((b0 & 7) << 18 | (b1 & 63) << 12 | (b2 & 63) << 6 | b3 & 63) - 65536;
      out += String.fromCharCode(55296 + (cp >> 10), 56320 + (cp & 1023));
    }
  }
  return out;
}
function decodeCarrier(encoded) {
  try {
    const parsed = JSON.parse(base64ToUtf8(encoded));
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.rules)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
function extractAndStripCarrier(body, protocol) {
  let payload = null;
  let found = false;
  const transformed = transformProtocolTexts(body, protocol, (text) => {
    if (!text.includes(CARRIER_PREFIX)) {
      return { text, changed: false };
    }
    CARRIER_RE.lastIndex = 0;
    const cleaned = text.replace(CARRIER_RE, (_match, encoded) => {
      found = true;
      if (!payload) {
        payload = decodeCarrier(encoded);
      }
      return "";
    }).replace(/\n{3,}/g, `

`).trim();
    return { text: cleaned, changed: true };
  });
  if (!found) {
    return { body, payload: null, found: false };
  }
  let next = transformed.body;
  if (protocol === "chat" && Array.isArray(next.messages)) {
    next = {
      ...next,
      messages: next.messages.filter((m) => {
        if (!m || typeof m !== "object")
          return true;
        const rec = m;
        if ((rec.role === "system" || rec.role === "developer") && typeof rec.content === "string" && rec.content.trim() === "") {
          return false;
        }
        return true;
      })
    };
  } else if (protocol === "gemini") {
    const sysInst = next.systemInstruction;
    if (sysInst && Array.isArray(sysInst.parts)) {
      const nonEmpty = sysInst.parts.filter((p) => !(p && typeof p === "object" && typeof p.text === "string" && p.text.trim() === ""));
      if (nonEmpty.length === 0) {
        const clone = { ...next };
        delete clone.systemInstruction;
        next = clone;
      } else {
        next = { ...next, systemInstruction: { ...sysInst, parts: nonEmpty } };
      }
    }
  } else if (protocol === "responses" && typeof next.instructions === "string" && next.instructions.trim() === "") {
    const clone = { ...next };
    delete clone.instructions;
    next = clone;
  }
  return { body: next, payload, found };
}

// src/core/pipeline.ts
function applyProviderStage(body, protocolHint, providerId, providerModel, fallbackRequestedModel) {
  const protocol = detectProtocol(body, protocolHint);
  const extracted = extractAndStripCarrier(body, protocol);
  const targetModel = (providerModel || "").trim() || (extracted.payload?.requestedModel || "").trim() || (fallbackRequestedModel || "").trim() || (typeof body.model === "string" ? body.model.trim() : "");
  const target = {
    provider: providerId ? providerId.trim() : undefined,
    model: targetModel,
    requestedModel: extracted.payload?.requestedModel || fallbackRequestedModel,
    agent: extracted.payload?.agent,
    isUtility: extracted.payload?.isUtility ?? false
  };
  const candidateRules = extracted.payload?.rules ?? [];
  const inline = filterInlineConditionalBlocks(extracted.body, protocol, target);
  const plan = resolveRules(candidateRules, target, inline.matchedSignatures, inline.strippedCount, inline.unwrappedCount);
  const label = target.provider ? `${target.provider}/${target.model}` : target.model;
  const injected = applyResolvedPlan(inline.body, protocol, plan, label);
  return {
    body: injected.body,
    changed: extracted.found || inline.changed || injected.injectedBytes > 0,
    protocol,
    plan,
    injectedBytes: injected.injectedBytes,
    carrierFound: extracted.found,
    reqId: extracted.payload?.reqId
  };
}

// src/middleware-entry.ts
function onProvider(body, ctx) {
  if (!body || typeof body !== "object")
    return;
  try {
    const providerId = ctx?.provider?.id;
    const providerModel = ctx?.provider?.model;
    const result = applyProviderStage(body, ctx?.protocol, providerId, providerModel, ctx?.model);
    if (!result.changed)
      return;
    return result.body;
  } catch {
    return;
  }
}
export {
  onProvider
};
