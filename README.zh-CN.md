# Keyrail

**面向本地开发和 AI Agent 的项目身份与凭据路由层。**

[English](README.md) · [中文教程](docs/tutorial.zh-CN.md) · [Tutorial](docs/tutorial.md)

Keyrail 用来解决一个很具体的问题：同一台电脑上有很多项目、很多账号、很多密钥，而 AI Agent 或自动化脚本很容易在错误的项目、错误的环境、错误的账号下执行命令。

Keyrail 不替代 1Password、Infisical、Keychain 或 Vault。它位于这些 secret store 之上，负责把“当前仓库、当前项目、当前环境、允许的命令、可用的 secret 引用”绑定起来，并在执行命令前做校验。

## 核心能力

- 项目身份 manifest：`.agent-context.yaml`
- 当前环境锁文件：`.ctx/lock.yaml`
- Git remote 和 package identity 识别
- 按 context 绑定 secret 引用
- 本地文件和环境变量 secret backend
- 命令执行前 policy gate
- 高风险环境确认
- 不包含明文 secret 的 audit log
- 本地图形管理界面
- Agent 友好的 JSON 输出

## 安装

在当前仓库开发：

```bash
npm install
npm run keyrail -- current
```

发布后的使用方式：

```bash
npm i -D @keyrail/cli
npx keyrail init
```

## 快速开始

初始化：

```bash
keyrail init --id acme-web --name "Acme Web" --repo local
```

查看当前状态：

```bash
keyrail current
keyrail doctor
```

新增并切换 context：

```bash
keyrail context add staging --risk medium
keyrail context use staging
```

设置 secret 引用：

```bash
keyrail secrets set openai acme-openai-dev
```

通过 Keyrail 执行命令：

```bash
keyrail policy allow gh issue list
keyrail run -- gh issue list
```

打开本地 UI：

```bash
keyrail ui
```

UI 默认绑定 `127.0.0.1`，启动时会打印带 token 的访问地址。

## Manifest 示例

```yaml
project:
  id: acme-web
  name: Acme Web
  repo: git@github.com:acme/web.git
  default_context: staging

contexts:
  local:
    risk: low
    secrets:
      openai: acme-openai-dev

  staging:
    risk: medium
    secrets:
      github: acme-github-limited
      vercel: acme-vercel-staging

  production:
    risk: high
    require_confirmation: true
    secrets:
      github: acme-github-release
      vercel: acme-vercel-prod

policy:
  allow:
    - gh issue list
    - vercel deploy
  require_confirm:
    - vercel deploy --prod
  deny:
    - gh repo delete
```

manifest 只保存 secret 引用，不保存明文 secret。

## 命令

```bash
keyrail init [--id <id>] [--name <name>] [--repo <url|local>] [--context <name>]
keyrail bind [--context <name>]
keyrail current [--json] [--context <name>]
keyrail identify [--json]
keyrail doctor [--json]
keyrail run [--context <name>] [--yes] -- <command>
keyrail context list|use|add|remove
keyrail policy show|allow|deny|require-confirm
keyrail secrets list|set|unset [--context <name>]
keyrail audit list [--json]
keyrail handoff [--json]
keyrail ui [--port <port>] [--token <token>]
```

## 本地 UI

`keyrail ui` 提供一个本地管理界面，可以：

- 查看项目身份
- 切换 active context
- 编辑 manifest
- 查看 secret 引用
- 查看 audit 历史

## Secret Backend

Keyrail 不强绑定任何第三方 secret store。当前版本包含：

- `local-file`：`.keyrail/secrets.local.json`
- `env`：环境变量，例如 `OPENAI_API_KEY`

之后可以以 adapter 形式接入 1Password、Infisical、macOS Keychain、Vault 等。

## 安全模型

- 正常命令不会打印明文 secret。
- secret 只注入到子进程。
- 子进程输出会做脱敏。
- 命令执行前会校验项目身份。
- high-risk context 需要显式确认。
- audit log 记录决策和引用，不记录明文 secret。
- 身份无法确认时默认拒绝执行。

## 开发和发布检查

```bash
npm install
npm run check
npm_config_cache=/private/tmp/keyrail-npm-cache npm run pack:dry-run
```

当前版本：`0.1.0`。
