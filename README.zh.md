---
description: "在 dsh profile 中提供安全审计技能：指导式审查、覆盖驱动审计、结构化发现和报告校验器。"
kind: "package-bundle"
---

# @lornatang/dsh-security-audit

[English](README.md) | 中文

## 概要

`dsh-security-audit` 在 dsh profile 中注册一个安全审计技能。技能既能指导针对具体问题的安全审查，也能在明确请求时执行六阶段代码库审计，产出覆盖账本、经独立检查的发现和报告。用 `add` 命令添加并重启 profile 后，可以调用 `/security-audit` 或直接请求安全审查。边界是：软件包提供说明和校验器；智能体、任务委派、工具以及执行目标代码所需的沙箱由宿主提供。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发者注记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

这一层提供一个技能及其文件。当前智能体决定如何遵循技能说明，profile 控制工具权限和可用子代理，宿主提供执行环境。请将它安装到需要使用该技能的会话所在 profile。

### 安装到 profile

```text
dsh plugin --profile <name> add @lornatang/dsh-security-audit
dsh plugin --profile <name> remove @lornatang/dsh-security-audit
```

如需安装 GitHub Release 包，可使用 `dsh plugin --profile <name> add https://github.com/Lornatang/dsh-security-audit/releases/download/v0.1.2/lornatang-dsh-security-audit-0.1.2.tgz`。

`add` 命令将 bundle 组合进 profile。`package.json` 通过 `dsh.bundle.patch` 声明 `cordis.patch.yml`；该 patch 插入 `security-audit` 行并加载宿主入口。添加或移除后重启 DSH，让 profile 重新组合。需要 Node.js 22.19 或更高版本，以及提供兼容 `skills` 服务的 profile。

在目标代码库中开启会话，提出具体安全问题、请求完整审计，或调用 `/security-audit`。技能对具体问题和单项调查使用指导模式；只有明确要求审计、渗透测试、全面审查或报告产物时才启动完整流程。仅加载技能不会启动审计或创建文件。

### 你会得到

| 项目 | 来源 |
|---|---|
| 可由模型和用户调用的 `security-audit` 技能 | 宿主入口与提供方，`src/index.ts` 和 `src/skills.ts` |
| 审计说明与专项漏洞挖掘指南 | `skills/security-audit/*.md` |
| 结构化发现 schema | `skills/security-audit/report-schema.json` |
| 发现与覆盖账本校验器 | `skills/security-audit/validate-findings.cjs` 和 `validate-coverage-ledger.cjs` |
| 校验器的 Windows 安全输入读取器 | `skills/security-audit/windows-safe-input.cjs` |

完整流程依次包含侦察、覆盖驱动挖掘、候选项验证、结构化输出、独立记录验证和报告。它区分 `confirmed`、`needs_validation` 和 `rejected` 三种发现状态；已确认发现需要具体的信任边界违规和已证明的结果。有源码依据但被阻塞的线索保留为 `needs_validation`，并记录缺失事实与验证计划。

默认输出目录为目标仓库之外的 `~/security-audit-skill/<repo-name>/run-<N>`。父智能体负责 `run-metadata.json`、`architecture.md`、`coverage-ledger.json`、`findings.json`、`REPORT.md`、`FINDINGS-DETAIL.md` 和 `NEEDS-VALIDATION.md`；每个受委派的工作者使用独立的 scratch 与 artifact 目录。只有用户明确选择目标仓库内的输出目录，且父智能体确认该目录被版本控制忽略时，才允许写入仓库内部。

`quick`、`standard` 和 `deep` profile 改变完整审计的广度与冗余度；默认为 `standard`。限定范围或 `quick` 审计必须说明覆盖不完整。智能体记录所选 profile、范围及调用预算，并报告两种终态之一：产物完成且两个校验器均通过，或记录未完成状态、原因和覆盖缺口。

也可以从已安装的技能目录直接运行校验器：

