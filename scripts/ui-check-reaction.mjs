// ui-check 场景：表态。机器人对真人发一条行动预告，真人从表态面板发一条短语。
// 断言：对手铭牌亮起、只有行动名上角色色、目标是真人昵称；真人自己的铭牌经服务器转发后亮起，座位尺寸不变。
// 用法：pnpm ui-check scripts/ui-check-reaction.mjs [截图目录]；手机布局加 MOBILE=1 W=390 H=844
export default async function reactionScenario(ui) {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const host = ui.bot();
  host.intent({ type: 'createRoom', name: 'Bot' });
  const { roomCode } = await host.next('joined');
  const other = ui.bot();
  other.intent({ type: 'joinRoom', roomCode, name: 'Van' });
  await other.next('joined');
  await ui.joinAs('Me', roomCode);
  await host.next('lobby');
  host.intent({ type: 'startGame' });
  await ui.waitFor('.showcase');
  await ui.evaluate(`document.querySelector('.showcase-overlay').click()`);
  await ui.waitFor('.seat.self .nameplate');

  // 机器人 Van 预告暗杀真人
  const pub = other.state.pub ?? (await other.next('publicState')).state;
  const me = pub.players.find((p) => p.name === 'Me');
  other.intent({ type: 'react', reaction: { kind: 'announcement', action: 'assassinate', targetId: me.id } });
  await ui.waitFor('.seat.opponent .nameplate.speaking');
  const opponent = await ui.evaluate(`(() => {
    const plate = document.querySelector('.seat.opponent .nameplate.speaking');
    return {
      text: plate.textContent,
      roles: [...plate.querySelectorAll('.nameplate-role')].map((e) => e.className + ':' + e.textContent),
      target: plate.querySelector('.nameplate-target')?.textContent,
      seat: plate.closest('.seat').querySelector('.name').textContent,
    };
  })()`);
  assert(opponent.seat === 'Van', `表态应出现在 Van 的座位，实际在 ${opponent.seat}`);
  assert(opponent.target === 'Me', `预告目标应是 Me，实际 ${opponent.target}`);
  assert(opponent.roles.length === 1 && opponent.roles[0].includes('role--assassin'), `只有「暗杀」上刺客色：${JSON.stringify(opponent.roles)}`);

  // 真人从面板发短语：自己的铭牌经服务器转发后亮起，座位尺寸不变
  const seatBox = `JSON.stringify((({ width, height }) => ({ width, height }))(document.querySelector('.seat.self').getBoundingClientRect()))`;
  const before = await ui.evaluate(seatBox);
  await ui.evaluate(`document.querySelector('.reaction-toggle').click()`);
  await ui.evaluate(`[...document.querySelectorAll('.reaction-grid button')].find((b) => /你确定|You sure/.test(b.textContent)).click()`);
  await ui.waitFor('.seat.self .nameplate.speaking');
  const after = await ui.evaluate(seatBox);
  assert(before === after, `说话时自己的座位尺寸变了：${before} → ${after}`);
  const trayClosed = await ui.evaluate(`!document.querySelector('.reaction.open') && document.querySelector('.reaction-collapse').hasAttribute('inert')`);
  assert(trayClosed, '发出后表态面板应收起且 inert');

  // 截图前把动画定在气泡完全显示的时刻
  await ui.evaluate(`document.getAnimations().forEach((a) => { a.pause(); a.currentTime = 900; })`);
  await ui.evaluate(`document.querySelector('.seat.self').scrollIntoView({ block: 'center' })`);
  await ui.shot('reaction');
  console.log('表态：', opponent.text, '| 自己座位', after);
}
