---
description: "在 dsh profile 中提供 Superpowers 工程技能、工作流资源和会话引导。"
kind: "package-bundle"
---

# @lornatang/dsh-superpowers

[English](README.md) | 中文

## 概要

`dsh-superpowers` 将 obra/superpowers v7.0.2 的 15 个技能接入 DeepSeek Harness，涵盖头脑风暴、计划编写、测试驱动开发、调试、代码审查和验证。插件注册技能及其原始资源，并将 Superpowers 引导加入主会话的系统提示。

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

需要 Node.js 22.19 或更新版本，以及 DeepSeek Harness 0.2.3-alpha.2 或低于 0.3.0 的更新兼容版本。将插件安装到需要使用 Superpowers 的会话所在 profile。

### 安装到 profile

```text
dsh plugin --profile <name> add @lornatang/dsh-superpowers
dsh plugin --profile <name> remove @lornatang/dsh-superpowers
```

预构建安装包的标签格式为 `dsh-superpowers-v<version>`。[GitHub Releases](https://github.com/Lornatang/dsh-plugin/releases)

也可以在仓库根目录执行以下命令，从源码构建并安装。

```sh
cd packages/workflow/dsh-superpowers
npm ci
npm pack
dsh plugin --profile <name> add ./lornatang-dsh-superpowers-<version>.tgz
```

`add` 命令将插件组合进 profile，并插入 `superpowers` 配置项。添加或移除后重启 DSH。管理 Desktop 的插件时，先退出应用，再用其自带的 `dsh` CLI 指定 `--profile desktop`，操作完成后重新打开应用。[Desktop 插件命令](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md#bundled-command-runtime)

### 你会得到

| 功能 | 实现位置 |
|---|---|
| 用户和模型均可调用的 15 个技能 | `src/skills.ts`、`vendor/superpowers/skills/` |
| 主会话引导及 DSH 工具映射 | `src/index.ts` 和上游的 `using-superpowers` 技能 |
| 技能参考资料、提示词模板和工作流脚本 | 各技能 `SKILL.md` 同目录下的资源 |
| 头脑风暴可选的可视化协作工具 | `vendor/superpowers/skills/brainstorming/` |

### 使用技能

提出开发任务，让智能体选择相关技能，也可以在 DSH 技能选择器里按名称调用，例如 `/brainstorming`、`/systematic-debugging` 或 `/writing-plans`。DSH 技能目录使用不带前缀的名称。技能引用脚本或模板时，从宿主返回的资源目录解析相对路径。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

`package.json` 通过 `dsh.bundle.patch` 声明 `cordis.patch.yml`。插件入口使用 profile 的 `skills` 和 `systemPrompt` 服务，并注册一个内置技能提供方。技能名称、说明、调用权限和资源目录来自打包文件。

`apply` 注册 `superpowers:bootstrap` 系统提示区块。DSH 为主会话组装提示时会加入这个区块，上下文压缩后也一样。区块包含完整的 `using-superpowers` 技能及工具映射。子代理接收宿主为其分配的任务提示。

| 路径 | 职责 |
|---|---|
| `cordis.patch.yml` | 在 profile 中插入 `superpowers` 配置项。 |
| `src/index.ts` | 注册技能提供方并组装主会话引导。 |
| `src/skills.ts` | 读取和校验技能元数据，提供正文与资源目录。 |
| `vendor/superpowers/skills/` | 存放固定上游版本的技能及配套资源。 |
| `tests/plugin.test.mjs` | 检查技能目录、资源加载、提示组装和卸载行为。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- 软件包发布记录。[CHANGELOG.md](CHANGELOG.md)
- 上游版本和工作流指南。[Superpowers v7.0.2](https://github.com/obra/superpowers/releases/tag/v7.0.2)
- 头脑风暴可视化协作的使用说明。[可视化协作指南](vendor/superpowers/skills/brainstorming/visual-companion.md)
- 上游提交、署名和许可。[NOTICE](NOTICE) · [MIT 许可证](vendor/superpowers/LICENSE)

-----

<a id="model-experience"></a>
## 模型体验

主会话开始时，模型会收到 `using-superpowers`。其他技能正文通过 DSH 的 `skill` 工具加载，用户直接调用时则由宿主提供。模型可用的计划工具、Shell 和委派能力由 profile 决定。

#### KV Cache 影响

插件运行期间，主会话在各轮使用相同的引导区块。加载技能会把正文加入会话上下文，能否复用前缀取决于模型服务提供方。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 工作流依赖当前 profile 的模型、工具与权限。无法委派时，可以使用 `executing-plans` 在当前会话内执行。
- 可视化协作脚本需要 Bash 和 Node.js，并通过头脑风暴流程按需启动。
- 其他编码智能体的宿主适配由上游维护。[Superpowers](https://github.com/obra/superpowers)

<a id="dev-note"></a>
### 开发者注记

<details>
<summary>维护者工作上下文</summary>

`npm run typecheck` 检查 TypeScript。`npm test` 构建 `lib` 并测试 DSH 原生技能注册表和提示组装。`npm pack` 通过 `prepack` 运行测试。仓库跟踪 `lib` 中的编译产物，CI 会把它们与重新构建的结果比较。

</details>
