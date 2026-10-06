const repository = "https://github.com/zzzhy03/academic-workflow";

export const academicWorkflow = {
  slug: "academic-workflow",
  name: "Academic Workflow",
  summary: {
    en: "Reusable AI agent skills for academic writing and figure design, refined through everyday research practice.",
    zh: "将论文写作与学术图稿制作中的实践经验整理为可复用的 AI agent skills。",
  },
  description: {
    en: "AI agent skills for writing papers, checking results, and designing editable research figures, built from everyday research practice.",
    zh: "从科研实践中提炼的 AI agent skills，支持论文写作、结果核对与可编辑学术图稿设计。",
  },
  tags: [
    { en: "Paper writing", zh: "论文写作" },
    { en: "Figure design", zh: "图稿设计" },
    { en: "Agent skills", zh: "Agent skills" },
  ],
  repository,
  documentation: {
    en: `${repository}#readme`,
    zh: `${repository}/blob/main/README.zh-CN.md`,
  },
  releases: `${repository}/releases/latest`,
  license: `${repository}/blob/main/LICENSE`,
  skills: [
    {
      slug: "academic-paper-writing",
      title: { en: "Academic Paper Writing", zh: "学术论文写作" },
      description: {
        en: "Scholarly wording, result tables, consistency checks, and final PDF review.",
        zh: "论文措辞、结果表格核对、一致性检查与最终 PDF 审阅。",
      },
      href: `${repository}/blob/main/skills/academic-paper-writing/SKILL.md`,
    },
    {
      slug: "academic-diagram-design",
      title: { en: "Academic Diagram Design", zh: "学术示意图设计" },
      description: {
        en: "Editable method overviews and schematics, compact layouts, and publication exports.",
        zh: "可编辑的方法概览与示意图、紧凑排版和论文图稿导出。",
      },
      href: `${repository}/blob/main/skills/academic-diagram-design/SKILL.md`,
    },
  ],
} as const;

export const tools = [academicWorkflow] as const;
