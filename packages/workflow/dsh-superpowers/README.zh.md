# DeepSeek Harness Superpowers

[English](README.md)

`@lornatang/dsh-superpowers` 将
[obra/superpowers v7.0.2](https://github.com/obra/superpowers/releases/tag/v7.0.2)
的 15 个工程技能接入 DSH。安装包包含上游技能原文、参考资料、提示词模板、
可视化协作工具和工作流脚本。

## 安装

需要 DSH 0.2.3-alpha.2 或更新的兼容版本，以及 Node.js 22.19 或更新版本。
在本目录构建 tarball，然后安装到目标 profile。

```sh
npm ci
npm pack
dsh plugin --profile web add ./lornatang-dsh-superpowers-0.1.0.tgz --registry=https://registry.npmjs.org/
```

重启 profile 后，直接提出开发任务即可让模型匹配技能，也可以在 Web 技能选择器
调用 `/brainstorming`、`/systematic-debugging` 或 `/writing-plans`。

## DSH 接入方式

插件通过 DSH 原生技能注册表暴露技能。主会话组装提示时会包含
`using-superpowers` 和 DSH 工具映射，上下文压缩后仍会生效。委派的子代理只接收
自己的任务引导。DSH 使用不带前缀的技能名，加载技能时会同时提供安装后的资源目录。

工作流使用当前 profile 的模型、计划工具、Shell、权限和子代理能力。可视化协作
脚本需要 Bash 和 Node.js，通过 brainstorming 工作流按需启动。其他宿主的接入
入口由 [Superpowers 上游](https://github.com/obra/superpowers) 提供。

上游版本、提交和 MIT 许可见 [NOTICE](NOTICE)。
