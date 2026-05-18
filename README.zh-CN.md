# Keyrail

**让本地 Agent 在正确的工程里使用正确的 key。**

[English](README.md) · [中文教程](docs/tutorial.zh-CN.md) · [Tutorial](docs/tutorial.md)

Keyrail 是一个本地项目凭据路由器。你可能在一台电脑上有很多工程，每个工程使用不同的 GitHub、Vercel、Supabase、OpenAI、Anthropic 或 Stripe key。Keyrail 给 Agent 一个简单规则：

> 先识别当前工程，再只使用这个工程绑定的 key。

它不是完整的 secret manager。它负责把“本地 repo”和“这个 repo 应该使用哪些服务凭据”绑定起来，并在执行命令时注入正确的值。

## 最简单的使用流程

```bash
cd my-project

keyrail init
keyrail link github my-project-github-token
keyrail link vercel my-project-vercel-token
keyrail link supabase my-project-supabase-token

keyrail current --json
keyrail run -- vercel deploy
```

给小白用户使用图形界面：

```bash
keyrail ui
```

UI 会展示当前工程、绑定了哪些服务、每个 key 是否已经配置，以及 Agent 应该使用的命令：`keyrail run -- <command>`。

## 为什么需要 Keyrail

Agent 很会写代码，但本地环境经常很混乱：

- 一台机器上有很多 repo
- 每个 repo 可能使用不同的 GitHub token
- 不同项目可能部署到不同 Vercel team
- Supabase、Stripe、OpenAI、Anthropic 的 key 都可能按项目区分
- Agent 如果只靠猜，很容易用错 key

Keyrail 的目标就是消除这种歧义。

## Keyrail 做什么

- 识别当前项目
- 从 `.agent-context.yaml` 读取项目身份
- 展示已绑定服务，例如 GitHub、Vercel、Supabase、OpenAI、Stripe
- 从本地 backend 或环境变量解析 key 引用
- 只在 `keyrail run` 启动的子进程中注入 key
- 对命令输出做脱敏
- 通过 `current --json` 给 Agent 结构化上下文
- 提供本地图形界面，方便非技术用户管理

## 安装

在当前仓库开发：

```bash
npm install
npm run keyrail -- current
```

发布到 npm 后：

```bash
npm i -D @keyrail/cli
npx keyrail init
```

## 主命令

初始化：

```bash
keyrail init
```

绑定服务 key 引用：

```bash
keyrail link github acme-github-token
keyrail link vercel acme-vercel-token
keyrail link supabase acme-supabase-token
```

也可以保存一个本地开发值：

```bash
keyrail link openai acme-openai-dev --value "$OPENAI_API_KEY"
```

给 Agent 查看当前工程：

```bash
keyrail current --json
```

通过 Keyrail 执行命令：

```bash
keyrail run -- gh issue list
keyrail run -- vercel deploy
keyrail run -- supabase db push
```

打开 UI：

```bash
keyrail ui
```

## 私有仓库 Bootstrap

如果私有仓库还没有 clone 到本地，这时 repo 里还没有 `.agent-context.yaml`，Agent 也就无法从项目配置里判断应该用哪个 GitHub PAT。先配置一个用户级 GitHub bootstrap profile：

```bash
keyrail profile set github personal-github --value-stdin
keyrail clone github owner/private-repo
cd private-repo
keyrail init --repo git@github.com:owner/private-repo.git
keyrail link github personal-github
keyrail current --json
```

把 PAT 通过 stdin 输入，或者从你自己的安全来源 pipe 进来。`keyrail clone` 使用临时 Git askpass helper，不会把 token 写进 Git remote URL。

仓库已经在本地之后，Agent 使用普通项目流程：

```bash
keyrail current --json
keyrail run -- gh repo view
```

## Agent 集成

建议让 Agent 每次进入工程后先执行：

```bash
keyrail current --json
```

返回内容会包含：

- project id 和 name
- 已验证的身份信号
- active context
- 已绑定服务
- 对应环境变量名
- 每个 key 是否已配置
- 提示 Agent 使用 `keyrail run -- <command>`

示例：

```json
{
  "project": {
    "id": "acme-web",
    "name": "Acme Web"
  },
  "services": [
    {
      "service": "vercel",
      "reference": "acme-vercel-token",
      "envName": "VERCEL_TOKEN",
      "configured": true
    }
  ],
  "agent": {
    "verified": true,
    "instruction": "Use keyrail run -- <command> so this project receives only its linked service keys."
  }
}
```

## 本地 UI

`keyrail ui` 会启动一个本地浏览器管理界面，适合不想编辑 YAML 的用户。

它会展示：

- 当前工程
- active context
- 已绑定服务
- key 是否 ready
- Agent 命令提示
- 高级 manifest 和 audit 视图

UI 默认绑定 `127.0.0.1`，启动时会输出带 token 的 URL。

## Manifest

Keyrail 把项目路由信息保存在 `.agent-context.yaml`。

```yaml
project:
  id: acme-web
  name: Acme Web
  repo: local
  default_context: local

contexts:
  local:
    risk: low
    secrets:
      github: acme-github-token
      vercel: acme-vercel-token
      supabase: acme-supabase-token
      openai: acme-openai-dev

policy:
  allow:
    - gh issue list
    - vercel deploy
    - supabase db push
  require_confirm:
    - vercel deploy --prod
  deny:
    - gh repo delete
```

manifest 保存的是引用，不保存明文 key。

## Secret 值

当前支持：

- 本地开发文件：`.keyrail/secrets.local.json`
- 环境变量：`VERCEL_TOKEN`、`GITHUB_TOKEN`、`SUPABASE_ACCESS_TOKEN`、`OPENAI_API_KEY`

未来可以用 adapter 接入 1Password、Infisical、macOS Keychain、Vault 等，但它们不是核心流程的强依赖。

## 高级命令

团队如果需要 staging/production、命令策略和审计，可以使用：

```bash
keyrail context list|use|add|remove
keyrail policy show|allow|deny|require-confirm
keyrail secrets list|set|unset
keyrail audit list --json
keyrail handoff --json
keyrail doctor
```

## 开发

```bash
npm install
npm run check
npm_config_cache=/private/tmp/keyrail-npm-cache npm run pack:dry-run
```

当前版本：`0.1.0`。
