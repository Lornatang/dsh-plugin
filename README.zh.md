---
description: "适用于 DeepSeek Harness 的安全审计技能、专项指南和报告校验器。"
kind: "package-bundle"
---

# @lornatang/dsh-security-audit

[English](README.md) | 中文

## 概述

`dsh-security-audit` 为 DeepSeek Harness 提供安全审计技能，包含审计说明、专项指南、报告 schema，以及发现和覆盖记录的校验器。具体审查由智能体执行；工作流需要的子代理和沙箱必须由宿主提供。

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

添加或移除后重启 DSH。软件包会在配置中插入 `security-audit` 条目，并将技能注册到宿主的技能注册表。需要 Node.js 22.19 或更高版本，以及提供兼容 `skills` 服务的 DSH 配置。

在待审计代码库中开启会话，提出具体安全问题、请求完整审计，或显式调用 `/security-audit`。技能区分面向具体问题的指导模式与完整审计模式；明确要求代码审计、渗透测试、全面审查或报告产物时才使用完整流程。

### 包含内容

| 项目 | 位置 |
|---|---|
| 可由模型和用户调用的 `security-audit` 技能 | DSH 技能提供方 `src/skills.ts` |
| 审计说明与专项漏洞挖掘指南 | `skills/security-audit/` |
| 发现报告 schema、发现及覆盖账本校验器 | `skills/security-audit/` |
| Windows 安全输入读取器 | `skills/security-audit/windows-safe-input.cjs` |

完整审计包含侦察、基于覆盖账本的挖掘、候选项验证、结构化发现、独立记录验证和报告。默认将输出写入目标仓库之外的 `~/security-audit-skill/<repo-name>/run-<N>`，包括覆盖账本、`findings.json` 和 Markdown 报告。技能要求区分已确认发现和仍需验证的线索，并记录覆盖缺口。

## 了解实现

`cordis.patch.yml` 安装宿主入口。入口向 `skills` 服务注册提供方；提供方读取技能的元数据和正文，并将技能目录作为相对资源的根目录。插件不新增审计工具、界面、后台服务或沙箱。同名技能并存时遵循 DSH 的常规优先级规则。

校验器接受最大 5 MiB 的 UTF-8 JSON 文件。Windows 读取器使用原生文件句柄检查本地路径，拒绝重解析点、设备路径和网络路径，并限制读取字节数；原生绑定不可用时会安全拒绝输入。支持 `O_NOFOLLOW` 和 `O_NONBLOCK` 的系统使用这些标志打开输入文件。

## 进一步阅读

- [技能说明](skills/security-audit/SKILL.md)：审计模式、安全边界、配置和证据要求。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：配置与插件安装文档。

## 模型体验

模型可以发现并加载该技能，用户也可以显式调用。安装软件包本身不会启动审计。完整审计取决于宿主能否委派任务以及智能体是否遵循工作流。审计结果需要人工复核，并受所选范围、可用证据和运行环境影响。

## 已知限制与后续工作

- 完整审计需要并行子代理，以及满足技能所列条件的操作系统级沙箱。插件不提供这两种能力；无法满足条件时，不得执行目标代码，受影响的线索应保留为 `needs_validation`。
- Windows 校验器读取器接受本地磁盘路径，拒绝网络路径、设备名称和重解析点，包括作为父目录的重解析点。运行时需要与宿主架构匹配的原生绑定。

## 开发说明

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:dsh
```

`npm test` 测试 DSH 技能注册表和校验器，包括 Windows 路径与输入安全检查。`test:dsh` 打包并安装至临时配置，运行安装后的校验器并启动 DSH；可通过 `DSH_TEST_EXECUTABLE` 和 `DSH_TEST_ENTRY` 指定宿主。许可证与版权声明见 [LICENSE](LICENSE)。
