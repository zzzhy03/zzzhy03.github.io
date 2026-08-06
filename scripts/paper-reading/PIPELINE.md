# Paper Reading 标准运行流程

这份文档是日报任务的操作规范。目标不是把所有步骤塞进一个黑盒脚本，而是让 Codex
负责需要判断的检索、阅读和写作，同时让目录、状态、校验、恢复和清理都可重复、可审计。

## 1. 三类数据

### Git 中的长期 source of truth

```text
content/paper-reading/
  research-config.json
  venue-registry.json
  topics.json
  papers/*.json
  digests/YYYY-MM-DD.json
  runs/YYYY-MM-DD.json          # compact audit receipt
  state/discovery-state.json
```

`papers/` 以 paper 为中心保存长期内容，`digests/` 只定义某一天如何展示；同一篇论文不会因
再次出现而生成第二个 canonical ID。`runs/` receipt 固定当次输入、review、digest 和
canonical 文件在当时的 hashes，但不取代完整本地证据。

### 本地、忽略 Git、但需要保留的 run archive

```text
local-assets/paper-reading/runs/<run-id>/
  candidates.json
  manifest.json
  screening/
    screening-manifest.json
    batches/*.input.json
    reviews/*.review.json
  fulltext/
    sources/*.pdf               # exact version, immutable audit source
    reviews/*.json              # one structured review per reviewed paper
    backlog.json                # explicitly deferred; never an implicit reject
    summary.json                # rebuildable convenience summary
    work/                       # disposable extraction/rendering workspace
      text/
      rendered/
```

一个 run 的 discovery、screening、PDF、review 和 backlog 必须待在同一个目录。不要再把
PDF 放入 repository `tmp/`，也不要使用跨日期共享的 `fulltext-reviews/`。

### 可机械重建的产物

- `public/paper-reading/data/`：由 `npm run prepare:papers` 生成。
- `.next/`、`out/`：由 Next.js 构建生成。
- `<run>/fulltext/work/`：由保留的 PDF 重新提取或渲染。

这些不是内容来源。构建正在运行时不要删除 `.next/`；`pipeline cleanup` 只会接触明确的
`fulltext/work/`，不会删除 PDF、review、manifest、digest 或 canonical paper。

## 2. 每日阶段

### 0. Preflight 与 resume

1. 检查现有工作区，保留用户无关改动，不执行 reset/checkout。
2. 检查最近的本地 run。若已有未完成 run，先对它运行 `status` 并从 `next` 指向的阶段
   继续；不要为了方便重新抓一次论文。
3. 同一台机器上同一时间只运行一个日报任务。当前工具尚未提供跨进程 lock，因此 Codex
   App 中不要配置重叠的定时任务。
4. 若上次只在 commit/push/build 阶段失败，复用同一份 content 和 run，不重新 discovery、
   screening 或全文阅读。

```sh
npm run pipeline:papers -- status \
  --run-dir local-assets/paper-reading/runs/<run-id> \
  --selection all-full-text \
  --digest content/paper-reading/digests/YYYY-MM-DD.json
```

还没有 digest 时省略 `--digest`。`--json` 可供 Codex 稳定读取状态。

### 1. Discovery

1. 日期按 `Asia/Shanghai` 决定日报日；检索窗口使用带时区的精确 ISO timestamp。
2. 正常窗口从 `lastSuccessfulRunAt - overlapHours` 开始；首次运行显式传 `--since`。
3. 论文在 `publishedAt` 或 `updatedAt` 落入窗口时均保留；随后用 DOI、versionless arXiv
   ID、OpenReview forum ID、title+first-author+year 去重。
4. retrieval topic 只表示“哪条 query 找到了它”，不能直接当作最终相关性。
5. 任一已启用 live source 为 `partial` 或 `failed` 时停止，不推进 watermark。
6. Discovery 文件一经写出不可覆盖；确需重新抓取时使用新的 run ID，并保留失败 run 的
   manifest 解释原因。

```sh
npm run discover:papers -- \
  --since <ISO timestamp> \
  --run-id paper-reading-YYYYMMDD-HHMMSS
```

标准定时任务在这里不传 `--record-success`。watermark 只在后面的 `finalize` 阶段推进。

### 2. Abstract screening

```sh
npm run prepare:paper-screening -- \
  --run-dir local-assets/paper-reading/runs/<run-id> \
  --batch-size 12
```

Codex 对每个 batch 写一个 review。每个 candidate 必须恰好有一个决定：`reject`、
`full-text-review`、`accept-from-abstract` 或 `manual-review`。topic、relevance 和 reading
action 根据论文实际贡献决定，不能照抄 retrieval topic；venue 是信号，不是自动录取条件。

