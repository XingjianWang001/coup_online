// ui-check 场景：电脑对质翻牌前的犹豫（#78）。真人独自建房、加 1 个电脑、开局；真人只收入，电脑一作出声称就质疑。
// 断言：对质舞台上电脑的对准（.stage-slot[data-focus]）在两张牌之间移动，然后翻牌。
// 服务端以 SPEECH_RANDOM=0 启动：游移每 250 毫秒换一次，从第一张开始在两张之间来回。电脑自己选行动，要等它某一回合作出声称。
// 用法：pnpm ui-check scripts/ui-check-showdown-hesitation.mjs [截图目录]；英文加 LOCALE=en
export const serverEnv = { SPEECH_RANDOM: '0' };

export default async function showdownHesitationScenario(ui) {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clickIf = (pattern) => ui.evaluate(`(() => {
    const button = [...document.querySelectorAll('.controls-body button:not(:disabled)')].find((b) => /${pattern}/.test(b.textContent.trim()));
    button?.click();
    return !!button;
  })()`);

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

  // 电脑每回合 2～6 秒出手，多数回合会声称角色：给 60 s。房里只有一个对手，能质疑的就是电脑的声称
  let challenged = false;
  for (let i = 0; i < 600 && !challenged; i += 1) {
    challenged = await clickIf('^(Challenge!|质疑！)$');
    if (challenged) break;
    await clickIf('^(Income|收入)$');
    await clickIf('^(Do not block|不阻挡)$');
    await sleep(100);
  }
  assert(challenged, '60 s 内电脑没有作出可质疑的声称');
  await ui.waitFor('.stage-slot');

  // 每 50 毫秒看一次对准落在哪个牌位，直到翻牌（出手延迟最长 4 秒）
  const look = `(() => ({
    focus: [...document.querySelectorAll('.stage-slot')].findIndex((s) => s.hasAttribute('data-focus')),
    revealed: !!document.querySelector('.stage-verdict'),
  }))()`;
  const path = [];
  let shot = false;
  for (let i = 0; i < 120; i += 1) {
    const { focus, revealed } = await ui.evaluate(look);
    if (revealed) break;
    if (focus >= 0 && focus !== path.at(-1)) path.push(focus);
    if (path.length === 2 && !shot) {
      shot = true;
      await ui.shot('showdown-hesitation-aim');
    }
    await sleep(50);
  }
  assert(await ui.evaluate(`!!document.querySelector('.stage-verdict')`), '6 s 内电脑没有翻牌');
  assert(new Set(path).size === 2, `电脑的对准应在两张牌之间移动：${JSON.stringify(path)}`);
  await ui.shot('showdown-hesitation-reveal');
  console.log('电脑翻牌前对准的牌位依次是：', path.join(' → '));
}
