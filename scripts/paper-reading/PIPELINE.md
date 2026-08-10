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
  state/decision-ledger.json    # receipt-backed exact-version decisions
  state/discovery-state.json
```

`papers/` 以 paper 为中心保存长期内容，`digests/` 只定义某一天如何展示；同一篇论文不会因
再次出现而生成第二个 canonical ID。`runs/` receipt 固定当次输入、review、digest 和
canonical 文件在当时的 hashes，但不取代完整本地证据。`decision-ledger.json`
只合并已有 verified receipt 支持的 immutable decision delta，用于避免在 overlap window
中重复审阅完全相同的论文证据。

### 本地、忽略 Git、但需要保留的 run archive

```text
local-assets/paper-reading/runs/<run-id>/
  candidates.json
  manifest.json
  screening/
    screening-manifest.json
    decision-ledger-input.json  # immutable routing snapshot for this run
    batches/*.input.json
    reviews/*.review.json
  decision-ledger/
    delta.json                  # immutable decisions pinned by the run receipt
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
   ID、OpenReview forum ID、title+first-author+year 去重。Discovery 仍完整写出本轮所有
   candidates，不在 provider 检索层用 decision ledger 删掉 overlap 结果。
4. retrieval topic 只表示“哪条 query 找到了它”，不能直接当作最终相关性。
5. arXiv 的单个分页请求对 HTTP 429、5xx 和明确的瞬时网络错误最多尝试 3 次；所有 attempt
   仍经过同一个全局串行限速器，起始时间至少间隔 3100 ms。manifest 必须记录 attempt、retry
   和最终错误，普通 4xx 不重试。
6. 任一已启用 live source 在重试耗尽后为 `partial` 或 `failed` 时停止，不推进 watermark。
7. Discovery 文件一经写出不可覆盖；确需重新抓取时使用新的 run ID，并保留失败 run 的
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

Prepare 会先读取 `state/decision-ledger.json`，但只在以下三项同时完全匹配时复用决定：

1. exact arXiv version，例如 `arxiv:2608.05131@v2`；
2. candidate evidence fingerprint，由 title、authors、abstract、categories、source records、links、
   venue metadata 等审阅证据投影生成；
3. active policy fingerprint，固定 research config、venue registry、selected topics、screening
   contract 和 full-text schema。只有 research config 和 venue registry 都是 `active` 才允许复用。

本轮所有 match 与 miss 都写入 immutable
`screening/decision-ledger-input.json`，并由 screening manifest 记录 hash。只有 miss 进入
`batches/*.input.json`；因此“discovery 全量”与“screening 只处理 ledger miss”并不矛盾。
新 arXiv version、任一 evidence 变化或 policy 变化都会重新进入 screening；
`administrative-backlog`、`manual-review`、`defer` 和 abstract 后尚未 promotion 的 accept 均是
non-terminal，不会被自动跳过。

复用还要求 ledger import 指向的本地 immutable delta 与 verified receipt 均存在且 hash
一致；本地审计证据缺失时 fail-safe 为重新 screening。若要人工重审整个新 run，在 prepare
命令中显式加入 `--ignore-decision-ledger`；该 override 会写入 snapshot/manifest，`--force`
本身不会绕过 ledger。

解析时先读取该 exact-version / evidence / policy context 的完整历史，再验证最终 terminal
observation 的 provenance。后出现的 non-terminal 决定会阻止旧 terminal 被复用；最终
terminal 的证明失效时也直接回到 screening，不能 fallback 到更旧的 terminal。

Codex 对每个实际生成的 batch 写一个 review。每个未被 ledger 复用的 candidate
必须恰好有一个决定：`reject`、`full-text-review`、`accept-from-abstract` 或
`manual-review`。topic、relevance 和 reading action 根据论文实际贡献决定，不能
照抄 retrieval topic；venue 是信号，不是自动录取条件。

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
7. `possible-update` 必须和已归档精确版本比较 scientific delta。若变化仅为 arXiv
   version stamp、日期、排版或不影响结论的 metadata，则全文决定记为 `reject`：这表示
   “本次版本事件无可发布更新”，不是否定原论文。该 exact version 仍进入 decision ledger，
   但不得更新 canonical Paper link，也不得重复进入当日 digest。

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

若 screening 没有产生任何 `full-text-review`，或 `all-full-text` 已经全部审完，则 full-text
与 backlog 都可合法地以 0 项闭环，不需要伪造空 `backlog.json`。对应 receipt 只记录
`backlog.candidateIds: []`；非空 backlog 仍必须同时记录文件路径和 SHA-256。pipeline
controller 会从已验证 screening 自动确认 0 项；若单独运行 full-text、summary 或 promotion
validator，则显式传入 `--expected-count 0`，并仍先完成 screening validation。

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
6. existing paper 只有在 method、experiment、conclusion、code/venue 等发生可描述的实质变化时
   才能再次出现在 digest；纯版本号、时间戳或排版更新不能作为日报事件。

```sh
npm run validate:paper-promotion -- \
  --run-dir local-assets/paper-reading/runs/<run-id> \
  --digest content/paper-reading/digests/YYYY-MM-DD.json
```

validator 要求 digest 与该 run 的 accepted reviews 精确对应，并检查 review version、Code
status、canonical analysis 和 source boundary。

### 6. Verification、receipt、decision ledger 与 watermark

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

全部通过后生成 compact receipt。receipt 是 Git 中可长期保存的审计索引，不包含 PDF 本体。
`receipt --apply` 同时生成一次性的 `<run>/decision-ledger/delta.json`，并把该 delta
的路径与 SHA-256 固定在 receipt 中。它一经写入不允许原地改写；日后 aggregate
ledger 的变化不会改变这个 run 当时的 decision delta。

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

只有 receipt 再次验证完整后才能合并 decision ledger。先查看 dry-run，再 apply：

```sh
npm run pipeline:papers -- ledger \
  --run-dir local-assets/paper-reading/runs/<run-id> \
  --selection all-full-text \
  --digest content/paper-reading/digests/YYYY-MM-DD.json

npm run pipeline:papers -- ledger \
  --run-dir local-assets/paper-reading/runs/<run-id> \
  --selection all-full-text \
  --digest content/paper-reading/digests/YYYY-MM-DD.json \
  --apply
```

这一合并是 idempotent 的：同一 run 只能 import 一次，且 import 必须持续匹配
verified receipt 和 immutable delta 的 hashes。Aggregate ledger 只保存证据观测与来源，
不代替 canonical paper、review 或 receipt。

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

`finalize` 不盲信 ledger 已由前一条命令完成；它内部会先重新验证 receipt/delta
并幂等合并 ledger，只有 ledger import 成功后才写 discovery watermark。因此也可在
receipt 后直接运行 `finalize`，但标准人工验收流程保留独立 `ledger` dry-run/apply，
便于先检查决定统计。

`finalize` 不发布网站；它只表示本 run 的检索、编辑和 canonical content 已闭环。若之后
commit/push 失败，下次必须恢复该 run 并重试发布，不能重新 discovery。

#### 一次性历史回填

2026-08-06 和 2026-08-07 已有 verified legacy receipts，不重做 discovery、screening 或全文
阅读。按时间顺序对两个 run 分别执行 ledger dry-run 和 apply：

```sh
# 2026-08-06: high-deep，含当时的显式 backlog
npm run pipeline:papers -- ledger \
  --run-dir local-assets/paper-reading/runs/live-dry-run-20260806-v2 \
  --selection high-deep \
  --digest content/paper-reading/digests/2026-08-06.json
npm run pipeline:papers -- ledger \
  --run-dir local-assets/paper-reading/runs/live-dry-run-20260806-v2 \
  --selection high-deep \
  --digest content/paper-reading/digests/2026-08-06.json \
  --apply

# 2026-08-07: all-full-text
npm run pipeline:papers -- ledger \
  --run-dir local-assets/paper-reading/runs/paper-reading-20260807-094202 \
  --selection all-full-text \
  --digest content/paper-reading/digests/2026-08-07.json
npm run pipeline:papers -- ledger \
  --run-dir local-assets/paper-reading/runs/paper-reading-20260807-094202 \
  --selection all-full-text \
  --digest content/paper-reading/digests/2026-08-07.json \
  --apply
```

旧 receipt 未固定 delta 是历史兼容边界；回填会从 receipt 已固定且通过验证的
run artifacts 生成 immutable delta，然后记录 receipt/delta 的 hashes。新 run 必须由
`receipt --apply` 先固定 delta，不使用这个兼容路径。两次回填均为 idempotent，
不需要对 8 月 6 日重新 finalize，也不应把 watermark 向后移动。

当前试运行版本把 aggregate ledger 保存为单个 Git-tracked JSON，并在内存中查找匹配
observation。它足以验证复用语义，但文件会随每日观测线性增长；按月分片、压缩及索引
属于稳定运行后的扩展项，不应通过放宽 exact-version / evidence / policy 匹配来换取性能。

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
| Receipt/delta 失配 | immutable run archive、已有 receipt/delta | 查找被改动的 artifact，恢复同一 run 证据 | 覆盖 delta 或绕过 hash |
| Ledger import 失败 | verified receipt、immutable delta、当前 ledger | 修复冲突后重试幂等 import | 推进 watermark |
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
> 必须在 ledger snapshot 中被精确复用，或有本轮 screening 决定；每个 full-text-review
> 必须有有效全文 review 或显式 backlog。只有 exact version、evidence fingerprint 和
> active policy 全部匹配才能跳过；backlog、manual-review 和 defer 不自动跳过。
> 所有结论遵守 evidence boundary，method flow 与 generated concept image 分开。promotion
> 后依次运行 pipeline verify、lint、tsc、三组测试、build 和 diff check；通过后写入
> receipt 及其 immutable decision delta，验证后合并 ledger，再 finalize watermark。没有明确
> 发布授权时停在这里，不 commit、不 push。清理只使用
> pipeline cleanup，保留 PDF、reviews、manifests 与 backlog。

这一段定义 terminal condition：没有通过验证、没有显式 closure 或发布步骤尚未完成时，
任务都不能把 run 当作成功后重新开始下一天。
