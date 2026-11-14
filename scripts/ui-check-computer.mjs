// ui-check 场景：电脑玩家。真人独自建房、加两个电脑玩家、开局。
// 断言：大厅列表和座位铭牌都有带无障碍名称的电脑徽标（自己座位没有）；开局后电脑玩家在时限内自己行动（记录里出现它的行动）。
// 真人先手时电脑要等真人行动，所以轮到真人就点「收入」。
// 用法：pnpm ui-check scripts/ui-check-computer.mjs [截图目录]；英文加 LOCALE=en
export default async function computerScenario(ui) {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const count = (sel) => ui.evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  const BADGE = '.computer-badge[role=img]';

  await ui.goto('/');
  await ui.waitFor('input');
  await ui.type('input', 'Me');
  await ui.click('Create room|创建房间');
  await ui.waitFor('.add-computer');
  for (let n = 2; n <= 3; n += 1) {
    await ui.click('Add computer player|添加电脑玩家');
    for (let i = 0; i < 50 && (await count('.playerlist li')) < n; i += 1) await sleep(100);
  }
  assert((await count('.playerlist li')) === 3, '大厅应有 3 个座位');
  assert((await count(`.playerlist ${BADGE}`)) === 2, '大厅列表应有 2 个电脑徽标');
  const label = await ui.evaluate(`document.querySelector('.playerlist .computer-badge').getAttribute('aria-label')`);
  assert(/^(Computer player|电脑玩家)$/.test(label), `徽标无障碍名称不对：${label}`);
  await ui.shot('computer-lobby');

  await ui.click('Start game|开始游戏');
  await ui.waitFor('.showcase');
  await ui.evaluate(`document.querySelector('.showcase-overlay').click()`);
  await ui.waitFor('.seat.opponent .name');
  assert((await count(`.seat.opponent .name ${BADGE}`)) === 2, '两个对手铭牌都应有电脑徽标');
  assert((await count(`.seat.self ${BADGE}`)) === 0, '自己座位不应有电脑徽标');
  const computers = await ui.evaluate(`[...document.querySelectorAll('.seat.opponent .name')].map((e) => e.textContent.trim())`);

  // 发牌第一步电脑多等 3 s，再加 2–6 s 行动延迟：给 20 s
  const acted = `[...document.querySelectorAll('.log-header')].map((e) => e.textContent).find((t) => ${JSON.stringify(computers)}.some((n) => t.startsWith(n)))`;
  let action = null;
  for (let i = 0; i < 200 && !action; i += 1) {
    await ui.evaluate(`[...document.querySelectorAll('.actions button:not(:disabled)')].find((b) => /^(Income|收入)$/.test(b.textContent.trim()))?.click()`);
    action = await ui.evaluate(acted);
    if (!action) await sleep(100);
  }
  assert(action, `20 s 内没看到电脑玩家（${computers.join('、')}）行动`);
  await ui.evaluate(`document.getAnimations().forEach((a) => a.finish())`);
  await ui.shot('computer-acted');
  console.log('电脑玩家：', computers.join('、'), '| 徽标：', label, '| 行动：', action);
}
