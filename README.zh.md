---
description: "在 DeepSeek Harness 配置中使用 Cloudflare 原版 security-audit 技能及其配套文件。"
kind: "package-bundle"
---

# @lornatang/dsh-security-audit

[English](README.md) | 中文

## 概述

`dsh-security-audit` 将 [Cloudflare 的 security-audit 技能](https://github.com/cloudflare/security-audit-skill)接入 DeepSeek Harness。插件注册原版技能，并完整保留其说明、专项指南、报告 schema、校验器和测试。DSH 集成层负责向宿主提供技能；具体审计由智能体执行，原版工作流所需的子代理和沙箱必须由宿主提供。

## 目录

- [使用此软件包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此软件包

### 安装到配置

```text
dsh plugin --profile <name> add @lornatang/dsh-security-audit
dsh plugin --profile <name> remove @lornatang/dsh-security-audit
```

添加或移除后重启 DSH。软件包会在配置中插入 `security-audit` 条目，并将技能注册到宿主的技能注册表。需要 Node.js 22.19 或更高版本，以及提供 `skills` 服务的 DSH 0.2.2-rc.3 或兼容的后续版本。

在待审计代码库中开启会话，提出具体安全问题、请求完整审计，或显式调用 `/security-audit`。原版技能区分面向具体问题的指导模式与完整审计模式；明确要求代码审计、渗透测试、全面审查或报告产物时才使用完整流程。

### 包含内容

| 项目 | 来源 |
|---|---|
| 可由模型和用户调用的 `security-audit` 技能 | DSH 技能提供方 `src/skills.ts` |
| 审计说明与专项漏洞挖掘指南 | 未修改的 `upstream/skills/security-audit/` |
| 发现报告 schema、发现及覆盖账本校验器 | 未修改的 `upstream/skills/security-audit/` |
| 上游版本锁定与许可证 | `upstream.lock.json`、`upstream/LICENSE` |

完整审计包含侦察、基于覆盖账本的挖掘、候选项验证、结构化发现、独立记录验证和报告。上游默认将输出写入目标仓库之外的 `~/security-audit-skill/<repo-name>/run-<N>`，包括覆盖账本、`findings.json` 和 Markdown 报告。技能要求区分已确认发现和仍需验证的线索，并记录覆盖缺口。

## 了解实现

`cordis.patch.yml` 安装宿主入口。入口向 `skills` 服务注册提供方；提供方读取原版技能的 frontmatter 和正文，并将原版技能目录作为相对资源的根目录。插件不新增审计工具、界面、后台服务或沙箱。同名技能并存时遵循 DSH 的常规优先级规则。

完整上游仓库位于 `upstream/`，固定在提交 [`c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`](https://github.com/cloudflare/security-audit-skill/commit/c1c8a8c1471069fb0e188eeaff69b8e8db6564a8)。`npm run verify:upstream` 按 Git blob ID 校验每个文件，并拒绝缺失、变更或额外文件。快照包含 Cloudflare 原版 README 与 MIT 许可证。

## 进一步阅读

- [上游 README](upstream/README.md)：原版工作流和文件说明。
- [上游技能](upstream/skills/security-audit/SKILL.md)：审计模式、安全边界、配置和证据要求。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：配置与插件安装文档。

## 模型体验

模型可以发现并加载该技能，用户也可以显式调用。技能说明保持原样；安装软件包本身不会启动审计。完整审计取决于宿主能否委派任务以及智能体是否遵循上游流程。审计结果需要人工复核，并受所选范围、可用证据和运行环境影响。

## 已知限制与后续工作

- 完整审计需要并行子代理，以及满足上游技能所列条件的操作系统级沙箱。插件不提供这两种能力；无法满足条件时，不得执行目标代码，受影响的线索应保留为 `needs_validation`。
- 上游命令行校验器要求 Node 提供非零的 `O_NOFOLLOW` 和 `O_NONBLOCK` 常量。原生 Windows 环境没有这些常量，两个校验器会拒绝读取输入。完整流程和校验器请使用兼容的 Linux 环境；本插件不绕过该安全检查。
- 上游是固定版本快照，不会自动同步；更新时需要重新审查快照并刷新锁文件。
- 本项目为独立集成，与 Cloudflare 无隶属或背书关系。

## 开发说明

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:dsh
```

`npm test` 校验快照、使用真实 DSH 技能注册表测试集成，并运行上游校验器测试。系统不支持安全打开输入文件时，会跳过上游 CLI 测试并验证两个 CLI 均安全拒绝输入。`test:dsh` 打包并安装至临时配置后启动 DSH；可通过 `DSH_TEST_EXECUTABLE` 和 `DSH_TEST_ENTRY` 指定宿主。版权信息见 [LICENSE](LICENSE)、[NOTICE](NOTICE) 和 [upstream/LICENSE](upstream/LICENSE)。
