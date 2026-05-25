# Keyrail

**让本地 Agent 在正确的工程里使用正确的 key。**

[English](README.md) · [中文教程](docs/tutorial.zh-CN.md) · [Tutorial](docs/tutorial.md) · [产品反馈](docs/product-feedback.md)

Keyrail 是一个本地凭据路由器。你可能在一台电脑上有很多工程，每个工程使用不同的 GitHub、Vercel、Supabase、OpenAI、Anthropic、Stripe 或其他服务 key。Keyrail 给 Agent 一个简单规则：

> 先识别当前本地工程，再只使用这个工程绑定的服务账号。

它不是完整的 secret manager。它负责把“本地 repo”“服务账号引用”和“Agent 执行的命令”连接起来。

## 最简单的流程

默认不需要在项目里 init。Keyrail 会把项目路由保存在用户自己的 Keyrail 配置里，不写入 repo。

```bash
cd my-project

keyrail auth add github personal --value-stdin
keyrail attach github personal
keyrail attach vercel my-project-vercel
keyrail attach supabase my-project-supabase

keyrail status --json
keyrail run -- vercel deploy
```

给小白用户使用图形界面：

```bash
keyrail ui
```

UI 会展示当前工程、绑定了哪些服务、每个 key 是否已经配置、最近 audit，以及 Agent 应该使用的命令：`keyrail run -- <command>`。

## 为什么需要 Keyrail

Agent 很会写代码，但本地凭据上下文经常很混乱：

- 一台机器上有很多 repo
- 每个 repo 可能使用不同的 GitHub token
- 不同项目可能部署到不同 Vercel team
- Supabase、Stripe、OpenAI、Anthropic 的 key 都可能按项目区分
- Agent 如果只靠 shell 环境猜，很容易用错 key

Keyrail 的目标是消除这种歧义，同时不要求协作者也必须安装 Keyrail。

## Keyrail 做什么

- 通过 Git、package、本地目录等信号识别当前项目
- 默认把项目到账号的路由保存在本机用户配置中
- 展示已绑定服务，例如 GitHub、Vercel、Supabase、OpenAI、Stripe
- 从用户级存储、项目本地存储或环境变量解析服务账号引用
- 只在 `keyrail run` 启动的子进程中注入 key
- 对命令输出做脱敏
- 通过 `status --json` 给 Agent 结构化上下文
- 提供本地图形界面，方便非技术用户管理

## 安装

在当前仓库开发：

```bash
npm install
npm run keyrail -- status
```

发布到 npm 后：

```bash
npm i -D @keyrail/cli
npx keyrail status
```

## 主命令

保存用户级服务账号：

```bash
keyrail auth add github personal --value-stdin
keyrail auth add vercel acme-vercel --value-stdin
```

把账号引用绑定到当前项目：

```bash
keyrail attach github personal
keyrail attach vercel acme-vercel
keyrail attach supabase acme-supabase
```

也可以绑定并同时保存本地值：

```bash
keyrail attach openai acme-openai-dev --value "$OPENAI_API_KEY"
```

给 Agent 查看当前工程：

```bash
keyrail status --json
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

如果私有仓库还没有 clone 到本地，先保存一个用户级 GitHub 账号，然后让 Agent 通过 Keyrail 执行正常 GitHub 命令：

```bash
keyrail auth add github personal --value-stdin
keyrail with github personal -- gh repo clone owner/private-repo
cd private-repo
keyrail attach github personal
keyrail status --json
```

把 PAT 通过 stdin 输入，或者从你自己的安全来源 pipe 进来。`keyrail with github ... -- ...` 会给子命令注入 `GITHUB_TOKEN`/`GH_TOKEN`。如果使用普通 `git clone https://...`，它也会使用临时 Git askpass helper，不会把 token 写进 Git remote URL。

仓库已经在本地之后，Agent 使用普通项目流程：

```bash
keyrail status --json
keyrail run -- gh repo view
```

## Agent 集成

建议让 Agent 每次进入工程后先执行：

```bash
keyrail status --json
```

返回内容会包含项目身份、active context、已绑定服务、对应环境变量名、key 是否已配置，以及提示 Agent 使用 `keyrail run -- <command>`。

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

`keyrail ui` 会启动一个本地浏览器管理界面，适合不想编辑 JSON 或 YAML 的用户。

它会展示：

- 当前工程
- 路由保存位置
- active context
- 已绑定服务
- key 是否 ready
- Agent 命令提示
- 项目配置和 audit 视图

UI 默认绑定 `127.0.0.1`，启动时会输出带 token 的 URL。

## 存储模型

默认是零侵入模式：

- 不需要 `keyrail init`
- 不会在项目里写 `.agent-context.yaml`
- 不会在项目里写 `.ctx/`
- 不会在项目里写 `.keyrail/`
- 项目路由按本地项目路径保存在用户自己的 Keyrail 配置中

这样 Keyrail 是本地私有的，不会假设协作者也在使用 Keyrail。

## 可选项目 Manifest

高级本地工作流可以显式执行 `keyrail init`，它会写入 `.agent-context.yaml` 和 `.ctx/lock.yaml`。现在只有在显式 init 时，Keyrail 才会把 `.agent-context.yaml`、`.keyrail/`、`.ctx/` 加入 `.gitignore`。

manifest 保存的是账号引用名，不保存明文 key。

## Secret 值

当前支持：

- 通过 `keyrail auth add` 保存用户级本地值
- 显式 manifest 模式下的项目本地开发文件
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

复杂命令建议把完整 policy pattern 放在 `--` 后面，避免 shell 先把管道或重定向当成外层命令执行：

```bash
keyrail policy allow -- "/bin/zsh -lc 'printf ... | npx vercel env add ...'"
```

## 开发

```bash
npm install
npm run check
npm_config_cache=/private/tmp/keyrail-npm-cache npm run pack:dry-run
```

当前版本：`0.1.0`。
