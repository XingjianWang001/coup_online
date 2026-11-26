// ui-check 场景：设置里的背景音乐（喇叭 + 音量滑块）与致谢里的音乐素材。先截图再断言，在没有背景音乐的分支上也能截到改动前的样子。
// 用法：pnpm ui-check scripts/ui-check-music.mjs [截图目录]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mp3s = `performance.getEntriesByType('resource').filter((e) => /\\/assets\\/[\\w-]+\\.mp3$/.test(e.name) && e.responseEnd > 0).length`;
const slider = (prop) => `document.querySelector('.music-volume')?.${prop}`;
const muted = `document.querySelector('.music-mute')?.getAttribute('aria-pressed')`;
const check = (ok, message) => {
  if (!ok) throw new Error(message);
};

async function openSettings(ui) {
  await ui.click('^(设置|Settings)$', '.header');
  await ui.waitFor('.settings-panel');
  await ui.evaluate('document.getAnimations().forEach((a) => a.finish())');
}

export default async function musicScenario(ui) {
  await ui.goto('/');
  await ui.waitFor('.header');
  await openSettings(ui);
  await ui.shot('settings');
  await ui.click('^(制作人员|Credits)$', '.settings-panel');
  await ui.waitFor('.credits-list, .settings-panel p');
  await sleep(300); // 等私有名单的请求落定，免得截到「正在加载」
  await ui.shot('credits');

  // 默认开着、音量 50；没静音时先载入大厅的一条，其余随后在后台载入，一共 7 条（含胜利曲）
  check((await ui.evaluate('!!document.querySelector(".music-credits a[href*=\\"by/4.0\\"]")')), '致谢里没有 MTG 的 CC BY 4.0 署名');
  await ui.click('^(返回设置|Back to settings)$', '.settings-panel');
  check((await ui.evaluate(slider('getAttribute("aria-valuetext")'))) === '50%', '默认音量不是 50%');
  for (let i = 0; i < 100 && (await ui.evaluate(mp3s)) < 7; i++) await sleep(100);
  check((await ui.evaluate(mp3s)) === 7, '没有载入全部 7 条分轨');

  // 拖到 30，再从 30 拖到 0：记作静音，喇叭划断；取消静音回到 30
  await ui.type('.music-volume', '30');
  // 按下滑块开始新一次拖动（headless 页面没有窗口焦点，focus() 不触发 focus 事件，所以用 pointerdown）
  await ui.evaluate(`document.querySelector('.music-volume').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await ui.type('.music-volume', '0');
  check((await ui.evaluate(muted)) === 'true', '拖到 0 没有记作静音');
  await ui.evaluate('document.getAnimations().forEach((a) => a.finish())');
  await ui.shot('settings-muted');
  await ui.evaluate(`document.querySelector('.music-mute').click()`);
  check((await ui.evaluate(slider('getAttribute("aria-valuetext")'))) === '30%', '取消静音没有回到拖动前的音量');

  // 静音后刷新：仍是静音，一条分轨都不下
  await ui.evaluate(`document.querySelector('.music-mute').click()`);
  await ui.goto('/');
  await ui.waitFor('.header');
  await sleep(1000);
  check((await ui.evaluate(mp3s)) === 0, '静音时仍在下载分轨');
  await openSettings(ui);
  check((await ui.evaluate(muted)) === 'true' && (await ui.evaluate(slider('value'))) === '0', '刷新后没有记住静音');
}
