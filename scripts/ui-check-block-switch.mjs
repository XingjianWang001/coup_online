// ui-check 场景：外援被别人抢先阻挡时，控制区从「阻挡」原地换成「质疑」，不能吞掉手快点在原处的那一下。
// 机器人 A 发动外援，真人看到「用公爵阻挡」；机器人 B 抢先阻挡的瞬间，真人在原「阻挡」按钮的位置点一下。
// 断言：这一下没有发出质疑（阶段仍是等质疑），稍后再点「质疑」才生效。
// 用法：pnpm ui-check scripts/ui-check-block-switch.mjs [截图目录]
export default async function blockSwitchScenario(ui) {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const a = ui.bot();
  a.intent({ type: 'createRoom', name: 'A' });
  const { roomCode } = await a.next('joined');
  const b = ui.bot();
  b.intent({ type: 'joinRoom', roomCode, name: 'B' });
  await b.next('joined');
  await ui.joinAs('Me', roomCode);
  a.intent({ type: 'startGame' });
  await ui.waitFor('.showcase');
  await ui.evaluate(`document.querySelector('.showcase-overlay').click()`);

  const until = async (bot, pred, what) => {
    for (let i = 0; i < 100; i++) { if (bot.state.pub && pred(bot.state.pub)) return bot.state.pub; await sleep(50); }
    throw new Error(`超时：${what}`);
  };
  // 轮到真人就先收入，直到轮到 A
  for (;;) {
    const pub = await until(a, (s) => s.phase === 'choosingAction', '等行动阶段');
    const current = pub.players.find((p) => p.id === pub.currentPlayerId).name;
    if (current === 'A') break;
    if (current === 'B') b.intent({ type: 'chooseAction', action: 'income' });
    else { await ui.waitFor('.controls .actions button'); await ui.click('^收入|^Income', '.controls'); }
    await until(a, (s) => s.currentPlayerId !== pub.currentPlayerId, '换人');
  }

  a.intent({ type: 'chooseAction', action: 'foreignAid' });
  await ui.waitFor('.controls .role-btn.role--duke');
  const spot = await ui.evaluate(`(() => { const r = document.querySelector('.controls .role-btn.role--duke').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);

  b.intent({ type: 'block', role: 'duke' });
  // 控制区一换成质疑就在原阻挡按钮的位置真实点击一下（模拟手快）
  await ui.waitFor('.controls-body:not(:has(.role-btn)) .row button');
  for (const type of ['mousePressed', 'mouseReleased']) await ui.cdp('Input.dispatchMouseEvent', { type, x: spot.x, y: spot.y, button: 'left', clickCount: 1 });
  await sleep(500);
  const after = a.state.pub;
  assert(after.phase === 'awaitingChallenge' && after.challengeSubject === 'block',
    `手快的那一下被当成了质疑：阶段变成 ${after.phase}`);

  // 稍后有意点「质疑」照常生效
  await sleep(600);
  await ui.click('^(质疑！|Challenge!)$', '.controls');
  await until(a, (s) => s.phase !== 'awaitingChallenge', '有意质疑生效');
  console.log('换成质疑后误点被忽略，有意质疑生效：', a.state.pub.phase);
}
