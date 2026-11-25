// ui-check 场景：赢家的胜利曲（CONTEXT.md「背景音乐」）。真人 Me 和机器人 Bot 单挑：Bot 先手、没有公爵却每回合声称征税，
// Me 每次都质疑，Bot 两次被抓后出局。页面载入前装一个探针，记下每个声源的开始时刻和每个增益的排程。
// 断言：赢了下一拍胜利曲就从第 1 小节整个进来，主循环的分轨从那一拍起 1 s 落到 0；
// Bot（房主）再来一局后，下一拍起交叉淡变：主循环在那一拍从第 1 小节重新起、1 s 进场，胜利曲 2 s 退场。
// 用法：pnpm ui-check scripts/ui-check-victory.mjs [截图目录]
export const serverEnv = {
  STARTING_PLAYER_RANDOM: '0',
  HANDS: JSON.stringify([['captain', 'captain'], ['duke', 'duke']]),
};

// 分轨按解码后的时长认：主循环 193 s，胜利曲 49 s（都含首尾各 0.5 s 的保护段）
const PROBE = `
window.__music = [];
const loopOf = new WeakMap();
const log = (e) => window.__music.push(e);
const connect = AudioNode.prototype.connect;
AudioNode.prototype.connect = function (dest, ...rest) {
  if (this instanceof AudioBufferSourceNode && dest instanceof GainNode) loopOf.set(dest.gain, Math.round(this.buffer.duration));
  return connect.call(this, dest, ...rest);
};
const start = AudioBufferSourceNode.prototype.start;
AudioBufferSourceNode.prototype.start = function (when, offset) {
  log({ kind: 'start', loop: Math.round(this.buffer.duration), t: when, offset, now: this.context.currentTime });
  return start.call(this, when, offset);
};
for (const kind of ['setValueAtTime', 'linearRampToValueAtTime']) {
  const original = AudioParam.prototype[kind];
  AudioParam.prototype[kind] = function (v, t) {
    if (loopOf.has(this)) log({ kind, loop: loopOf.get(this), v, t });
    return original.call(this, v, t);
  };
}`;

const BAR = 3;
const BEAT = 0.75;
const VICTORY = 49;
const MAIN = 193;
const near = (a, b) => Math.abs(a - b) < 1e-6;
const onBeat = (t) => near(t / BEAT, Math.round(t / BEAT)); // AudioContext 新建时 currentTime 为 0，就是 origin

