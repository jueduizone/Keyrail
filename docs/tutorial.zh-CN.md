# Keyrail 教程

这个教程演示如何给一个本地项目配置 `local`、`staging`、`production` 三个 context，并让 Agent 通过 Keyrail 安全执行命令。

## 1. 初始化项目

在仓库根目录执行：

```bash
keyrail init --id acme-web --name "Acme Web" --repo local
```

早期本地测试可以使用 `--repo local`。真实项目建议绑定 Git remote：

```bash
keyrail init --id acme-web --name "Acme Web" --repo git@github.com:acme/web.git
```

命令会创建：

```text
.agent-context.yaml
.ctx/lock.yaml
```

## 2. 检查身份

```bash
keyrail identify
keyrail current
keyrail doctor
```

`identify` 会展示 Git remote、package name 等识别信号。`current` 展示当前项目和 context。`doctor` 检查 manifest、身份和 secret 引用是否可用。

## 3. 添加 Context

```bash
keyrail context add staging --risk medium
keyrail context add production --risk high --confirm
keyrail context list
```

切换 context：

```bash
keyrail context use staging
```

active context 会写入 `.ctx/lock.yaml`，这样恢复终端或 Agent 会话时不需要猜当前环境。

## 4. 添加 Secret 引用

Keyrail 的 manifest 保存的是 secret 引用，不是明文值：

```bash
keyrail secrets set openai acme-openai-dev
keyrail secrets set github acme-github-limited
keyrail secrets list
```

如果带 `--value`，Keyrail 会把值写入本地开发 backend：

```bash
keyrail secrets set openai acme-openai-dev --value "$OPENAI_API_KEY"
```

本地 backend 文件是：

```text
.keyrail/secrets.local.json
```

这个文件已被 `.gitignore` 忽略。

## 5. 配置命令策略

允许安全命令：

```bash
keyrail policy allow gh issue list
keyrail policy allow vercel deploy
```

对高风险命令要求确认：

```bash
keyrail policy require-confirm vercel deploy --prod
```

禁止危险命令：

```bash
keyrail policy deny gh repo delete
```

查看 policy：

```bash
keyrail policy show
```

## 6. 安全执行命令

通过 Keyrail 执行命令：

```bash
keyrail run -- gh issue list
```

Keyrail 会依次做这些事：

1. 校验项目身份
2. 解析 active context
3. 评估 policy
4. 将解析到的 secret 注入子进程
5. 对输出做脱敏
6. 写入 audit 事件

## 7. 保护生产环境

生产环境应该配置为 high risk：

```yaml
contexts:
  production:
    risk: high
    require_confirmation: true
    secrets:
      vercel: acme-vercel-prod
```

非交互自动化可以使用：

```bash
KEYRAIL_CONFIRM=1 keyrail run --context production -- vercel deploy --prod
```

人工执行时，Keyrail 会要求输入项目和 context 名称确认。

## 8. 使用本地 UI

启动 UI：

```bash
keyrail ui
```

打开命令输出中的 URL。UI 可以切换 context、编辑 manifest、查看 secret 引用和 audit 事件。

## 9. 给 Agent 做 Handoff

生成 Agent 可读的上下文摘要：

```bash
keyrail handoff
keyrail handoff --json
```

handoff 包含项目身份、active context、policy 和 secret 引用，不包含明文 secret。

## 10. 查看 Audit

查看最近的执行决策：

```bash
keyrail audit list
keyrail audit list --json
```

audit 记录包含 command、context、decision、注入的引用和缺失的引用，不包含明文 secret。
