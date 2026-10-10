# 本地 PR 审核工作流

Claude Code（用你的 Claude 订阅）生成审核报告，你读完、改完、确认之后，再用 `gh` 发布到 GitHub PR。不需要另外付费的 API Key。

```
PR 号 ──gh──▶ 拉取 base 和 PR head ──▶ 临时只读 worktree
          ──claude -p（只读工具）──▶ .pr-reviews/pr-<号>-<时间>.md
          ──你查看/编辑──▶ 确认 ──gh──▶ PR 评论 / Approve / Request changes
```

## 安装（一次性）

```bash
brew install gh jq                      # macOS；git 已自带
npm install -g @anthropic-ai/claude-code  # 或使用官方安装脚本
claude                                  # 首次运行，用 /login 登录 Claude Pro/Max 订阅
gh auth login                           # 登录 GitHub，需要 repo 权限
chmod +x scripts/pr-review/review.sh
```

确认用的是订阅而不是 API Key：脚本会自动 `unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN`，所以只要 `claude` 交互模式下已经登录了订阅就行。

## 使用

```bash
# 用 PR 自己的 base 审核
scripts/pr-review/review.sh 21

# 指定 base：main、dev，或任意远端分支
scripts/pr-review/review.sh 21 -b main
scripts/pr-review/review.sh 21 -b dev
scripts/pr-review/review.sh 21 -b release/1.0

# 也可以直接传 PR 链接；用 -m 指定模型
scripts/pr-review/review.sh https://github.com/XingjianWang001/coup_online/pull/21 -m opus

# 只生成报告，稍后再手动发布
scripts/pr-review/review.sh 21 --no-publish
gh pr comment 21 --body-file .pr-reviews/pr-21-<时间>.md
```

生成报告后，脚本会先用 `$PAGER`（默认 `less`）打开报告，然后提示你选择：

| 键 | 动作 |
|---|---|
| `c` | 作为普通评论发布（`gh pr comment`） |
| `a` | 作为 Approve review 发布（发布前重新核对 CI，未全绿则拒绝；不能 approve 自己的 PR） |
| `r` | 作为 Request changes review 发布（自己的 PR 同样不行） |
| `e` | 用 `$EDITOR`（默认 `vi`）编辑报告 |
| `v` | 重新查看报告 |
| `q` | 不发布，报告留在本地 |

**不经过你的确认，什么都不会发布。** 报告保存在 `.pr-reviews/`，这个目录已经加入 `.gitignore`。

## 原理与安全

- **base 可选**：脚本先拉取 `<remote>/<base>` 和 `refs/pull/<号>/head`（fork 来的 PR 也能用），再计算 merge-base，审核 `merge-base..PR head` 的三点 diff。也就是说，即使你换了 base，看到的也只是 PR 相对这个 base 新增的改动。
- **能读完整代码**：Claude 在 PR head 的临时 worktree 里运行，可以读完整文件、查调用方。diff 超过 150KB 时（可用 `PR_REVIEW_MAX_DIFF` 调整），diff 不再内嵌进提示词，改由 Claude 按文件运行 `git diff` 读取。
- **CI 是硬门槛**：`gh pr checks` 的结果会交给 Claude。CI 失败、未跑完或没有结果时，结论不能是 ✅。
- **只读**：只开放 `Read/Grep/Glob` 和 `git diff/log/show/blame`。`--permission-mode dontAsk` 会直接拒绝其他调用，PR 里即使有提示词注入，也改不了文件、执行不了命令。
- **自动清理**：退出时自动删除临时 worktree 和 `refs/pr-review/*`，不影响你当前分支和工作区。

## 自定义

- 审核规则、严重级别、输出格式：编辑 `scripts/pr-review/rules.md`，它会作为系统提示追加给 Claude。
- 远端不叫 `origin`：`PR_REVIEW_REMOTE=upstream scripts/pr-review/review.sh 21`
- 起个别名：`alias prr="$(git rev-parse --show-toplevel)/scripts/pr-review/review.sh"`

## 常见问题

- **`拉取失败`**：base 分支在远端不存在，或者 PR 号写错了。
- **`Claude Code 运行失败`**：先直接运行 `claude` 确认能用。订阅额度用完时需要等额度重置。
- **大 PR 很慢**：可以用 `-m sonnet` 换更快的模型，或者让作者把 PR 拆小。
