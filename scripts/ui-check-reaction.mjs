// ui-check 场景：表态。机器人对真人发一条行动预告，真人从表态面板发一条短语。
// 断言：对手铭牌亮起、只有行动名上角色色、目标是真人昵称；短语页是当前语言的 7 句、每行排满、不溢出；标签页支持 ←/→/Home/End；真人自己的铭牌经服务器转发后亮起，座位尺寸不变。
// 用法：pnpm ui-check scripts/ui-check-reaction.mjs [截图目录]；手机布局加 MOBILE=1 W=390 H=844；中英文各跑一遍加 LOCALE=zh-CN / LOCALE=en
export default async function reactionScenario(ui) {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const host = ui.bot();
  host.intent({ type: 'createRoom', name: 'Bot' });
  const { roomCode } = await host.next('joined');
  const other = ui.bot();
  other.intent({ type: 'joinRoom', roomCode, name: 'Van' });
  await other.next('joined');
  await ui.joinAs('Me', roomCode);
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

  // 短语页：当前语言的 7 句，每行排满到右边缘（没有空洞），文字不溢出
  await ui.evaluate(`Promise.all(document.querySelector('.reaction-collapse').getAnimations().map((a) => a.finished))`);
  const page = await ui.evaluate(`(() => {
    const grid = document.querySelector('.reaction-grid');
    const buttons = [...grid.querySelectorAll('button')];
    const right = grid.getBoundingClientRect().right;
    const rowEnds = new Map(buttons.map((b) => [b.offsetTop, b.getBoundingClientRect().right]));
    return {
      texts: buttons.map((b) => b.textContent),
      holes: [...rowEnds.values()].filter((end) => Math.abs(end - right) > 1).length,
      overflow: grid.scrollWidth > grid.clientWidth || buttons.some((b) => b.scrollWidth > b.clientWidth),
    };
  })()`);
  const expected = {
    'zh-CN': ['我信你个鬼', '你确定？', '来质疑我啊', '我是老实人', '手下留情', '好险', '佩服'],
    en: ['Yeah, right.', 'You sure?', 'Go on, challenge me.', "I'm an honest player.", 'Have mercy.', 'That was close.', 'Well played.'],
  };
  await ui.evaluate(`document.querySelector('.reaction-tray').scrollIntoView({ block: 'center' })`);
  await ui.shot('reaction-phrases');
  const locales = process.env.LOCALE ? [process.env.LOCALE] : Object.keys(expected);
  assert(locales.some((l) => JSON.stringify(expected[l]) === JSON.stringify(page.texts)), `短语页应是 7 句预设，实际 ${JSON.stringify(page.texts)}`);
  assert(page.holes === 0, `短语页有 ${page.holes} 行没排满`);
  assert(!page.overflow, '短语页有文字溢出');

  // 标签页键盘：只有选中的标签在 Tab 序列里，←/→/Home/End 切换并带走焦点，面板由选中的标签命名
  const press = async (key, code) => {
    for (const type of ['rawKeyDown', 'keyUp']) await ui.cdp('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: code });
  };
  const tabs = `(() => ({
    focused: document.activeElement.id,
    selected: document.querySelector('[role="tab"][aria-selected="true"]').id,
    tabbable: [...document.querySelectorAll('[role="tab"]')].filter((t) => t.tabIndex === 0).length,
    panel: document.querySelector('[role="tabpanel"]').getAttribute('aria-labelledby'),
  }))()`;
  await ui.evaluate(`document.querySelector('#reaction-tab-phrase').focus()`);
  for (const [key, code, id] of [['ArrowRight', 39, 'announcement'], ['End', 35, 'verbalClaim'], ['ArrowRight', 39, 'phrase'], ['ArrowLeft', 37, 'verbalClaim'], ['Home', 36, 'phrase']]) {
    await press(key, code);
    const t = await ui.evaluate(tabs);
    const want = `reaction-tab-${id}`;
    assert(t.focused === want && t.selected === want && t.panel === want && t.tabbable === 1, `${key} 后应选中 ${id}：${JSON.stringify(t)}`);
  }

  await ui.evaluate(`[...document.querySelectorAll('.reaction-grid button')].find((b) => /你确定|You sure/.test(b.textContent)).click()`);
  await ui.waitFor('.seat.self .nameplate.speaking');
  const after = await ui.evaluate(seatBox);
  assert(before === after, `说话时自己的座位尺寸变了：${before} → ${after}`);
  const trayClosed = await ui.evaluate(`!document.querySelector('.reaction.open') && document.querySelector('.reaction-collapse').hasAttribute('inert')`);
  assert(trayClosed, '发出后表态面板应收起且 inert');

  // 截图前把动画定在铭牌上的表态完全显示的时刻
  await ui.evaluate(`document.getAnimations().forEach((a) => { a.pause(); a.currentTime = 900; })`);
  await ui.evaluate(`document.querySelector('.seat.self').scrollIntoView({ block: 'center' })`);
  await ui.shot('reaction');
  console.log('表态：', opponent.text, '| 自己座位', after);
}
