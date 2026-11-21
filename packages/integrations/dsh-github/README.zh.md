---
description: "在 dsh profile 中接入 GitHub 官方 MCP 服务：浏览器授权、加密凭据、agent 工具、写操作审批与连接设置页。"
kind: "package-bundle"
---

# @lornatang/dsh-github

[English](README.md) | 中文

## 概要

`dsh-github` 将 DeepSeek Harness profile 连接到 GitHub 托管的 MCP 服务，向 agent 注册仓库文件、Issue、Pull Request 和 Actions 等工具，并在 Web 客户端中加入 GitHub 连接设置页。可通过浏览器授权、已登录的 GitHub CLI 或个人访问令牌连接；服务端未标为只读的工具调用会交给 DSH 审批。本包内置 GitHub OAuth 应用的公开 Client ID；可用工具与账号权限由 GitHub 决定。

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

本层负责连接和工具注册；GitHub 提供工具定义并执行账号的仓库权限，DSH 原有工具策略仍然生效。安装到需要使用 GitHub 的 profile：

```text
dsh plugin --profile <name> add @lornatang/dsh-github
dsh plugin --profile <name> remove @lornatang/dsh-github
```

如需版本化安装包，可查看 [GitHub Releases](https://github.com/Lornatang/dsh-github/releases)。添加或删除后重启 DSH，在 Web profile 中打开 Settings → GitHub。

### 连接 GitHub

选择 **Connect with GitHub**，在打开的 GitHub 页面输入 DSH 显示的一次性短验证码，检查并同意授权；之后 DSH 会自动完成连接。这种方式无需安装 `gh` 或手动创建个人令牌。GitHub 的设备授权需要输入短验证码，它不是个人访问令牌。取消待授权的请求会保留并恢复原有连接。

在 DSH 宿主安装 GitHub CLI 并执行 `gh auth login` 后，选择 **Connect with GitHub CLI**。桥接通过 `gh auth token` 读取当前 `github.com` 令牌；令牌不会写入 profile，保存的连接只记录下次继续使用 `gh`。这是 GitHub CLI 的认证方式，并非本插件自行实现的 OAuth 流程。

也可以在密码框输入 GitHub 个人访问令牌并选择 **Connect with token**。桥接会先测试连接，再替换已保存的凭据；令牌以加密形式写入 profile，设置页不会回显。请根据需要授予对应仓库和操作权限。连接失败时，之前保存的凭据会保留。

无界面宿主可配置 `credentialSource: env`，并在 DSH 进程环境中提供 `GITHUB_TOKEN`；也可配置 `credentialSource: gh` 使用已登录的 GitHub CLI。启动时，显式配置的来源优先于已保存的连接。

### 你将获得

| 功能 | 提供位置 |
|---|---|
| GitHub 在所选工具集中公布的每个 `mcp__github__<tool>` | 宿主入口，`src/bridge.ts` |
| 对没有 `readOnlyHint: true` 的工具请求审批 | 宿主入口，`src/index.ts` |
| Settings → GitHub 连接状态和凭据设置页 | 客户端入口，`src/client/index.tsx` |
| `GET /plugins/github/status`、`POST /plugins/github/connect`、`POST /plugins/github/cancel`、`POST /plugins/github/disconnect` | 宿主入口，`src/routes.ts` |
| `<profile>/data/dsh-github-<serverName>-<hash>.json` | 宿主入口，`src/store.ts` |

默认工具集为 `repos,issues,pull_requests,actions`。实际工具可由 GitHub 更新，也受账号权限和 GitHub 策略影响。在权限允许时，agent 可以读取文件、创建或更新文件、批量推送文件、创建 PR，以及查看 Issue 和检查结果。大型本地仓库通常更适合使用普通 Git 操作，而不是把文件内容通过 MCP 工具传递。

工具名遵循 `mcp__github__<name>`。字母、数字、连字符和下划线之外的字符会变成下划线；发生替换或名称过长时会截短并附加十二位 SHA-256 后缀。描述与输入 schema 来自服务端。桥接会校验声明的结构化输出，把文本块作为文本渲染，其余内容块显示类型占位符；服务端报错会使调用失败。工具输出或错误消息中若出现当前 GitHub 令牌的完整值，会被遮蔽。

除服务端标为 `readOnlyHint: true` 的工具外，桥接都向 DSH 审批服务请求批准；缺少提示时也需要审批。DSH 原有策略决定仍然生效。只读提示由所配置的 MCP 服务提供，因此应使用可信端点。本插件不会授予 GitHub 权限，也不会代替用户批准调用。

### 凭据

保存的来源以及个人访问令牌或 OAuth 访问令牌和刷新令牌（如有）以 AES-256-GCM 加密封装存入 `<profile>/data/`；有过期时间的 OAuth 访问令牌会在需要时刷新。文件路径作为附加认证数据。32 字节密钥来自 `@napi-rs/keyring` 接入的系统凭据存储，或来自 `DSH_GITHUB_ENCRYPTION_KEY`（标准 Base64 编码的 32 字节）。没有明文回退。POSIX 上文件权限为 `0600`、数据目录为 `0700`，并检查符号链接、目录属主和硬链接；Windows 上应使用 ACL 保护 profile 目录Windows 上读取器还会校验已打开文件与已检查文件仍为同一文件，以拒绝检查与打开之间的替换。

没有系统凭据存储的无界面宿主，在保存连接前需要设置持久的 `DSH_GITHUB_ENCRYPTION_KEY`，并在重启后保留相同密钥和 profile 路径。Disconnect 删除本地加密文件和 keyring 项并注销工具；它不会撤销 GitHub 令牌或退出 `gh`。本包没有协调多进程写入，请每个 profile 只运行一个 DSH 进程。

### 配置

随包提供的记录包含下列默认值，profile 可在补丁中覆盖：

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: github
  config:
    serverName: github
    url: 'https://api.githubcopilot.com/mcp/'
    toolsets: 'repos,issues,pull_requests,actions'
    readOnly: false
    credentialSource: saved
    oauthClientId: 'Ov23liyuutYTU29KMjVg'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `serverName` | `github` | 工具前缀与凭据身份；1–64 个字母、数字、连字符或下划线。 |
| `url` | `https://api.githubcopilot.com/mcp/` | GitHub MCP 端点；除回环 HTTP 外必须使用 HTTPS。 |
| `toolCallTimeoutMs` | `60000` | 连接、发现和工具调用的超时毫秒数。 |
| `toolsets` | `repos,issues,pull_requests,actions` | 通过 `X-MCP-Toolsets` 传给服务端的逗号分隔工具集。 |
| `readOnly` | `false` | 发送 `X-MCP-Readonly: true`，请求服务端仅提供只读工具。 |
| `credentialSource` | `saved` | `saved`、`env`（`GITHUB_TOKEN`）或 `gh`（GitHub CLI）。 |
| `oauthClientId` | 内置应用 ID | 已启用设备授权的 GitHub OAuth 应用公开 Client ID；为空时读取 `DSH_GITHUB_OAUTH_CLIENT_ID`。 |

#### 维护者配置浏览器授权

本包内置已注册 OAuth 应用的公开 Client ID，普通用户无需另行创建。如需使用其他应用，可在 GitHub Developer Settings 中创建 OAuth App，主页设为本仓库地址，必填的回调地址设为 `http://127.0.0.1/callback`，并启用 **Device Flow**。设备授权不会使用回调地址。将 `oauthClientId` 覆盖为该应用的公开 Client ID，或将其设为空并向 DSH 进程提供 `DSH_GITHUB_OAUTH_CLIENT_ID`；此流程不需要 Client Secret。详见 [GitHub 设备授权文档](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)。

浏览器授权初次请求 `repo` 和 `read:org` 范围，可能涉及私有仓库等较广的访问权限，实际权限还受 GitHub 账号及组织策略限制。GitHub 会在用户同意前展示权限。如果某个工具需要额外范围，该调用会报错，设置页会显示所需权限；重新选择 **Connect with GitHub**，在 GitHub 上检查并同意后，再重试操作。插件不会自动重试写操作，DSH 的审批仍然生效。

请求限定在配置端点的同源地址，且不会自动跟随重定向。MCP 响应体上限为 16 MiB；对服务器发送事件流，该上限按单个事件计算，而整体读取响应体（JSON 或文本）时另有 16 MiB 总量上限。工具发现上限为 8 MiB、100 页和 1000 个工具，并受统一的总时限约束。

### 排障

- **浏览器授权不可用**——检查配置的 OAuth 应用 Client ID 以及是否启用 Device Flow。修改 profile 配置或进程环境后重启 DSH。
- **刷新后的凭据无法保存**——保持 DSH 运行并恢复 profile 安全存储的访问；插件会在下次请求时重试保存。如果保存成功前关闭 DSH，可能需要重新进行浏览器授权。
- **GitHub CLI 不可用或未登录**——在 DSH 宿主安装 `gh` 并运行 `gh auth login`，或使用个人访问令牌。
- **连接失败或缺少工具**——检查到 GitHub MCP 端点的网络、账号与组织策略、令牌权限、所选工具集和 DSH 日志；点击连接按钮重试。
- **安全密钥存储不可用**——解锁系统凭据存储，或设置持久的 Base64 编码 32 字节 `DSH_GITHUB_ENCRYPTION_KEY`。
- **已存凭据无法解密**——恢复原密钥和 profile 路径，或删除已存凭据后重新连接。
- **写操作被拒绝**——检查 DSH 审批通道和策略，以及 GitHub 账号或令牌的权限。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕 — 点击展开</summary>

`dsh.bundle.patch` 在 profile 中插入宿主记录；`dsh.client` 暴露 Web 设置区。`apply` 创建 profile 范围的存储和桥接，绑定经过请求栅栏的路由，监听 DSH 的执行前策略事件，并启动所配置的凭据来源。桥接使用 Streamable HTTP MCP 连接，分页发现工具，并为每个服务端定义注册一个 DSH 工具。失败或取消的连接会移除其注册；Disconnect 先中止请求再删除保存的状态，卸载则保留状态供下次启动。

| 源文件 | 内容 |
|---|---|
| `cordis.patch.yml` | profile 记录与默认值。 |
| `src/index.ts` | 宿主入口、路由绑定和审批策略。 |
| `src/config.ts` | 配置 schema 与默认值。 |
| `src/bridge.ts` | 凭据、MCP 生命周期、发现与工具注册。 |
| `src/oauth.ts` | GitHub 设备授权与访问令牌刷新。 |
| `src/transport.ts`、`src/response-limit.ts` | 同源限制、请求头与响应限制。 |
| `src/store.ts` | 加密凭据文件与系统 keyring。 |
| `src/routes.ts` | 受 DSH 栅栏保护的连接路由。 |
| `src/output-validator.ts`、`src/output-validator-worker.ts` | 在 worker 中隔离校验结构化输出。 |
| `src/client/index.tsx` | GitHub 设置页。 |
| `tests/*.test.mjs` | 模拟 MCP、凭据、生命周期和审批测试。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [GitHub MCP Server](https://github.com/github/github-mcp-server) 与[远程服务配置](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)。
- [GitHub 个人访问令牌](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)。
- [DeepSeek Harness 配置目录](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/config-catalog.md)。
- [CHANGELOG.md](CHANGELOG.md)、[NOTICE](NOTICE) 与 [Apache-2.0 许可证](LICENSE)。

-----

<a id="model-experience"></a>
## 模型体验

模型看到注册的 GitHub 工具名称、描述和输入 schema，结果作为工具内容返回；设置页和凭据不进入模型提示词。修改 GitHub 的请求可能触发 DSH 审批。

#### KV 缓存影响

连接会把发现的工具定义加入请求前缀，断开会移除它们。工具集或服务端目录发生变化时，前缀从首个变化的定义开始改变，后续缓存 token 可能失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **GitHub 授权策略**——GitHub 可能对内置 OAuth 应用施加账号、组织或 MCP 访问限制。
- **每个 profile 行一个连接**——Web 路由使用固定前缀，设置页假定一个 profile 只有一个 GitHub 桥接。
- **能力由服务端定义**——工具名称、schema 与只读提示可能变化；不可信端点提供的提示不是安全边界。
- **不保证自动恢复**——连接关闭或请求失败时，可从设置页重新连接，或重启已配置的无界面来源。
- **凭据绑定 profile 路径与密钥**——移动 profile 或更换密钥会使保存状态无法读取；Disconnect 不撤销上游凭据。
- **文本渲染**——非文本 MCP 内容显示为类型占位符，不作为原生媒体展示。

<a id="dev-note"></a>
### 开发者注记

<details>
<summary>维护者工作上下文 — 点击展开</summary>

`npm run build` 清理并编译宿主和客户端，再将客户端打包为 `lib/client.js`；`lib` 提交到仓库。`npm run typecheck` 检查两个 TypeScript 工程；`npm test` 构建并运行模拟服务测试。`npm run test:dsh` 将打包结果安装进临时真实 DSH profile，检查请求栅栏、加密凭据文件，并在 Chrome 可用时测试设置页。非默认位置可设置 `DSH_TEST_BINARY` 和 `CHROME_PATH`。要求 Node.js 22.19 或更高版本。

</details>
