// ui-check 场景：电脑玩家。真人独自建房，用标题行的图标按钮加两个电脑（一律普通），把第二个切成进阶，开局。
// 断言：加人前后添加按钮不挪位置；名单和座位铭牌的电脑徽标按强度有不同的无障碍名称（自己座位没有）；名单行不横向溢出；开局后电脑玩家在时限内自己行动（记录里出现它的行动）。
// 真人先手时电脑要等真人行动，所以轮到真人就点「收入」。
// 用法：pnpm ui-check scripts/ui-check-computer.mjs [截图目录]；英文加 LOCALE=en，手机加 MOBILE=1 W=375 H=812
export default async function computerScenario(ui) {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const count = (sel) => ui.evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  const BADGE = '.computer-badge[role=img]';
  const ADD = '.roster-head button';
  const labels = (sel) => ui.evaluate(`[...document.querySelectorAll(${JSON.stringify(`${sel} ${BADGE}`)})].map((e) => e.getAttribute('aria-label'))`);
  const addTop = () => ui.evaluate(`document.querySelector(${JSON.stringify(ADD)}).getBoundingClientRect().top`);

  await ui.goto('/');
  await ui.waitFor('input');
  await ui.type('input', 'Me');
  await ui.click('Create room|创建房间');
  await ui.waitFor(ADD);
  const top = await addTop();
  for (const n of [2, 3]) {
    await ui.evaluate(`document.querySelector(${JSON.stringify(ADD)}).click()`);
    for (let i = 0; i < 50 && (await count('.playerlist li')) < n; i += 1) await sleep(100);
  }
  assert((await count('.playerlist li')) === 3, '大厅应有 3 个座位');
  assert((await addTop()) === top, '加人后添加按钮挪了位置');
  const fresh = await labels('.playerlist');
  assert(fresh.length === 2 && fresh.every((l) => /^(Computer player|电脑玩家)$/.test(l)), `新加的电脑应都是普通：${fresh}`);

  await ui.click('^(Advanced|进阶)$', '.playerlist li:nth-child(3)');
  for (let i = 0; i < 50 && new Set(await labels('.playerlist')).size < 2; i += 1) await sleep(100);
  const lobbyLabels = await labels('.playerlist');
  assert(/^(Computer player|电脑玩家)$/.test(lobbyLabels[0]) && /^(Advanced computer player|进阶电脑玩家)$/.test(lobbyLabels[1]), `名单徽标不对：${lobbyLabels}`);
  const pressed = await ui.evaluate(`[...document.querySelectorAll('.playerlist .segmented [aria-pressed=true]')].map((b) => b.textContent)`);
  assert(pressed.length === 2 && pressed[0] !== pressed[1], `强度切换的选中态不对：${pressed}`);
  const overflow = await ui.evaluate(`[...document.querySelectorAll('.playerlist li')].some((li) => li.scrollWidth > li.clientWidth)`);
  assert(!overflow, '名单行横向溢出');
  await ui.shot('computer-lobby');

  await ui.click('Start game|开始游戏');
  await ui.waitFor('.showcase');
  await ui.evaluate(`document.querySelector('.showcase-overlay').click()`);
  await ui.waitFor('.seat.opponent .name');
  const seatLabels = await labels('.seat.opponent .name');
  assert(seatLabels.length === 2 && new Set(seatLabels).size === 2, `两个对手铭牌应有普通、进阶两种电脑徽标：${seatLabels}`);
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
  console.log('电脑玩家：', computers.join('、'), '| 徽标：', lobbyLabels.join('、'), '| 行动：', action);
}
