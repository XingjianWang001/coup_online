// ui-check 场景：牌桌几何。对手 1～5 人各开一局，让当前玩家声称行动、对手都表态（铭牌亮起），
// 断言叙述、通知、各座位互不重叠，对手座位不越出牌桌；每种人数截一张图。
// 用法：pnpm ui-check scripts/ui-check-table.mjs [截图目录]；手机布局加 MOBILE=1 W=390 H=844
const NAMES = ['Bot', 'Van', 'Mia', '小林', 'Bartholomew the Third'];

export default async function tableScenario(ui) {
  const failures = [];
  const narrow = await ui.evaluate("matchMedia('(max-width: 1024px)').matches");
  for (let opponents = 1; opponents <= 5; opponents++) {
    const names = NAMES.slice(0, opponents);
    const actionRow = narrow && opponents >= 2;
    if (actionRow) names[0] = 'MoonlightCardCollector'.padEnd(32, 'W');
    const bots = names.map(() => ui.bot());
    const [host, ...guests] = bots;
    host.intent({ type: 'createRoom', name: names[0] });
    const { roomCode } = await host.next('joined');
    for (const [i, bot] of guests.entries()) {
      bot.intent({ type: 'joinRoom', roomCode, name: names[i + 1] });
      await bot.next('joined');
    }
    await ui.joinAs('Me', roomCode);
    await host.next('lobby');
    host.intent({ type: 'startGame' });
    await ui.waitFor('.showcase');
    await ui.evaluate(`document.querySelector('.showcase-overlay').click()`);
    await ui.waitFor('.table');

    // 独立横行覆盖带 32 字符连续昵称的偷窃，无论谁先行动都能测到。
    const pub = host.state.pub ?? (await host.next('publicState')).state;
    const current = bots.find((b) => b.state.playerId === pub.currentPlayerId);
    if (actionRow) {
      const target = current === host ? guests[0] : host;
      if (current) current.intent({ type: 'chooseAction', action: 'steal', targetId: target.state.playerId });
      else {
        await ui.click('^(偷窃|Steal)$', '.controls');
        await ui.click(names[0], '.controls');
      }
    } else if (current) current.intent({ type: 'chooseAction', action: 'tax' });
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
      if (${actionRow}) {
        const row = box(document.querySelector('.narration'));
        const text = document.createRange();
        text.selectNodeContents(document.querySelector('.narration-line'));
        if (!text.toString().includes(${JSON.stringify(names[0])})) out.push('行动缺少完整昵称');
        if (seats.some(s => s.bottom > row.top + 1) || row.bottom > self.top + 1) out.push('行动行不在对手与自己之间');
        if (matchMedia('(max-width: 768px) and (min-height: 640px)').matches && hit(row, box(document.querySelector('.controls')))) out.push('操作区遮住行动行');
        const timer = box(document.querySelector('.narration-timer'));
        for (const line of text.getClientRects()) {
          if (line.left < row.left || line.right > row.right || hit(line, timer)) out.push('行动文字越界或压住倒计时');
        }
      }
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
