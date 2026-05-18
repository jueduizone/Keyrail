# Keyrail 教程

这个教程演示 Keyrail 默认流程：不在项目里写文件，把服务 key 绑定到本地工程，然后让 Agent 通过 Keyrail 执行命令。

## 目标

假设一个工程会用到：

- GitHub
- Vercel
- Supabase
- OpenAI

你希望本地 Agent 只使用这个工程自己的 key，而不是误用其他 repo 的 key。

## 1. 进入项目

在项目根目录执行：

```bash
cd acme-web
keyrail status --json
```

默认不需要 `keyrail init`。如果还没有 Keyrail 配置，Keyrail 会根据当前 Git、package、本地目录身份生成默认项目信息。只有在你绑定服务、切换 context 或修改 policy 时，才会写入用户级项目路由。

## 2. 可选：先 clone 私有仓库

如果私有仓库还没有在本地，先保存一个用户级 GitHub 账号，再通过 Keyrail 执行正常 clone 命令：

```bash
keyrail auth add github personal --value-stdin
keyrail with github personal -- gh repo clone acme/private-repo
cd private-repo
keyrail attach github personal
keyrail status --json
```

建议用 `--value-stdin`，避免 PAT 留在 shell history。Git remote 会保持普通 GitHub URL，不包含 token。如果没有安装 `gh`，可以用 `keyrail with github personal -- git clone https://github.com/acme/private-repo.git`。

## 3. 绑定服务账号

绑定这个工程会用到的服务：

```bash
keyrail attach github personal
keyrail attach vercel acme-vercel-token
keyrail attach supabase acme-supabase-token
keyrail attach openai acme-openai-dev
```

这些账号名是本地引用。默认模式下它们保存在用户自己的 Keyrail 配置里，不写进项目仓库。

如果想让 Keyrail 保存本地开发值：

```bash
keyrail attach openai acme-openai-dev --value "$OPENAI_API_KEY"
```

零 init 模式下，本地值会写入用户级 Keyrail store。

## 4. 查看 Agent 能看到什么

```bash
keyrail status --json
```

输出会告诉 Agent：

- 当前是哪个工程
- 绑定了哪些服务
- 每个服务映射到哪个环境变量
- key 是否已配置
- 应该使用 `keyrail run -- <command>` 执行命令

这是最主要的 Agent 集成入口。

## 5. 通过 Keyrail 执行命令

```bash
keyrail run -- gh issue list
keyrail run -- vercel deploy
keyrail run -- supabase db push
```

Keyrail 会校验项目身份、解析绑定的 key、注入子进程、脱敏输出，并写入 audit。

## 6. 使用本地 UI

```bash
keyrail ui
```

打开命令输出里的 URL。UI 会展示：

- 当前工程
- 项目路由保存位置
- active context
- 已绑定服务
- key 是否 ready
- Agent 应该使用的命令方式
- 项目配置和 audit 视图

这是小白用户最容易理解的入口。

## 7. 常见用法

使用环境变量，不保存本地文件：

```bash
export VERCEL_TOKEN=...
keyrail attach vercel acme-vercel-token
keyrail run -- vercel deploy
```

移除服务绑定：

```bash
keyrail detach vercel
```

查看已绑定服务：

```bash
keyrail status
```

## 8. 高级：Staging 和 Production

如果项目需要多个环境：

```bash
keyrail context add staging --risk medium
keyrail context add production --risk high --confirm
keyrail context use staging
```

每个 context 可以绑定不同 key：

```bash
keyrail context use production
keyrail attach vercel acme-vercel-prod
```

high-risk context 默认需要确认。自动化场景可以显式传入：

```bash
KEYRAIL_CONFIRM=1 keyrail run --context production -- vercel deploy --prod
```

## 9. 高级：可选项目 Manifest

如果你明确希望为个人工作流使用 repo-local Keyrail 文件：

```bash
keyrail init --id acme-web --name "Acme Web" --repo git@github.com:acme/web.git
```

这会创建 `.agent-context.yaml` 和 `.ctx/lock.yaml`。初始化这个模式时，Keyrail 会把 `.agent-context.yaml`、`.keyrail/`、`.ctx/` 加入 `.gitignore`。manifest 保存的是账号引用名，不保存明文 key。

## 10. 高级：Policy 和 Audit

允许常用命令：

```bash
keyrail policy allow vercel deploy
keyrail policy allow supabase db push
```

禁止危险命令：

```bash
keyrail policy deny gh repo delete
```

查看最近命令决策：

```bash
keyrail audit list
keyrail audit list --json
```

## 11. Handoff 给另一个 Agent

```bash
keyrail handoff --json
```

handoff 会包含项目身份、active context、已绑定服务和 policy，不包含明文 secret。
