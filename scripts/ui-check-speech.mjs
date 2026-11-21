// ui-check 场景：电脑玩家开口（#72）。真人独自建房、加 1 个电脑、开局；真人只收入，不阻挡，电脑作出声称时先不回应。
// 断言：电脑作出声称、问询窗口还开着时（真人这边有「不质疑」可点），电脑座位的铭牌亮起它的表态。
// 服务端以 SPEECH_RANDOM=0 启动：电脑每次作出声称都开口，声称后 0.5 秒说。电脑自己选行动，要等它某一回合作出声称。
// 用法：pnpm ui-check scripts/ui-check-speech.mjs [截图目录]；英文加 LOCALE=en
export const serverEnv = { SPEECH_RANDOM: '0' };

export default async function speechScenario(ui) {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clickIf = (pattern) => ui.evaluate(`[...document.querySelectorAll('.controls-body button:not(:disabled)')].find((b) => /${pattern}/.test(b.textContent.trim()))?.click()`);

  await ui.goto('/');
  await ui.waitFor('input');
  await ui.type('input', 'Me');
  await ui.click('Create room|创建房间');
  await ui.waitFor('.roster-head button');
  await ui.evaluate(`document.querySelector('.roster-head button').click()`);
  for (let i = 0; i < 50 && (await ui.evaluate(`document.querySelectorAll('.playerlist li').length`)) < 2; i += 1) await sleep(100);
  await ui.click('Start game|开始游戏');
  await ui.waitFor('.showcase');
  await ui.evaluate(`document.querySelector('.showcase-overlay').click()`);
  await ui.waitFor('.seat.opponent .name');

  // 电脑每回合 2～6 秒出手，多数回合会声称角色：给 60 s
  const seen = `(() => {
    const plate = document.querySelector('.seat.opponent .nameplate.speaking');
    const open = [...document.querySelectorAll('.controls-body button:not(:disabled)')].some((b) => /^(Do not challenge|不质疑)$/.test(b.textContent.trim()));
    return plate && { text: plate.textContent, open, seat: plate.closest('.seat').querySelector('.name').textContent.trim() };
  })()`;
  let said = null;
  for (let i = 0; i < 600 && !said; i += 1) {
    said = await ui.evaluate(seen);
    if (said) break;
    await clickIf('^(Income|收入)$');
    await clickIf('^(Do not block|不阻挡)$');
    await sleep(100);
  }
  assert(said, '60 s 内电脑的座位上没有出现表态');
  assert(said.open, `电脑的表态应在它的问询窗口里出现：${JSON.stringify(said)}`);
  await ui.shot('speech-after-claim'); // 表态 3 秒后淡出：看到就截，不能先把动画走完
  await clickIf('^(Do not challenge|不质疑)$');
  console.log('电脑', said.seat, '作出声称后说：', said.text);
}