```text
node <skill-dir>/validate-findings.cjs <output-dir>/findings.json
node <skill-dir>/validate-coverage-ledger.cjs <output-dir>/coverage-ledger.json
```

两个校验器都接受最大 5 MiB 的 UTF-8 JSON，并限制嵌套深度与校验错误数量。覆盖账本还限制单元数量和嵌套集合项数。校验通过只表示结构和记录的不变量满足要求，不会独立证明安全发现成立。

### 凭证

软件包没有账号连接、凭证存储、API 端点或设置页面，也不会注册网络服务或收集凭证。智能体在审查期间使用的其他工具仍受宿主 profile 的配置与权限约束。

### 配置

bundle 自带以下 patch；没有声明插件专用配置字段：

```yaml
# cordis.patch.yml
- insert:
    - id: security-audit
      name: '@lornatang/dsh-security-audit'
```

该行需要宿主的 `skills` 服务。提供方向注册表提供 `security-audit` 名称、描述、调用策略和技能目录资源根路径。如果其他提供方也提供同名技能，由 DSH 注册表的优先级规则决定最终使用哪个定义。

### 故障排查

- **找不到技能** — 安装后重启 profile，确认其中包含 `skills` 服务，并检查 DSH 日志中是否有提供方失败或 `SKILL.md` 缺失。
- **加载了其他同名技能** — 检查当前工作区和作用域中的其他提供方，以及注册表的优先级规则。
- **Windows 校验器无法打开输入** — 使用直接映射到本地卷的路径，避开替代盘符、网络路径、设备名称和路径中的重解析点；确认已安装与宿主架构匹配的可选依赖。
- **校验器拒绝文档** — 根据报错检查 UTF-8 编码、5 MiB 输入上限，以及发现或覆盖账本的结构；带 UTF-8 字节顺序标记的输入会被拒绝。
- **本地复现无法满足沙箱控制** — 不要执行目标代码；将受影响线索保留为 `needs_validation`，并记录缺失的控制和安全验证计划。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕 — 点击展开</summary>

bundle 在 `package.json` 中声明一个宿主入口，通过 `cordis.patch.yml` 挂载。模块以 `security-audit` 注册并注入 `skills`。`apply` 相对 `lib/index.js` 定位打包后的 `skills/` 目录，并在插件生命周期内注册提供方。

`createSkillProvider` 从技能 frontmatter 读取名称与描述，提供一个 source 为 `bundled`、provider 为 `dsh-security-audit`、rank 为 600 的候选项，同时允许模型和用户调用。加载候选项时读取正文，并把技能目录作为相对文件的资源根路径。文件缺失会使发现结果不完整；若文件在发现后消失，提供方会使目录缓存失效并返回无定义。释放插件时会注销提供方。

两个 CLI 校验器检查 JSON 结构及安全审计相关不变量。POSIX 系统的输入读取器使用 `O_NOFOLLOW`、`O_NONBLOCK`、普通文件检查和有界读取。Windows 读取器先确认直接映射到本地卷，再固定目录与文件句柄，拒绝重解析点和非磁盘输入，并执行相同的字节上限与 UTF-8 解码。原生绑定或安全路径检查不可用时会安全拒绝输入。

