// ui-check 场景：电脑轮到自己时先预告、再行动（#76）。真人独自建房、加 1 个电脑、开局；真人只收入，不质疑、不阻挡。
// 断言：电脑第一次行动之前，它的座位铭牌先亮起行动预告；约 0.8 秒后记录里才出现它的行动。
// 服务端以 SPEECH_RANDOM=0 启动：电脑每回合都说真预告（表 1 每行的第一条），停顿取最短 0.8 秒。
// 用法：pnpm ui-check scripts/ui-check-announce.mjs [截图目录]；英文加 LOCALE=en
export const serverEnv = { SPEECH_RANDOM: '0' };

export default async function announceScenario(ui) {
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
  const computer = await ui.evaluate(`document.querySelector('.seat.opponent .name').textContent.trim()`);

  // 电脑的铭牌表态，和记录里它的行动条数
  const look = `(() => ({
    plate: document.querySelector('.seat.opponent .nameplate.speaking')?.textContent ?? null,
    acted: [...document.querySelectorAll('.log-header')].filter((e) => e.textContent.startsWith(${JSON.stringify(computer)})).length,
  }))()`;
  // 第一手最多等 3 s + 6 s，真人先手时再加真人点收入：给 20 s。电脑第一次行动之前亮起的铭牌只可能是预告
  let seen = null;
  let announcedAt = 0;
  for (let i = 0; i < 400 && !seen; i += 1) {
    const now = await ui.evaluate(look);
    assert(now.acted === 0, `电脑行动之前没有看到它的预告`);
    if (now.plate) {
      seen = now.plate;
      announcedAt = Date.now();
      break;
    }
    await clickIf('^(Income|收入)$');
    await sleep(50);
  }
  assert(seen, '20 s 内电脑的座位上没有出现行动预告');
  await ui.shot('announce-before-action'); // 表态 3 秒后淡出：看到就截
  let action = null;
  for (let i = 0; i < 60 && !action; i += 1) {
    action = await ui.evaluate(`[...document.querySelectorAll('.log-header')].map((e) => e.textContent).find((t) => t.startsWith(${JSON.stringify(computer)}))`);
    if (!action) await sleep(50);
  }
  const pause = Date.now() - announcedAt;
  assert(action, '预告 3 s 后记录里仍没有电脑的行动');
  assert(pause >= 500, `预告之后应停顿约 0.8 秒再行动，实际 ${pause} ms`);
  await ui.shot('announce-then-action');
  console.log('电脑', computer, '预告：', seen, '| 约', pause, 'ms 后行动：', action);
}
