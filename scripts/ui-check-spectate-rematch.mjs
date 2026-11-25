// ui-check 场景：真人玩家都已出局时房主再来一局（#106）。真人 Me（页面）建房当房主，机器人 Bot 加入，Me 再加两个电脑，开局。
// Bot 只按自己真有的公爵征税，Me 每次都质疑 Bot、每次都输，两次后出局；Bot 随后离开，只剩两个电脑在打。
// 断言：Bot 还在打时，出局的 Me 不显示控制区；Bot 离开后牌局仍在进行，Me 的控制区只有「再来一局」（没有等待提示和倒计时）；点了回到大厅阶段，名单上是 Me 和两个电脑。
// 服务端 COMPUTER_DELAY_MS=1500：Me 抢在电脑前面质疑，旁观时电脑也走得够慢，截得到牌局还没打完的样子。
// 发牌和先手固定（入座顺序 Me、Bot、电脑、电脑）：Me 两张女伯爵、先手，只拿收入；Bot 两张公爵
// 用法：pnpm ui-check scripts/ui-check-spectate-rematch.mjs [截图目录]；英文加 LOCALE=en
export const serverEnv = {
  COMPUTER_DELAY_MS: '1500',
  STARTING_PLAYER_RANDOM: '0',
  HANDS: JSON.stringify([['contessa', 'contessa'], ['duke', 'duke'], ['captain', 'ambassador'], ['assassin', 'captain']]),
};

export default async function spectateRematchScenario(ui) {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const count = (sel) => ui.evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  const clickIf = (pattern) => ui.evaluate(`[...document.querySelectorAll('.controls-body button:not(:disabled)')].find((b) => /${pattern}/.test(b.textContent.trim()))?.click()`);
  const REMATCH = '^(Rematch|再来一局)$';
  const rematchShown = () => ui.evaluate(`[...document.querySelectorAll('.controls-body button.primary')].some((b) => /${REMATCH}/.test(b.textContent.trim()))`);

  await ui.goto('/');
  await ui.waitFor('input');
  await ui.type('input', 'Me');
  await ui.click('Create room|创建房间');
  await ui.waitFor('.roomcode');
  const roomCode = await ui.evaluate(`document.querySelector('.roomcode b').textContent.trim()`);
  const bot = ui.bot();
  bot.intent({ type: 'joinRoom', roomCode, name: 'Bot' });
  await bot.next('joined');
  for (let i = 0; i < 50 && (await count('.playerlist li')) < 2; i += 1) await sleep(100);
  for (const n of [3, 4]) {
    await ui.evaluate(`document.querySelector('.roster-head button').click()`);
    for (let i = 0; i < 50 && (await count('.playerlist li')) < n; i += 1) await sleep(100);
  }
  assert((await count('.playerlist li')) === 4, '名单应有 4 位玩家');
  await ui.click('Start game|开始游戏');
  await ui.waitFor('.showcase');
  await ui.evaluate(`document.querySelector('.showcase-overlay').click()`);

  const meOf = (pub) => pub.players.find((p) => p.name === 'Me');
  // Bot 的一步：轮到自己就征税，别人的声称一律放过，被质疑就翻出公爵
  const botStep = () => {
    const pub = bot.state.pub;
    const id = bot.state.playerId;
    if (!pub || !pub.players.find((p) => p.id === id)?.alive) return;
    if (pub.phase === 'choosingAction' && pub.currentPlayerId === id) return bot.intent({ type: 'chooseAction', action: 'tax' });
    if (pub.phase === 'awaitingChallenge' && !pub.passed.includes(id) && (pub.challengeSubject === 'block' ? pub.pending.blockById : pub.pending.actorId) !== id) return bot.intent({ type: 'passChallenge' });
    if (pub.phase === 'awaitingBlock' && !pub.passed.includes(id) && pub.pending.actorId !== id) return bot.intent({ type: 'passBlock' });
    if (pub.phase === 'showdown' && pub.showdown.claimantId === id) return bot.intent({ type: 'revealShowdownCard', cardId: bot.state.hand.find((c) => c.role === pub.showdown.role).id });
    if (pub.phase === 'choosingLoss' && pub.lossPlayerId === id) return bot.intent({ type: 'resolveLoss', cardId: bot.state.hand[0].id });
  };
  // Me 的一步（页面）：质疑 Bot 的声称，别的都放过；失去影响力时翻第一张
  const meStep = async () => {
    const pub = bot.state.pub;
    if (pub?.phase === 'awaitingChallenge') {
      const claimant = pub.challengeSubject === 'block' ? pub.pending.blockById : pub.pending.actorId;
      await clickIf(claimant === bot.state.playerId ? '^(Challenge|质疑)$' : '^(Do not challenge|不质疑)$');
    }
    await clickIf('^(Income|收入)$');
    await clickIf('^(Do not block|不阻挡)$');
    await ui.evaluate(`(() => { const slot = document.querySelector('.stage-overlay button.stage-slot'); if (!slot) return; slot.click(); setTimeout(() => document.querySelector('.stage-overlay button.primary')?.click(), 50); })()`);
  };

  for (let i = 0; i < 400 && meOf(bot.state.pub).alive; i += 1) {
    botStep();
    await meStep();
    await sleep(150);
  }
  assert(!meOf(bot.state.pub).alive, `Me 没有出局：${JSON.stringify(bot.state.pub.players.map((p) => [p.name, p.handCount]))}`);
  assert(!(await rematchShown()), 'Bot 还在打时，出局的房主不该看到再来一局');
  // 等出局的对质或失去影响力收起
  for (let i = 0; i < 80 && (await ui.evaluate(`getComputedStyle(document.querySelector('.controls')).display`)) !== 'none'; i += 1) await sleep(100);
  await ui.shot('spectate-out');
  assert((await ui.evaluate(`getComputedStyle(document.querySelector('.controls')).display`)) === 'none', '出局后没有要作的决定，控制区应隐藏');
  bot.intent({ type: 'leaveRoom' });
  console.log('Me 已出局，Bot 离开，剩两个电脑');

  for (let i = 0; i < 30 && !(await rematchShown()); i += 1) await sleep(100);
  // 等对质舞台等过场收起，截到牌桌
  await sleep(1_500);
  await ui.evaluate(`document.querySelector('.controls').scrollIntoView({ block: 'end' })`);
  await ui.shot('spectate-rematch-table');
  const over = await count('.seat.winner');
  assert(!over, '截图时牌局已经结束，截不到旁观中的样子');
  assert(await rematchShown(), '真人玩家都已出局时，房主的控制区没有再来一局');
  const extra = await ui.evaluate(`document.querySelectorAll('.controls-body .waiting, .controls-body [role="timer"]').length`);
  assert(extra === 0, '有再来一局时控制区只放按钮，不该有等待提示或倒计时');

  await ui.click(REMATCH, '.controls-body');
  await ui.waitFor('.playerlist');
  for (let i = 0; i < 30 && (await count('.playerlist li')) !== 3; i += 1) await sleep(100);
  const names = await ui.evaluate(`[...document.querySelectorAll('.playerlist li')].map((li) => li.textContent.trim())`);
  assert(names.length === 3 && names[0].startsWith('Me'), `回到大厅后名单应是 Me 和两个电脑：${names}`);
  await ui.shot('spectate-rematch-lobby');
  console.log('旁观中再来一局，回到大厅：', names);
}