```sh
npm run validate:paper-screening -- \
  --run-dir local-assets/paper-reading/runs/<run-id>
```

恢复时只补缺失或无效的 batch review；prepared input hash 正确的 batch 不重做。

### 3. Full-text acquisition 与 review

默认处理所有 `full-text-review` candidate：

1. 下载 screening 对应的精确论文版本到 `fulltext/sources/`。
2. 记录 SHA-256 和页数。
3. `pdftotext -layout` 输出放入 `fulltext/work/text/`。
4. 需要视觉检查的页面渲染到 `fulltext/work/rendered/`。
5. review 必须记录 `runId`、`candidateId`、versioned arXiv ID、evidence locator、实验、限制、
   code status、相关性与阅读方式。
6. 数字结论默认表述为作者报告，除非我们实际复现过。

```sh
npm run validate:paper-fulltext -- \
  --run-dir local-assets/paper-reading/runs/<run-id> \
  --selection all-full-text
```

`all-full-text` 是日常默认值，没有固定数量配额。若一次启动/回补明确只处理 `high-deep`，
剩余条目必须成为显式 backlog：

```sh
npm run pipeline:papers -- backlog \
  --run-dir local-assets/paper-reading/runs/<run-id> \
  --selection high-deep

# 确认 dry-run 列表后：
npm run pipeline:papers -- backlog \
  --run-dir local-assets/paper-reading/runs/<run-id> \
  --selection high-deep \
  --apply
```

Backlog 表示“本轮未完成全文判断，未来继续”，不是 reject、已读或相关性低。以后可以由
专门的 seed paper / follow-up 机制消费，但当前不会自动改变 canonical content。

### 4. Editorial compression 与视觉内容

每个 accepted paper 最终至少需要：

- 信息密度高、带描述语句的 30 秒结论；
- problem、method、experiment、novelty、evidence boundary 和 caveat；
- relevance 与 reading action 的推荐初值；
- 原文 abstract 和准确 Paper/Code links；
- 结构化 method flow。

Method flow 和 AI concept image 是两类内容：flow 用结构化步骤表达方法；concept image 只在
确实能帮助理解时生成，并明确标为 generated visual，不能冒充论文原图或实验依据。技术名词
优先保留自然的英文写法。

### 5. Promotion

目前 promotion 的内容写入仍由 Codex 完成，而不是一个自动 generator：

1. accepted review 写入或更新 `content/paper-reading/papers/*.json`；
2. 当日 `digests/YYYY-MM-DD.json` 只引用 canonical paper IDs；
3. 每个研究方向都有自己的 brief；没有新论文也要诚实说明；
4. 新 paper 的 `collectedAt` 等于首次 digest 日期；已有 paper 更新时保留原 `collectedAt`；
5. source coverage 必须如实显示尚未配置或失败的来源。

```sh
npm run validate:paper-promotion -- \
  --run-dir local-assets/paper-reading/runs/<run-id> \
  --digest content/paper-reading/digests/YYYY-MM-DD.json
```

validator 要求 digest 与该 run 的 accepted reviews 精确对应，并检查 review version、Code
status、canonical analysis 和 source boundary。

### 6. Verification、receipt 与 watermark

先执行 editorial/canonical gates：

```sh
npm run pipeline:papers -- verify \
  --run-dir local-assets/paper-reading/runs/<run-id> \
  --selection all-full-text \
  --digest content/paper-reading/digests/YYYY-MM-DD.json
```

再执行 repository 质量门槛：

```sh
npm run lint
npx tsc --noEmit
npm run test:paper-discovery
npm run test:paper-screening
npm run test:paper-pipeline
npm run build
git diff --check
```

全部通过后生成 compact receipt。receipt 是 Git 中可长期保存的审计索引，不包含 PDF 本体：

```sh
npm run pipeline:papers -- receipt \
  --run-dir local-assets/paper-reading/runs/<run-id> \
  --selection all-full-text \
  --digest content/paper-reading/digests/YYYY-MM-DD.json

# 检查 dry-run 后：
npm run pipeline:papers -- receipt \
  --run-dir local-assets/paper-reading/runs/<run-id> \
  --selection all-full-text \
  --digest content/paper-reading/digests/YYYY-MM-DD.json \
  --apply
```

最后才允许从 immutable discovery manifest 推进 watermark：

