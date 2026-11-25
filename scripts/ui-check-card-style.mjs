// ui-check 场景：牌面风格切换。localhost 在开放名单里，设置里直接有「牌面风格」；选图腾后开局，截下发牌后的大牌。
// 用法：pnpm ui-check scripts/ui-check-card-style.mjs [截图目录]
export default async function cardStyleScenario(ui) {
  await ui.goto('/');
  await ui.waitFor('.header');
  await ui.click('^(设置|Settings)$', '.header');
  await ui.waitFor('.settings-panel');
  await ui.evaluate('document.getAnimations().forEach((a) => a.finish())');
  await ui.shot('settings');

  if (!(await ui.evaluate(`!!document.querySelector('input[name="cardStyle"][value="totem"]')`))) throw new Error('设置里没有牌面风格');
  await ui.evaluate(`document.querySelector('input[name="cardStyle"][value="totem"]').click()`);
  await ui.click('^(关闭|Close)', '.settings-panel');
  if ((await ui.evaluate('document.documentElement.dataset.cardStyle')) !== 'totem') throw new Error('牌面风格没有切到图腾');
  // 选中图腾后、发牌前，五张画就该预载完，第一次亮牌不用等下载
  const loaded = `performance.getEntriesByType('resource').filter((e) => /\\/assets\\/\\w+-[\\w-]+\\.jpg$/.test(e.name) && e.responseEnd > 0).length`;
  for (let i = 0; i < 50 && (await ui.evaluate(loaded)) < 5; i++) await new Promise((r) => setTimeout(r, 100));
  if ((await ui.evaluate(loaded)) !== 5) throw new Error('发牌前没有预载完五张图腾画');

  const host = ui.bot();
  host.intent({ type: 'createRoom', name: 'Bot' });
  const { roomCode } = await host.next('joined');
  await ui.joinAs('Me', roomCode);
  host.intent({ type: 'startGame' });
  await ui.waitFor('.showcase');
  await ui.evaluate('document.getAnimations().forEach((a) => a.finish())');
  await ui.shot('showcase');
}