| 源文件 | 内容 |
|---|---|
| `cordis.patch.yml` | 这一层：一条 insert 行，行 id `security-audit`。 |
| `src/index.ts` | `apply`：定位技能目录并注册提供方。 |
| `src/skills.ts` | 技能元数据解析、发现、加载、资源根路径与缓存失效。 |
| `skills/security-audit/SKILL.md` | 操作模式、审计准备、安全规则、profile 和工作流。 |
| `skills/security-audit/RECONNAISSANCE.md`、`HUNTING.md` | 覆盖规划、猎手任务分配和审查波次。 |
| `skills/security-audit/*-*.md` | 专项漏洞挖掘指南和报告说明。 |
| `skills/security-audit/report-schema.json` | 结构化发现 schema 与各状态分支。 |
| `skills/security-audit/validate-*.cjs` | 发现与覆盖校验、限制及 CLI 入口。 |
| `skills/security-audit/windows-safe-input.cjs` | Windows 原生路径和有界读取检查。 |
| `tests/*.test.mjs` | 注册表生命周期、平台行为和 Windows 校验器回归测试。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [CHANGELOG.md](CHANGELOG.md) — 软件包发布历史。
- [scripts/verify-dsh.mjs](scripts/verify-dsh.mjs) — 将打包后的 bundle 安装到临时 profile、运行校验器并启动 DSH。
- [技能说明](skills/security-audit/SKILL.md) — 模式、执行边界、profile、证据规则和输出。
- [DeepSeek Harness 配置目录](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/config-catalog.md) — bundle 行所遵循的加载器语义。
- [NOTICE](NOTICE) 和 [MIT 许可证](LICENSE) — 软件包声明和许可证。

-----

<a id="model-experience"></a>
## 模型体验

通过宿主的技能目录间接提供：当 `skill` 工具可见时，模型可以看到 `security-audit` 的名称与描述并加载说明。用户也可以直接调用 `/security-audit`；宿主会把说明和资源根路径提供给会话。软件包不另外注册工具定义。

#### KV Cache 影响

技能目录属于会话上下文。添加或移除提供方、修改其摘要或加载技能正文，都会改变受影响的上下文。支持提示词缓存的模型提供方可以复用未变化的前缀；具体复用和失效行为取决于提供方与实际会话消息。本软件包不配置或测量缓存。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

这些限制说明技能对周围 profile 的要求，以及校验器能证明什么。

- **软件包提供说明，不是审计引擎** — 工作流如何执行取决于智能体、可用工具和宿主的委派能力。
- **完整审计需要独立子代理** — 工作流为猎手和验证者分配独立任务；宿主不具备所需委派能力时，无法按原流程完成这些步骤。
- **执行目标代码需要沙箱** — 宿主必须落实技能中的网络、环境、文件系统和资源控制；缺少控制时不得执行目标代码，受影响线索仍需验证。
- **覆盖范围有边界** — `quick` 或限定范围审计属于部分覆盖，预算也可能导致工作延后或运行未完成。报告必须说明这些缺口。
- **Windows 输入路径受限** — 校验器接受直接映射到本地卷的路径，拒绝替代盘符、网络路径、设备名称和重解析点，包括作为父目录的重解析点。
- **Windows 需要原生绑定** — 如果宿主架构对应的可选绑定缺失或无法加载，校验器会拒绝输入，不会回退到不安全的打开方式。
- **校验只检查结构** — schema 与账本检查无法证明发现真实、审计覆盖了所有路径，或宿主提供了足够的沙箱。

<a id="dev-note"></a>
### 开发者注记

<details>
<summary>维护者工作上下文 — 点击展开</summary>

`npm run build` 清理 `lib`，并用 TypeScript 编译宿主入口与声明文件。`lib` 已提交，CI 运行 `git diff --exit-code -- lib`，因此修改源码后需要重新构建并提交。`npm run typecheck` 只检查、不产出文件。`npm test` 先构建，再运行注册表、校验器和平台测试；`prepack` 会运行测试套件。`npm run test:dsh` 打包 bundle、安装到隔离 profile、运行安装后的两个校验器并启动 DSH。可用 `DSH_TEST_EXECUTABLE` 和桌面宿主的 `DSH_TEST_ENTRY` 指定可执行入口。

需要 Node.js 22.19 或更高版本。软件包将 `skills` 服务与 Cordis 声明为 peer，使用 `yaml` 读取 frontmatter，并将各平台的 Windows 原生绑定作为可选依赖。软件包不限制 DSH 版本号。

</details>
