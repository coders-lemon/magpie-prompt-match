export interface PromptTemplate {
  id: string;
  fileName: string;
  title: string;
  description: string;
  content: string;
}

export const BUILTIN_TEMPLATES: PromptTemplate[] = [
  {
    id: "gpt-6.2-anti-defensive",
    fileName: "gpt-6.2.md",
    title: "GPT-6.2 反过度防御性编程",
    description: "抑制 GPT-6.2 在内部逻辑中堆砌冗余判空、无意义 try/catch 和过度抽象兜底的倾向",
    content: `---
models:
  - "gpt-6.2"
  - "gpt-6.2-*"
agents: ["*"]
mode: append
position: system-end
priority: 0
enabled: true
---
## 代码编写风格要求（克制防御性编程）

- **只在真正的系统边界做校验**：外部用户输入、网络请求、文件/数据库 IO、反序列化边界必须校验；对于内部模块间已由类型系统或调用方契约保证的不变量，不要重复写防御性判空、\`typeof\` 检查或不可能触发的兜底分支。
- **禁止吞异常与静默降级**：不要用宽泛的 \`try / catch\` 包裹核心逻辑后默默返回空值或默认值；遇到真正的非法状态应当直接抛出清晰错误，而不是掩盖问题。
- **保持改动直接与最小化**：严格围绕当前任务修改代码，不要顺手引入多余的兼容层、无用配置开关、过度封装的 helper 或假想未来需求的抽象。
- **相信现有工具链与类型定义**：直接依赖项目已有的 TypeScript / 静态类型与单测保障，避免用冗长的运行时防御代码替代清晰的设计。
`,
  },
  {
    id: "claude-direct-edit",
    fileName: "claude-concise.md",
    title: "Claude 精简输出与直接改动",
    description: "减少冗长铺垫，优先直接阅读并修改目标代码",
    content: `---
models:
  - "claude-*"
agents: ["*"]
mode: append
position: system-end
priority: 0
enabled: true
---
## 协作风格偏好

- 结论先行，避免在动手修改前输出过长的重复性计划或客套说明。
- 修改完成后仅汇报核心改动点与验证结果，保持简洁准确。
`,
  },
  {
    id: "deepseek-verify-first",
    fileName: "deepseek-verify.md",
    title: "DeepSeek 严格实证优先",
    description: "要求修改前先确认真实文件与接口签名，禁止猜测 API",
    content: `---
models:
  - "deepseek*"
agents: ["*"]
mode: append
position: system-end
priority: 0
enabled: true
---
## 工程约束

- 修改任何代码前，先读取目标文件确认真实函数签名与导入路径，禁止凭记忆臆造 API 或配置项。
- 完成修改后必须运行项目对应的类型检查或单元测试确认通过。
`,
  },
];

export function findTemplateById(id: string): PromptTemplate | undefined {
  return BUILTIN_TEMPLATES.find((t) => t.id === id);
}
