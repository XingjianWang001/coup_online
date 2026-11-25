// ui-check 场景：电脑接话（#81）。真人独自建房、加 1 个电脑、开局；轮到真人选行动、电脑没在说话时，真人从表态面板发一条口头声称「我有公爵」。
// 断言：3 秒内电脑的座位亮起它的回应（窗口之外听到我有 X：你确定？或我信你个鬼）。
// 服务端以 SPEECH_RANDOM=0 启动：有候选就开口、说第一条，在听到后 0.6 秒说。
// 用法：pnpm ui-check scripts/ui-check-reply.mjs [截图目录]；英文加 LOCALE=en
export const serverEnv = { SPEECH_RANDOM: '0' };

export default async function replyScenario(ui) {
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

  // 等到轮到真人选行动、电脑的铭牌没亮着；期间真人不阻挡、不质疑
  const ready = `[...document.querySelectorAll('.controls-body button:not(:disabled)')].some((b) => /^(Income|收入)$/.test(b.textContent.trim())) && !document.querySelector('.seat.opponent .nameplate.speaking')`;
  for (let i = 0; i < 300 && !(await ui.evaluate(ready)); i += 1) {
    await clickIf('^(Do not block|不阻挡)$');
    await clickIf('^(Do not challenge|不质疑)$');
    await sleep(100);
  }
  assert(await ui.evaluate(ready), '30 s 内没轮到真人选行动');

  await ui.evaluate(`document.querySelector('.reaction-toggle').click()`);
  await ui.evaluate(`Promise.all(document.querySelector('.reaction-collapse').getAnimations().map((a) => a.finished))`);
  await ui.evaluate(`[...document.querySelectorAll('.reaction-tabs button')].find((b) => /Verbal claim|口头声称/.test(b.textContent)).click()`);
  await sleep(100);
  // 第一行是「我有」
  await ui.evaluate(`[...document.querySelector('.reaction-verbal-row').querySelectorAll('button')].find((b) => /Duke|公爵/.test(b.textContent)).click()`);
  const sentAt = Date.now();
  await ui.waitFor('.seat.self .nameplate.speaking');
  const mine = await ui.evaluate(`document.querySelector('.seat.self .nameplate.speaking').textContent`);

  let reply = null;
  while (!reply && Date.now() - sentAt < 3_000) {
    reply = await ui.evaluate(`document.querySelector('.seat.opponent .nameplate.speaking')?.textContent`);
    if (!reply) await sleep(50);
  }
  assert(reply, `真人说「${mine}」后 3 秒内电脑没有接话`);
  assert(/你确定|我信你个鬼|You sure|Yeah, right/.test(reply), `电脑的回应应是你确定？或我信你个鬼：${reply}`);
  // 铭牌上的表态 3 秒后淡出：看到就把动画定在完全显示的时刻再截
  await ui.evaluate(`document.getAnimations().forEach((a) => { a.pause(); a.currentTime = 900; })`);
  await ui.evaluate(`window.scrollTo(0, 0)`);
  await ui.shot('reply');
  console.log('真人说：', mine, '| 电脑约', Date.now() - sentAt, 'ms 内接：', reply);
}
