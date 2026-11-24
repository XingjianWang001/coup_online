// ui-check 场景：浮层是原生模态 <dialog>（showModal）。机器人建房，真人进房后先打开规则，机器人再开局。
// 断言：发牌展示叠在规则之上且只有最上层响应 Esc；Tab 不出对话框；背后页面锁住滚动；关闭后焦点回到打开它的按钮；
// 对质舞台连按 Esc（无用户激活时浏览器会跳过 cancel 直接关）也关不掉。
// 用法：pnpm ui-check scripts/ui-check-dialog.mjs [截图目录]
export default async function dialogScenario(ui) {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 带 windowsVirtualKeyCode 的 rawKeyDown 才会触发浏览器默认行为（Tab 移焦点、Esc 发 close request）
  const press = async (key, code) => {
    for (const type of ['rawKeyDown', 'keyUp']) await ui.cdp('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: code });
    await sleep(100);
  };
  const state = () => ui.evaluate(`(() => {
    const modals = [...document.querySelectorAll('dialog')].filter((d) => d.matches(':modal'));
    const top = modals.at(-1);
    return {
      modals: modals.map((d) => d.className),
      focusInTop: !!top && top.contains(document.activeElement),
      focused: document.activeElement?.textContent.trim().slice(0, 20),
      rootOverflow: getComputedStyle(document.documentElement).overflow,
    };
  })()`);

  const host = ui.bot();
  host.intent({ type: 'createRoom', name: 'Bot' });
  const { roomCode } = await host.next('joined');
  await ui.joinAs('Me', roomCode);

  // 规则：从聚焦的按钮打开，关闭后焦点要回到它
  await ui.evaluate(`(() => { const b = [...document.querySelectorAll('.header button')].find((b) => /^(Rules|规则)$/.test(b.textContent.trim())); b.focus(); b.click(); })()`);
  await ui.waitFor('.rules-overlay[open]');
  let s = await state();
  assert(s.modals.length === 1 && s.focusInTop && s.rootOverflow === 'hidden', `规则面板：${JSON.stringify(s)}`);
  for (let i = 0; i < 12; i += 1) await press('Tab', 9);
  s = await state();
  assert(s.focusInTop, `Tab 12 次后焦点跑出了规则面板：${JSON.stringify(s)}`);

  // 规则开着时开局：发牌展示后打开，应在最上层
  host.intent({ type: 'startGame' });
  await ui.waitFor('.showcase-overlay[open]');
  s = await state();
  assert(s.modals.length === 2 && s.modals[1].includes('showcase-overlay') && s.focusInTop, `发牌展示叠在规则上：${JSON.stringify(s)}`);
  await ui.shot('dialog-stacked');

  await press('Escape', 27);
  s = await state();
  assert(s.modals.length === 1 && s.modals[0].includes('rules-overlay') && s.focusInTop, `Esc 只关最上层：${JSON.stringify(s)}`);
  await press('Escape', 27);
  s = await state();
  assert(s.modals.length === 0 && s.rootOverflow !== 'hidden' && /^(Rules|规则)$/.test(s.focused), `规则关闭后：${JSON.stringify(s)}`);

  // 设置：点遮罩（对话框自身）关闭，点面板里不关
  await ui.click('^(Settings|设置)$', '.header');
  await ui.waitFor('.settings-overlay[open]');
  await ui.evaluate(`document.querySelector('.settings-panel').click()`);
  assert((await state()).modals.length === 1, '点设置面板内部不应关闭');
  await ui.evaluate(`document.querySelector('.settings-overlay').click()`);
  assert((await state()).modals.length === 0, '点遮罩应关闭设置');

  // 对质：轮到我就征税（声称公爵），机器人质疑；轮到机器人就收入
  const meId = host.state.pub.players.find((p) => p.name === 'Me').id;
  for (let i = 0; i < 20 && !(await ui.evaluate(`!!document.querySelector('.stage-overlay')`)); i += 1) {
    if (host.state.pub.currentPlayerId === meId) {
      await ui.evaluate(`[...document.querySelectorAll('.controls button:not(:disabled)')].find((b) => /^(Tax|征税)/.test(b.textContent.trim()))?.click()`);
      await sleep(300);
      host.intent({ type: 'challenge' });
    } else {
      host.intent({ type: 'chooseAction', action: 'income' });
    }
    await sleep(400);
  }
  await ui.waitFor('.stage-overlay[open]');
  for (let i = 0; i < 3; i += 1) await press('Escape', 27);
  s = await state();
  assert(s.modals.length === 1 && s.modals[0].includes('stage-overlay') && s.focusInTop, `Esc 不应关掉对质舞台：${JSON.stringify(s)}`);
  await ui.shot('dialog-showdown');
  console.log('对话框检查通过');
}
