# magpie-prompt-match

按最终命中的上游模型动态加载与裁剪 `AGENTS.md` 提示词的 [Magpie](https://usemagpie.ai) 插件，专为解决特定模型癖好（例如 GPT-6.2 过度防御性编程）而设计。

## 核心能力

- **双阶段架构（路由组 & Fallback 精准匹配）**：
  - `src/hooks.ts`（Bun `onRequest`）：利用 `ctx.cwd` 与 `mtime` 缓存发现全局及项目规则，自动跳过轻量辅助请求（标题/摘要/无工具短调用）。
  - `dist/middleware.js`（`moejs` `onProvider`）：在路由组解析与跨模型 Fallback 的**每一次上游尝试**时，按实际命中的 `ctx.provider.model` 精准裁决，绝不跨尝试污染。
- **智能协同 Agent 原生 `AGENTS.md`**：自动剥离请求体中不匹配当前模型的 `<!-- @model: ... -->` 条件块，匹配块原位保留并去重（绝不二次注入）。
- **KV Cache 友好**：默认追加在 System Prompt 末尾（`system-end`），完整保留 Anthropic `cache_control` 及 OpenAI / Gemini 前缀缓存；同时支持 Frontmatter 配置 `system-start` 与 `developer-reminder`。
- **内置 Magpie Web UI (`magpie.page`)**：在 Magpie 面板内提供**自动读取本机 Magpie 模型列表并按模型多选快速建规则**、规则编辑、一键生成 GPT-6.2 模板、匹配模拟器（Dry-Run）与实时命中日志。

## 快速安装

```bash
# 1. 构建 middleware 产物（修改 src/core 后执行）
bun run build

# 2. 安装到本地 Magpie（支持本地路径或 GitHub 仓库）
magpie plugin add /path/to/prompt_match
# 或直接通过 GitHub 安装：
magpie plugin add github:coders-lemon/magpie-prompt-match

# 3. 初始化 GPT-6.2 反过度防御性编程全局规则（也可在 Magpie 面板 Prompt Match 页面一键生成）
bun run ./bin/prompt-match.ts init-template gpt-6.2-anti-defensive
```

## 规则组织方式

1. **全局规则目录**（默认 `~/.config/magpie/prompts/*.md`）：对所有项目生效。
2. **项目级发现**（从 `ctx.cwd` 向上递归至 `.git` 根目录，由外到内叠加）：
   - `AGENTS.md`（及配置中指定的 `CLAUDE.md` 等）内的条件块：
     ```markdown
     <!-- @model: gpt-6*, !gpt-6-mini -->
     修改核心模块时禁止添加冗余的 null check 与防御性 try/catch。
     <!-- @end -->
     ```
   - `.agents/prompts/*.md`
   - 同级文件 `AGENTS.<model>.md`（如 `AGENTS.gpt-6.2.md`）

### Frontmatter 选项

```markdown
---
models:
  - "gpt-6.2"
  - "openai/gpt-6.2*"
  - "!gpt-6.2-mini"
agents: ["*"]                # 可选，如 ["pi", "codex"]
mode: append                 # append（默认叠加）| replace（覆盖上游全局规则）
position: system-end         # system-end（默认）| system-start | developer-reminder
priority: 0
includeUtility: false
enabled: true
---
你的模型专属提示词...
```

## CLI 调试命令

```bash
# 预览指定模型与目录最终命中的规则与注入文本
bun run ./bin/prompt-match.ts test --model gpt-6.2 --provider openai --cwd /path/to/repo --agent pi

# 列出所有发现的全局与项目规则
bun run ./bin/prompt-match.ts list --cwd /path/to/repo

# 查看本机 Magpie 已配置的全部模型及当前规则覆盖情况
bun run ./bin/prompt-match.ts models

# 独立启动 Web UI 调试
bun run ./bin/prompt-match.ts serve --port 47831
```

详细架构见 [ARCHITECTURE.md](./ARCHITECTURE.md)。
