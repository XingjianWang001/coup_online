// ui-check 场景：牌桌几何。对手 1～5 人各开一局，让当前玩家声称行动、对手都表态（铭牌亮起），
// 断言叙述、提示条、各座位互不重叠，对手座位不越出牌桌；每种人数截一张图。
// 用法：pnpm ui-check scripts/ui-check-table.mjs [截图目录]；手机布局加 MOBILE=1 W=390 H=844
const NAMES = ['MoonlightFox', 'Van', 'Mia', '小林', 'EastWindWolf'];

export default async function tableScenario(ui) {
  const failures = [];
  // 进了页面才量：空白页没有 viewport meta，手机模拟下会按 980px 宽算
  let compact;
  for (let opponents = 1; opponents <= 5; opponents++) {
    const names = NAMES.slice(0, opponents);
    const bots = names.map(() => ui.bot());
    const [host, ...guests] = bots;
    host.intent({ type: 'createRoom', name: names[0] });
    const { roomCode } = await host.next('joined');
    for (const [i, bot] of guests.entries()) {
      bot.intent({ type: 'joinRoom', roomCode, name: names[i + 1] });
      await bot.next('joined');
    }
    await ui.joinAs('Me', roomCode);
    host.intent({ type: 'startGame' });
    await ui.waitFor('.showcase');
    await ui.evaluate(`document.querySelector('.showcase-overlay').click()`);
    await ui.waitFor('.table');
    compact ??= await ui.evaluate("matchMedia('(width < 720px)').matches");
    const actionRow = compact && opponents >= 2;

    // 带目标的偷窃覆盖昵称、行动和目标同时出现的布局。
    const pub = host.state.pub ?? (await host.next('publicState')).state;
    const current = bots.find((b) => b.state.playerId === pub.currentPlayerId);
    if (opponents >= 2) {
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
      const narration = box(document.querySelector('.narration-text'));
      const timer = box(document.querySelector('.controls [role="timer"]'));
      const notices = [...document.querySelectorAll('.notice-region')].map((el) => ({ name: 'notice', ...box(el) }));
      const out = [];
      if (${actionRow}) {
        const row = box(document.querySelector('.narration'));
        const text = document.createRange();
        text.selectNodeContents(document.querySelector('.narration-line'));
        if (!text.toString().includes(${JSON.stringify(names[0])})) out.push('叙述缺少完整昵称');
        if (seats.some(s => s.bottom > row.top + 1) || row.bottom > self.top + 1) out.push('叙述不在对手与自己之间');
        if (innerHeight >= 640 && hit(row, box(document.querySelector('.controls')))) out.push('控制区遮住叙述');
        for (const line of text.getClientRects()) {
          if (line.left < row.left || line.right > row.right || hit(line, timer)) out.push('叙述文字越界或压住决策倒计时');
        }
      }
      if (document.querySelectorAll('[role="timer"]').length !== 1) out.push('决策倒计时应当只出现一次');
      if (!${compact}) {
        if (narration.bottom > table.bottom + 1 || Math.abs(narration.left + narration.right - table.left - table.right) > 2) out.push('叙述不在桌心');
        if (seats.length > 1 && narration.top >= Math.max(...seats.map(s => s.bottom))) out.push('叙述落在所有对手下方');
        if (seats.length === 5 && innerHeight >= 768 && (timer.bottom > innerHeight || [...document.querySelectorAll('.controls button')].some(b => box(b).bottom > innerHeight))) out.push('首屏未显示完整控制区');
      }
      for (const s of seats) {
        if (hit(s, narration)) out.push(s.name + ' 压住叙述');
        if (s.top < table.top - 1) out.push(s.name + ' 越出牌桌上沿');
        for (const n of notices) if (hit(s, n)) out.push(s.name + ' 压住提示条');
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
