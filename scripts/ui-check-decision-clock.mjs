// 六人真实牌局：行动、选目标、返回、质疑和放弃之后的等待共用服务器时限。
// 用法：pnpm ui-check scripts/ui-check-decision-clock.mjs [截图目录]
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export default async function decisionClockScenario(ui) {
  const names = ['阿岚', '牧星', 'Mia', '小北', '月下旅人'];
  const bots = names.map(() => ui.bot());
  const [host] = bots;
  let deadline;
  host.socket.on('publicState', message => { deadline = message.deadlineAt; });
  host.intent({ type: 'createRoom', name: names[0] });
  const { roomCode } = await host.next('joined');
  for (const [i, bot] of bots.slice(1).entries()) {
    bot.intent({ type: 'joinRoom', roomCode, name: names[i + 1] });
    await bot.next('joined');
  }
  await ui.joinAs('小林', roomCode);
  host.intent({ type: 'startGame' });
  await ui.waitFor('.showcase-overlay');
  await ui.evaluate("document.querySelector('.showcase-overlay').click()");
  await ui.waitFor('.table');

  async function advance(actor) {
    const previous = host.state.pub.currentPlayerId;
    if (actor) actor.intent({ type: 'chooseAction', action: 'income' });
    else await ui.click('^(收入|Income)$', '.controls');
    for (let i = 0; i < 100; i++) {
      if (host.state.pub.currentPlayerId !== previous) return;
      await pause(30);
    }
    throw new Error('收入后没有换人');
  }

  async function capture(label, expectedDeadline) {
    await ui.waitFor('.controls [role="timer"]');
    await pause(300);
    const state = await ui.evaluate(`(() => {
      const timer = document.querySelector('.controls [role="timer"]');
      const box = el => el.getBoundingClientRect();
      const controls = document.querySelector('.controls');
      const narration = box(document.querySelector('.narration'));
      const hand = box(document.querySelector('.seat.self .cards-row'));
      const wide = matchMedia('(width >= 720px)').matches;
      return {
        timers: document.querySelectorAll('[role="timer"]').length,
        seconds: Number.parseInt(timer.textContent),
        controlsVisible: [...controls.querySelectorAll('button,[role="timer"]')].every(el => box(el).top >= 0 && box(el).bottom <= innerHeight),
        handVisible: !wide || (hand.top >= 0 && hand.bottom <= innerHeight),
        narrationVisible: wide || narration.bottom <= box(controls).top + 1
      };
    })()`);
    if (!Number.isFinite(state.seconds) || deadline !== expectedDeadline || Math.abs(state.seconds - Math.ceil((deadline - Date.now()) / 1000)) > 1) throw new Error(label + ' 计时与服务器不符');
    if (state.timers !== 1 || !state.controlsVisible || !state.handVisible || !state.narrationVisible) throw new Error(label + ' ' + JSON.stringify(state));
    await ui.shot(label);
  }

  const myId = host.state.pub.players.find(p => p.name === '小林').id;
  while (host.state.pub.currentPlayerId !== myId) {
    await advance(bots.find(b => b.state.playerId === host.state.pub.currentPlayerId));
  }
  await ui.waitFor('.controls .actions button');
  const turnDeadline = deadline;
  await capture('choose-action', turnDeadline);
  await ui.click('^(偷窃|Steal)$', '.controls');
  await ui.waitFor('#target-heading');
  await capture('choose-target', turnDeadline);
  await ui.click('^(取消|Cancel)$', '.controls');
  await capture('back-to-actions', turnDeadline);
  await advance(null);

  const next = bots.find(b => b.state.playerId === host.state.pub.currentPlayerId);
  next.intent({ type: 'chooseAction', action: 'foreignAid' });
  await ui.waitFor('.controls .role-btn');
  await capture('block', deadline);
  bots.find(b => b !== next).intent({ type: 'block', role: 'duke' });
  await ui.waitFor('.controls .row button:not(.role-btn):not(.ghost)');
  const challengeDeadline = deadline;
  await capture('challenge', challengeDeadline);
  await ui.click('^(不质疑|Do not challenge)$', '.controls');
  await ui.waitFor('.controls .waiting');
  await capture('waiting', challengeDeadline);
  await ui.cdp('Page.reload');
  await ui.waitFor('.controls .waiting [role="timer"]');
  await capture('rejoined', challengeDeadline);
  for (const bot of bots) bot.intent({ type: 'leaveRoom' });
  await ui.waitFor('.notice.big');
  if (await ui.evaluate("!!document.querySelector('[role=timer]')")) throw new Error('终局仍显示决策倒计时');
}
