// ui-check 场景：触屏没有悬浮，行动气泡和牌名要能用手指看到。
// 长按行动按钮弹出气泡、松手不算点了行动（置灰的政变也能长按）；点一下自己的牌换成牌名，过一会儿自己收起；普通点按照常发起行动。
// 用法：MOBILE=1 W=390 H=844 pnpm ui-check scripts/ui-check-touch-tips.mjs [截图目录]
export const serverEnv = {
  STARTING_PLAYER_RANDOM: '0',
  HANDS: JSON.stringify([['contessa', 'assassin'], ['duke', 'captain']]),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function touchTipsScenario(ui) {
  if (!(await ui.evaluate("matchMedia('(hover: none)').matches"))) throw new Error('要用 MOBILE=1 跑：这个场景只测触屏');
  const host = ui.bot();
  host.intent({ type: 'createRoom', name: 'Bot' });
  const { roomCode } = await host.next('joined');
  await ui.joinAs('Me', roomCode);
  host.intent({ type: 'startGame' });
  await ui.waitFor('.showcase');
  await ui.evaluate(`document.querySelector('.showcase-overlay').click()`);
  await ui.waitFor('.table');
  host.intent({ type: 'chooseAction', action: 'income' });
  await ui.waitFor('.controls .actions');
  await sleep(600); // 等控制区过了 inert 的 500ms

  const center = (expr) => ui.evaluate(`(() => { const r = (${expr}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const touch = async (type, at) => ui.cdp('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [at] });
  const anchorOf = (name) => `[...document.querySelectorAll('.action-tip-anchor')].find((a) => new RegExp(${JSON.stringify(name)}).test(a.querySelector('button').textContent))`;
  const failures = [];

  for (const [name, label] of [['^(征税|Tax)$', 'tax'], ['^(政变|Coup)$', 'coup-disabled']]) {
    const at = await center(anchorOf(name));
    await touch('touchStart', at);
    await sleep(650);
    const shown = await ui.evaluate(`(() => { const a = ${anchorOf(name)}; return a.classList.contains('open') && getComputedStyle(a.querySelector('.action-tip')).opacity === '1'; })()`);
    if (!shown) failures.push(`长按 ${label} 没有弹出气泡`);
    await ui.shot(`long-press-${label}`);
    await touch('touchEnd', at);
    await sleep(400);
    if (await ui.evaluate(`!!document.querySelector('.action-tip-anchor.open')`)) failures.push(`松开 ${label} 后气泡没收起`);
    if (!(await ui.evaluate(`!!document.querySelector('.controls .actions')`)) || host.state.pub.phase !== 'choosingAction') failures.push(`长按 ${label} 被当成点了行动`);
  }

  const card = await center(`document.querySelector('.seat.self .card')`);
  await touch('touchStart', card);
  await touch('touchEnd', card);
  await sleep(250);
  if (!(await ui.evaluate(`getComputedStyle(document.querySelector('.seat.self .card .card-name')).opacity === '1'`))) failures.push('点自己的牌没有换成牌名');
  await ui.shot('tap-own-card');
  await sleep(2300);
  if (await ui.evaluate(`!!document.querySelector('.seat.self .card.peek')`)) failures.push('牌名没有自己收起');

  const income = await center(anchorOf('^(收入|Income)$'));
  await touch('touchStart', income);
  await touch('touchEnd', income);
  for (let i = 0; i < 30 && host.state.pub.phase === 'choosingAction' && host.state.pub.currentPlayerId !== host.state.playerId; i++) await sleep(100);
  if (host.state.pub.currentPlayerId !== host.state.playerId) failures.push('普通点按收入没有发起行动');

  if (failures.length) throw new Error(failures.join('；'));
}
