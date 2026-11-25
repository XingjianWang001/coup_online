// ui-check 场景：牌局提示条。Bot 诈称公爵征税、真人质疑，Bot 翻错牌失去影响力。
// 断言：「Bot 失去影响力」等对质舞台收起才出现（舞台挡着时不耗掉它的时长），停满约 4 秒；
// 进场从屏幕上沿滑下（第一帧整条在视口外），退场滑回上沿再消失。
// 用法：pnpm ui-check scripts/ui-check-notice.mjs [截图目录]；手机布局加 MOBILE=1 W=390 H=844
export const serverEnv = {
  STARTING_PLAYER_RANDOM: '0',
  HANDS: JSON.stringify([['contessa', 'assassin'], ['duke', 'captain']]),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function noticeScenario(ui) {
  const host = ui.bot();
  host.intent({ type: 'createRoom', name: 'Bot' });
  const { roomCode } = await host.next('joined');
  await ui.joinAs('Me', roomCode);
  host.intent({ type: 'startGame' });
  await ui.waitFor('.showcase');
  await ui.evaluate(`document.querySelector('.showcase-overlay').click()`);
  await ui.waitFor('.table');
  // 开局提示条放完再开始录，免得和要测的那条混在一起
  await ui.waitFor('.board > .notice-region');
  for (let i = 0; i < 80 && (await ui.evaluate(`!!document.querySelector('.board > .notice-region')`)); i++) await sleep(100);

  // 每帧记一次：舞台在不在、提示条文字、提示条下沿在不在视口里
  await ui.evaluate(`(() => {
    window.__notice = [];
    const t0 = performance.now();
    const tick = () => {
      const msg = document.querySelector('.board > .notice-region .transient-message');
      const r = msg?.getBoundingClientRect();
      window.__notice.push({ t: performance.now() - t0, stage: !!document.querySelector('.stage-overlay'), text: msg?.textContent ?? null, bottom: r?.bottom ?? null });
      requestAnimationFrame(tick);
    };
    tick();
  })()`);
  host.intent({ type: 'chooseAction', action: 'tax' });
  // 控制区刚换内容时 inert 500ms，点不动就再点
  for (let i = 0; i < 50 && host.state.pub?.phase !== 'showdown'; i++) {
    await ui.evaluate(`[...document.querySelectorAll('.controls button:not(:disabled)')].find((b) => /^(质疑|Challenge)$/.test(b.textContent.trim()))?.click()`);
    await sleep(100);
  }
  host.intent({ type: 'revealShowdownCard', cardId: host.state.hand[0].id });
  await ui.waitFor('.board > .notice-region .transient-message');
  await sleep(150);
  await ui.shot('notice-sliding');
  for (let i = 0; i < 80 && (await ui.evaluate(`!!document.querySelector('.board > .notice-region')`)); i++) await sleep(100);

  const frames = await ui.evaluate('window.__notice');
  const shown = frames.filter((f) => f.text);
  const failures = [];
  if (!shown.length) throw new Error('没有出现提示条');
  if (!/Bot/.test(shown[0].text)) failures.push(`提示条没写是谁：${shown[0].text}`);
  if (shown.some((f) => f.stage)) failures.push('对质舞台还开着，提示条就出现了');
  if (shown[0].bottom > 0) failures.push(`提示条第一帧已在视口里（下沿 ${Math.round(shown[0].bottom)}px），不是从上沿滑入`);
  if (shown.at(-1).bottom > 0) failures.push('提示条消失前没有滑出视口');
  const stay = shown.at(-1).t - shown[0].t;
  if (stay < 3900) failures.push(`提示条只停了 ${Math.round(stay)}ms`);
  console.log(`提示条「${shown[0].text}」停留 ${Math.round(stay)}ms`);
  if (failures.length) throw new Error(failures.join('；'));
}
