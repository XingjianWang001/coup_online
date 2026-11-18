// ui-check 场景：电脑获胜后的赛后揭晓和表态（#77）。机器人 Bot 建房、加 2 个电脑，真人 Me（页面）加入。
// Bot 只按自己真有的牌声称，Me 每次都质疑 Bot、每次都输，两次后出局但留在房里看；Bot 随后离开，两个电脑打完。
// 断言：电脑获胜后，获胜者的暗牌在约 3 秒、再隔约 2 秒时逐张翻开；输掉的电脑座位上出现短语。
// 服务端以 SPEECH_RANDOM=0 启动（电脑每个能开口的时刻都开口、赛后揭晓两张都揭，结束后 1 秒说），COMPUTER_DELAY_MS=300 让电脑快走。
// 用法：pnpm ui-check scripts/ui-check-after-game.mjs [截图目录]；英文加 LOCALE=en
export const serverEnv = { SPEECH_RANDOM: '0', COMPUTER_DELAY_MS: '300' };

export default async function afterGameScenario(ui) {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clickIf = (pattern) => ui.evaluate(`[...document.querySelectorAll('.controls-body button:not(:disabled)')].find((b) => /${pattern}/.test(b.textContent.trim()))?.click()`);

  const bot = ui.bot();
  bot.intent({ type: 'createRoom', name: 'Bot' });
  const { roomCode } = await bot.next('joined');
  let seated = 0;
  bot.socket.on('lobby', (m) => (seated = m.players.length));
  bot.intent({ type: 'addComputer' });
  bot.intent({ type: 'addComputer' });
  await ui.joinAs('Me', roomCode);
  for (let i = 0; i < 100 && seated < 4; i += 1) await sleep(100);
  assert(seated === 4, `大厅里应有 4 人：${seated}`);
  bot.intent({ type: 'startGame' });
  await ui.waitFor('.showcase');
  await ui.evaluate(`document.querySelector('.showcase-overlay').click()`);

  const meOf = (pub) => pub.players.find((p) => p.name === 'Me');
  // Bot 的一步：轮到自己时按真有的牌声称（对着 Me），别人的声称一律放过，被质疑就翻出声称的那张
  const botStep = () => {
    const pub = bot.state.pub;
    const id = bot.state.playerId;
    const roles = bot.state.hand.map((c) => c.role);
    const me = meOf(pub);
    const self = pub.players.find((p) => p.id === id);
    if (!self?.alive) return;
    if (pub.phase === 'choosingAction' && pub.currentPlayerId === id) {
      if (self.coins >= 10) return bot.intent({ type: 'chooseAction', action: 'coup', targetId: me.alive ? me.id : pub.players.find((p) => p.alive && p.id !== id).id });
      if (roles.includes('duke')) return bot.intent({ type: 'chooseAction', action: 'tax' });
      if (roles.includes('captain') && me.alive) return bot.intent({ type: 'chooseAction', action: 'steal', targetId: me.id });
      if (roles.includes('assassin') && self.coins >= 3 && me.alive) return bot.intent({ type: 'chooseAction', action: 'assassinate', targetId: me.id });
      if (roles.includes('ambassador')) return bot.intent({ type: 'chooseAction', action: 'exchange' });
      return bot.intent({ type: 'chooseAction', action: 'income' });
    }
    if (pub.phase === 'awaitingChallenge' && !pub.passed.includes(id) && (pub.challengeSubject === 'block' ? pub.pending.blockById : pub.pending.actorId) !== id) return bot.intent({ type: 'passChallenge' });
    if (pub.phase === 'awaitingBlock' && !pub.passed.includes(id) && pub.pending.actorId !== id) return bot.intent({ type: 'passBlock' });
    if (pub.phase === 'showdown' && pub.showdown.claimantId === id) return bot.intent({ type: 'revealShowdownCard', cardId: bot.state.hand.find((c) => c.role === pub.showdown.role).id });
    if (pub.phase === 'choosingLoss' && pub.lossPlayerId === id) return bot.intent({ type: 'resolveLoss', cardId: bot.state.hand[0].id });
    if (pub.phase === 'choosingExchange' && pub.pending.actorId === id) return bot.intent({ type: 'resolveExchange', keepIds: bot.state.hand.slice(0, pub.exchangeKeepCount).map((c) => c.id) });
  };
  // Me 的一步（页面）：质疑 Bot 的声称，别的都放过；失去影响力时翻第一张
  const meStep = async () => {
    const pub = bot.state.pub;
    if (pub.phase === 'awaitingChallenge') {
      const claimant = pub.challengeSubject === 'block' ? pub.pending.blockById : pub.pending.actorId;
      await clickIf(claimant === bot.state.playerId ? '^(Challenge!|质疑！)$' : '^(Do not challenge|不质疑)$');
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
  assert(!meOf(bot.state.pub).alive, '60 s 内 Me 没有出局');
  assert(bot.state.pub.phase !== 'gameOver', `Me 出局时牌局已结束：${bot.state.pub.winnerId}`);
  bot.intent({ type: 'leaveRoom' });
  console.log('Me 已出局，Bot 离开，剩两个电脑');

  // 两个电脑各 300 ms 一步打完。页面上找获胜者的翻开的暗牌和各座位的铭牌
  const look = `(() => {
    const seats = [...document.querySelectorAll('.seat.opponent')].map((s) => ({
      name: s.querySelector('.name').textContent.trim(),
      computer: !!s.querySelector('.computer-badge'),
      revealed: s.querySelectorAll('.card.post-game-revealed').length,
      says: s.querySelector('.nameplate.speaking')?.textContent ?? null,
    }));
    return { seats, over: !![...document.querySelectorAll('button')].find((b) => /^(Play again|再来一局)$/.test(b.textContent.trim())) };
  })()`;
  let view = await ui.evaluate(look);
  for (let i = 0; i < 600 && !view.over; i += 1) {
    await sleep(100);
    view = await ui.evaluate(look);
  }
  assert(view.over, '60 s 内两个电脑没有打完');
  const start = Date.now();
  const timeline = [];
  let shots = 0;
  while (Date.now() - start < 7_000) {
    view = await ui.evaluate(look);
    const revealed = Math.max(...view.seats.map((s) => s.revealed));
    const said = view.seats.filter((s) => s.says).map((s) => `${s.name}: ${s.says}`);
    const last = timeline.at(-1);
    if (!last || last.revealed !== revealed || last.said.join() !== said.join()) {
      timeline.push({ at: Date.now() - start, revealed, said });
      await ui.shot(`after-game-${++shots}`);
    }
    await sleep(100);
  }
  console.log(JSON.stringify(timeline, null, 1));
  const winner = view.seats.find((s) => s.revealed > 0);
  assert(winner?.computer, `获胜的电脑没有揭晓暗牌：${JSON.stringify(view.seats)}`);
  const firstAt = timeline.find((t) => t.revealed >= 1)?.at;
  const secondAt = timeline.find((t) => t.revealed >= 2)?.at;
  assert(firstAt !== undefined && secondAt !== undefined, `应逐张揭晓两张：${JSON.stringify(timeline)}`);
  assert(secondAt - firstAt >= 1_500, `两张不是隔约 2 秒揭晓：${firstAt} → ${secondAt}`);
  const loser = view.seats.find((s) => s.computer && s !== winner);
  assert(timeline.some((t) => t.said.some((line) => line.startsWith(loser.name))), `输掉的电脑 ${loser.name} 座位上没有出现短语：${JSON.stringify(timeline)}`);
  console.log('获胜的电脑', winner.name, '在', firstAt, '和', secondAt, 'ms 揭晓；输掉的电脑', loser.name, '开口');
}
