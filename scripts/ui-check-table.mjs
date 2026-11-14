// ui-check 场景：牌桌几何。对手 1～5 人各开一局，让当前玩家声称征税（牌桌中央出现叙述和倒计时）、对手都表态（铭牌亮起），
// 断言叙述、通知、各座位互不重叠，对手座位不越出牌桌；每种人数截一张图。
// 用法：pnpm ui-check scripts/ui-check-table.mjs [截图目录]；手机布局加 MOBILE=1 W=390 H=844
const NAMES = ['Bot', 'Van', 'Mia', '小林', 'Bartholomew the Third'];

export default async function tableScenario(ui) {
  const failures = [];
  for (let opponents = 1; opponents <= 5; opponents++) {
    const bots = NAMES.slice(0, opponents).map(() => ui.bot());
    const [host, ...guests] = bots;
    host.intent({ type: 'createRoom', name: NAMES[0] });
    const { roomCode } = await host.next('joined');
    for (const [i, bot] of guests.entries()) {
      bot.intent({ type: 'joinRoom', roomCode, name: NAMES[i + 1] });
      await bot.next('joined');
    }
    await ui.joinAs('Me', roomCode);
    await host.next('lobby');
    host.intent({ type: 'startGame' });
    await ui.waitFor('.showcase');
    await ui.evaluate(`document.querySelector('.showcase-overlay').click()`);
    await ui.waitFor('.table');

    // 当前玩家声称征税，牌桌中央出现叙述
    const pub = host.state.pub ?? (await host.next('publicState')).state;
    const current = bots.find((b) => b.state.playerId === pub.currentPlayerId);
    if (current) current.intent({ type: 'chooseAction', action: 'tax' });
    else await ui.click('^(征税|Tax)$', '.controls');
    await ui.waitFor('.narration:not(.is-empty)');
    for (const bot of bots) bot.intent({ type: 'react', reaction: { kind: 'phrase', phrase: 'sure' } });
    await ui.waitFor(`.seat.opponent .nameplate.speaking`);
    await new Promise((r) => setTimeout(r, 300));
    await ui.evaluate(`document.getAnimations().forEach((a) => { a.pause(); a.currentTime = 900; })`);

    const problems = await ui.evaluate(`(() => {
      const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
      const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
      const named = (el) => el.querySelector('.name')?.textContent ?? el.className;
      const seats = [...document.querySelectorAll('.seat.opponent')].map((el) => ({ name: named(el), ...box(el) }));
      const self = { name: 'self', ...box(document.querySelector('.seat.self')) };
      const table = box(document.querySelector('.table'));
      const parts = [...document.querySelectorAll('.narration-text, .narration-timer')].map(box);
      const narration = { name: 'narration', top: Math.min(...parts.map((p) => p.top)), bottom: Math.max(...parts.map((p) => p.bottom)), left: Math.min(...parts.map((p) => p.left)), right: Math.max(...parts.map((p) => p.right)) };
      const notices = [...document.querySelectorAll('.notice-region')].map((el) => ({ name: 'notice', ...box(el) }));
      const out = [];
      for (const s of seats) {
        if (hit(s, narration)) out.push(s.name + ' 压住叙述');
        if (s.top < table.top - 1) out.push(s.name + ' 越出牌桌上沿');
        for (const n of notices) if (hit(s, n)) out.push(s.name + ' 压住通知');
        if (hit(s, self)) out.push(s.name + ' 压住自己的座位');
      }
      seats.forEach((a, i) => seats.slice(i + 1).forEach((b) => { if (hit(a, b)) out.push(a.name + ' 与 ' + b.name + ' 重叠'); }));
      if (hit(narration, self)) out.push('叙述压住自己的座位');
      return out;
    })()`);
    await ui.shot(`table-${opponents}`);
    if (problems.length) failures.push(`${opponents} 个对手：${problems.join('；')}`);
    console.log(`${opponents} 个对手：${problems.length ? problems.join('；') : '无重叠'}`);
  }
  if (failures.length) throw new Error(failures.join('\n'));
}