```sh
npm run pipeline:papers -- finalize \
  --run-dir local-assets/paper-reading/runs/<run-id> \
  --selection all-full-text \
  --digest content/paper-reading/digests/YYYY-MM-DD.json

# 检查 before/after 后：
npm run pipeline:papers -- finalize \
  --run-dir local-assets/paper-reading/runs/<run-id> \
  --selection all-full-text \
  --digest content/paper-reading/digests/YYYY-MM-DD.json \
  --apply
```

`finalize` 不发布网站；它只表示本 run 的检索、编辑和 canonical content 已闭环。若之后
commit/push 失败，下次必须恢复该 run 并重试发布，不能重新 discovery。

### 7. Commit、push 与 Pages

发布是独立授权步骤。只有用户或定时任务明确授权时才能：

1. 检查 allowlist diff，只提交本轮 content、receipt、state、必要视觉资产和相关代码；
2. commit；
3. push；
4. 确认 GitHub Pages workflow 成功，并检查线上 `/paper_reading/daily/` 与 library。

构建成功不等于已发布，push 成功也不等于 Pages workflow 已完成。失败时保留 run archive，
只重试失败的发布阶段。

### 8. Cleanup

正常运行中的抽取文本和渲染页统一放在 `<run>/fulltext/work/`。先看计划，再应用：

```sh
npm run pipeline:papers -- cleanup \
  --run-dir local-assets/paper-reading/runs/<run-id> \
  --selection all-full-text \
  --digest content/paper-reading/digests/YYYY-MM-DD.json

npm run pipeline:papers -- cleanup \
  --run-dir local-assets/paper-reading/runs/<run-id> \
  --selection all-full-text \
  --digest content/paper-reading/digests/YYYY-MM-DD.json \
  --apply
```

Cleanup 在删除前重新校验 screening、full-text、backlog，以及传入 digest 时的 promotion；
目标若在计划后发生变化、包含 symlink 或逃出固定目录，就拒绝删除。第一版不会自动淘汰
source PDFs 和 reviews；在确定长期对象存储或 retention policy 前保留它们。

## 3. 失败与恢复矩阵

| 失败位置 | 保留什么 | 下次做什么 | 绝对不要做什么 |
| --- | --- | --- | --- |
| Discovery partial/failed | manifest、已有 candidates | 新 run ID 重试失败的完整窗口 | 推进 watermark |
| Screening 缺 batch | immutable inputs、已有 reviews | 只补缺失/无效 review | 重建全部 batch |
| PDF/version/hash 错 | screening decision、错误源记录 | 重取精确版本并复核 | 用别的版本冒充 |
| Full-text review 无效 | PDF、其它有效 reviews | 只修该 paper review | 静默降成 reject |
| Backlog 不闭合 | 17/其它已完成 reviews | 补齐精确 candidate IDs | 隐藏未读 candidate |
| Promotion validator 失败 | run archive、未发布 content | 修 canonical/digest | 写 receipt/finalize |
| Lint/test/build 失败 | 所有编辑证据 | 修代码或数据再全量验证 | commit/push |
| Commit/push/Pages 失败 | 同一 run、同一 commit 内容 | 只重试发布阶段 | 重新检索和总结 |

## 4. 当前尚未自动化的边界

- OpenReview、official proceedings 和 official technical reports adapters 尚未配置；页面和
  digest 必须持续诚实显示覆盖范围。
- AI screening、全文阅读、摘要写作、concept image 和 promotion 内容生成仍由 Codex 执行；
  validators 负责约束输入输出，而不是替代研究判断。
- Zotero 归档、收藏/稍后读的云同步、seed paper/follow-up tracking 仍是后续模块。
- 当前没有跨进程 lock；在加入 lock/queue 前，只允许一个不重叠的 Codex App 日报任务。

## 5. Codex App 定时任务核心指令

定时任务应包含下面的不可省略约束：

> 先检查并恢复未完成的 Paper Reading run；只有没有可恢复 run 时才创建新 discovery。
> 使用 Asia/Shanghai 日期与 state overlap window，不伪造停机日期的日报。每个 candidate
> 必须有 screening 终态；每个 full-text-review 必须有有效全文 review 或显式 backlog。
> 所有结论遵守 evidence boundary，method flow 与 generated concept image 分开。promotion
> 后依次运行 pipeline verify、lint、tsc、三组测试、build 和 diff check；通过后写 receipt，
> 再 finalize watermark。没有明确发布授权时停在这里，不 commit、不 push。清理只使用
> pipeline cleanup，保留 PDF、reviews、manifests 与 backlog。

这一段定义 terminal condition：没有通过验证、没有显式 closure 或发布步骤尚未完成时，
任务都不能把 run 当作成功后重新开始下一天。
