// 部署前的房间检查（#114）：deploy-private-remote.sh 在替换容器前把控制台 /api/state 的 JSON 从 stdin 喂进来。
// busy 有真人在打 → 退出码 2，由 shell 停下来问运营者；只有 waiting → 打印提示，退出码 0；idle 或没有房间 → 不出声
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function roomCheck({ rooms }) {
  const humans = (room) => room.players.filter((p) => !p.isComputer);
  const playing = (room) => humans(room).filter((p) => room.game?.players.find((gp) => gp.id === p.id)?.alive).length;
  const present = (room) => humans(room).filter((p) => p.present).length;
  const busy = rooms.filter((r) => r.tier === 'busy').map((r) => `  ${r.code}: ${plural(playing(r), 'human')} playing`);
  const waiting = rooms.filter((r) => r.tier === 'waiting').map((r) => `  ${r.code}: ${plural(present(r), 'human')} waiting`);
  if (busy.length) return { confirm: true, lines: ['Games in progress; deploying now ends them:', ...busy, ...waiting] };
  if (waiting.length) return { confirm: false, lines: ['Players waiting in a lobby or after a game will be disconnected:', ...waiting] };
  return { confirm: false, lines: [] };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { confirm, lines } = roomCheck(JSON.parse(readFileSync(0, 'utf8')));
  for (const line of lines) console.log(line);
  process.exitCode = confirm ? 2 : 0;
}
