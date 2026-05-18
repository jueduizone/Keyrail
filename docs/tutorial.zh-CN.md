# Keyrail 教程

这个教程演示 Keyrail 最核心的流程：把服务 key 绑定到本地工程，然后让 Agent 通过 Keyrail 执行命令。

## 目标

假设一个工程会用到：

- GitHub
- Vercel
- Supabase
- OpenAI

你希望本地 Agent 只使用这个工程自己的 key，而不是误用其他 repo 的 key。

## 1. 初始化 Keyrail

在项目根目录执行：

```bash
keyrail init
```

会创建：

```text
.agent-context.yaml
.ctx/lock.yaml
```

真实 GitHub 项目建议绑定 remote：

```bash
keyrail init --id acme-web --name "Acme Web" --repo git@github.com:acme/web.git
```

本地测试时使用 `repo: local` 就可以。

## 2. 可选：先 clone 私有仓库

如果私有仓库还没有在本地，项目级 Keyrail 配置还不存在，所以不能靠 repo 内 manifest 判断应该用哪个 PAT。先配置用户级 GitHub bootstrap profile，再通过 Keyrail 执行正常 clone 命令：

```bash
keyrail profile set github personal-github --value-stdin
keyrail use github -- gh repo clone acme/private-repo
cd private-repo
keyrail init --repo git@github.com:acme/private-repo.git
keyrail link github personal-github
```

建议用 `--value-stdin`，避免 PAT 留在 shell history。Git remote 会保持普通 GitHub URL，不包含 token。如果没有安装 `gh`，可以用 `keyrail use github -- git clone https://github.com/acme/private-repo.git`。

## 3. 绑定服务 Key

绑定这个工程会用到的服务：

```bash
keyrail link github acme-github-token
keyrail link vercel acme-vercel-token
keyrail link supabase acme-supabase-token
keyrail link openai acme-openai-dev
```

这些是引用名，可以安全保存在 `.agent-context.yaml` 里。

如果想让 Keyrail 保存本地开发值：

```bash
keyrail link openai acme-openai-dev --value "$OPENAI_API_KEY"
```

本地值会写入 `.keyrail/secrets.local.json`，这个文件不应该进 git。

## 4. 查看 Agent 能看到什么

```bash
keyrail current --json
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
- active context
- 已绑定服务
- key 是否 ready
- Agent 应该使用的命令方式
- 高级 manifest 和 audit 视图

这是小白用户最容易理解的入口。

## 7. 常见用法

使用环境变量，不保存本地文件：

```bash
export VERCEL_TOKEN=...
keyrail link vercel acme-vercel-token
keyrail run -- vercel deploy
```

移除服务绑定：

```bash
keyrail unlink vercel
```

查看已绑定服务：

```bash
keyrail current
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
keyrail link vercel acme-vercel-prod
```

high-risk context 默认需要确认。自动化场景可以显式传入：

```bash
KEYRAIL_CONFIRM=1 keyrail run --context production -- vercel deploy --prod
```

## 9. 高级：Policy 和 Audit

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

## 10. Handoff 给另一个 Agent

```bash
keyrail handoff --json
```

handoff 会包含项目身份、active context、已绑定服务和 policy，不包含明文 secret。
