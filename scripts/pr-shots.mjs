// 把截图传到 GitHub，打印可以直接贴进 PR 正文的 Markdown 图片链接。gh 不能上传图片附件，所以换个地方放。
// 用法：pnpm pr-shots <PR号> <图片>... ，图片名即链接里的名字，例如 before.png、after.png
//
// 截图提交到孤儿分支 pr-assets 的 pr-<号>/ 目录下，链接钉在这次提交上，以后再传也不会变。
// 只用 git 底层命令（临时索引 + commit-tree + push），不切分支、不建 worktree，工作区停在哪个分支都行。
// 仓库是公开的：截图会永久留在 pr-assets 的历史里，不要截有私人信息的画面。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const BRANCH = 'pr-assets';
const [pr, ...files] = process.argv.slice(2);
if (!/^\d+$/.test(pr ?? '') || files.length === 0) {
  console.error('用法：pnpm pr-shots <PR号> <图片>...');
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'pr-shots-'));
const env = { ...process.env, GIT_INDEX_FILE: join(tmp, 'index') };
// stderr 不直接打印（首次运行时 fetch 找不到分支属于正常情况）；命令真失败时错误信息里带着它
const git = (...args) => execFileSync('git', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

try {
  const repo = git('remote', 'get-url', 'origin').match(/github\.com[:/](.+?)(?:\.git)?$/)?.[1];
  if (!repo) throw new Error('origin 不是 GitHub 仓库');

  // 分支还不存在时从空树开始
  let parent = null;
  try {
    git('fetch', '--quiet', 'origin', BRANCH);
    parent = git('rev-parse', 'FETCH_HEAD');
  } catch {}
  if (parent) git('read-tree', parent);

  const names = files.map((file) => {
    const name = basename(file);
    const blob = git('hash-object', '-w', resolve(file));
    git('update-index', '--add', '--cacheinfo', `100644,${blob},pr-${pr}/${name}`);
    return name;
  });
  const tree = git('write-tree');
  const commit = git('commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `chore: add screenshots for PR #${pr}`);
  git('push', '--quiet', 'origin', `${commit}:refs/heads/${BRANCH}`);

  for (const name of names) {
    console.log(`![${name.replace(/\.\w+$/, '')}](https://raw.githubusercontent.com/${repo}/${commit}/pr-${pr}/${encodeURIComponent(name)})`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