export default async function victoryScenario(ui) {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const events = () => ui.evaluate('window.__music');
  const waitFor = async (what, test) => {
    for (let i = 0; i < 100; i++) {
      const found = test(await events());
      if (found) return found;
      await sleep(100);
    }
    throw new Error(`没等到：${what}`);
  };
  await ui.cdp('Page.enable');
  await ui.cdp('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });

  const bot = ui.bot();
  bot.intent({ type: 'createRoom', name: 'Bot' });
  const { roomCode } = await bot.next('joined');
  await ui.joinAs('Me', roomCode);
  // 真实的一次点按：页面拿到用户激活，AudioContext 才真的跑起来
  for (const type of ['mousePressed', 'mouseReleased']) await ui.cdp('Input.dispatchMouseEvent', { type, x: 5, y: 5, button: 'left', clickCount: 1 });
  bot.intent({ type: 'startGame' });
  await ui.waitFor('.showcase');
  await ui.evaluate(`document.querySelector('.showcase-overlay').click()`);
  // 七条都载入再开打，免得胜利曲还没解码、赢了先维持原来的配器
  for (let i = 0; i < 100 && (await ui.evaluate(`performance.getEntriesByType('resource').filter((e) => /\\.mp3$/.test(e.name) && e.responseEnd > 0).length`)) < 7; i++) await sleep(100);
  await sleep(1000);

  const clickIf = (pattern) => ui.evaluate(`[...document.querySelectorAll('.controls-body button:not(:disabled)')].find((b) => /${pattern}/.test(b.textContent.trim()))?.click()`);
  for (let i = 0; i < 300 && bot.state.pub?.phase !== 'gameOver'; i++) {
    const pub = bot.state.pub;
    const id = bot.state.playerId;
    if (pub.phase === 'choosingAction' && pub.currentPlayerId === id) bot.intent({ type: 'chooseAction', action: 'tax' });
    if (pub.phase === 'showdown' && pub.showdown.claimantId === id) bot.intent({ type: 'revealShowdownCard', cardId: bot.state.hand[0].id });
    await clickIf('^(Challenge|质疑)$');
    await clickIf('^(Income|收入)$');
    await sleep(150);
  }
  const me = bot.state.pub.players.find((p) => p.name === 'Me');
  assert(bot.state.pub.phase === 'gameOver' && bot.state.pub.winnerId === me.id, `Me 没有赢：${bot.state.pub.phase} ${bot.state.pub.winnerId}`);
  assert(await ui.evaluate(`(() => { const c = new AudioContext(); const ok = navigator.userActivation.hasBeenActive; c.close(); return ok; })()`), '页面没拿到用户激活，AudioContext 不会走');

  // 进胜利曲
  const enter = await waitFor('胜利曲开始', (es) => es.find((e) => e.kind === 'start' && e.loop === VICTORY));
  let es = await events();
  assert(near(enter.offset, 0.5), `胜利曲没有从第 1 小节放：offset ${enter.offset}`);
  const delay = enter.t - enter.now;
  assert(delay <= BEAT + 0.02 && onBeat(enter.t), `胜利曲排程后 ${delay.toFixed(2)} s 才进来（${enter.t} s），应在下一拍`);
  const fadedOut = es.filter((e) => e.kind === 'linearRampToValueAtTime' && e.loop === MAIN && near(e.t, enter.t + 1));
  assert(fadedOut.length > 0 && fadedOut.every((e) => e.v === 0), `主循环没有从那一拍起 1 s 落到 0：${JSON.stringify(fadedOut)}`);
  const up = es.find((e) => e.kind === 'linearRampToValueAtTime' && e.loop === VICTORY && e.v > 0);
  assert(up && near(up.t, enter.t + 0.02), `胜利曲没有在强拍上整个进来：${JSON.stringify(up)}`);
  await ui.shot('victory');

  // 再来一局：下一拍起交叉淡变，主循环在那一拍从第 1 小节重新起。先等胜利曲真的响起来（最多一小节加一拍之后）
  await sleep((BAR + 1) * 1000);
  const before = es.length;
  bot.intent({ type: 'rematch' });
  const out = await waitFor('胜利曲退场', (all) => all.slice(before).find((e) => e.kind === 'linearRampToValueAtTime' && e.loop === VICTORY && e.v === 0));
  es = (await events()).slice(before);
  const restarts = es.filter((e) => e.kind === 'start' && e.loop === MAIN);
  assert(restarts.length === 6 && restarts.every((e) => near(e.t, restarts[0].t) && near(e.offset, 0.5)), `主循环没有一齐从第 1 小节重新起：${JSON.stringify(restarts)}`);
  const handover = restarts[0].t;
  assert(handover - restarts[0].now <= 0.75 + 0.02 && near((handover - enter.t) / 0.75, Math.round((handover - enter.t) / 0.75)), `交接点不是紧接着的下一拍：排程时 ${restarts[0].now}，交接 ${handover}`);
  const fadeFrom = es.findLast((e) => e.kind === 'setValueAtTime' && e.loop === VICTORY && e.t < out.t);
  assert(fadeFrom.v > 0 && near(fadeFrom.t, handover) && near(out.t, handover + 2), `胜利曲没有从交接点起 2 s 退场：${JSON.stringify([fadeFrom, out])}`);
  const lobby = es.filter((e) => e.loop === MAIN && e.kind === 'linearRampToValueAtTime' && e.v > 0);
  assert(lobby.length === 1 && near(lobby[0].t, handover + 1), `大厅配器没有从交接点起 1 s 进场：${JSON.stringify(lobby)}`);
  assert(es.some((e) => e.kind === 'setValueAtTime' && e.loop === MAIN && near(e.t, handover)), '大厅配器的进场不是从交接点起');
  console.log(`✓ 赢了 ${delay.toFixed(2)} s 后胜利曲进来（主循环 ${fadedOut.length} 条 1 s 落到 0）；再来一局 ${(handover - restarts[0].now).toFixed(2)} s 后交叉淡变回主循环第 1 小节，重叠 ${(out.t - fadeFrom.t).toFixed(2)} s`);
}
