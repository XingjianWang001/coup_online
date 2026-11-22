// ui-check 场景：牌局事件动效（#90）。两个机器人（Bot、Van）和真人 Me 同桌，按回合驱动：
// - 机器人征税：它的座位上出现公爵背后灵，结算后金币 +3；
// - 机器人偷 Me：Me 的座位带「被针对」标记（读屏文字），结算后 Me 的金币显示减少；
// - 机器人那两步做完后轮到 Me、且手里有公爵或大使：征税或交换是真声称，背后灵从那张牌升起、座位里出现牌光；
//   其余轮到 Me 时收入，金币 +1。
// 截图用 ui.frames 定格动画中间帧。
// 用法：pnpm ui-check scripts/ui-check-motion.mjs [截图目录]；手机加 MOBILE=1 W=390 H=844，减少动态加 REDUCED=1
export default async function motionScenario(ui) {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (what, check, tries = 100) => {
    for (let i = 0; i < tries; i += 1) {
      const value = await check();
      if (value) return value;
      await sleep(100);
    }
    throw new Error(`超时：${what}`);
  };
  const has = (sel) => ui.evaluate(`!!document.querySelector(${JSON.stringify(sel)})`);
  const text = (sel) => ui.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
  // 控制区换内容后有短暂 inert（CONTROLS_ARM_MS）：按钮没反应就再点
  const press = (pattern) => ui.evaluate(`(() => {
    const b = [...document.querySelectorAll('.controls button:not(:disabled), .actions button:not(:disabled)')].find((b) => new RegExp(${JSON.stringify(pattern)}).test(b.textContent.trim()));
    b?.click();
    return !!b;
  })()`);

  const host = ui.bot();
  host.intent({ type: 'createRoom', name: 'Bot' });
  const { roomCode } = await host.next('joined');
  const van = ui.bot();
  van.intent({ type: 'joinRoom', roomCode, name: 'Van' });
  await van.next('joined');
  await ui.joinAs('Me', roomCode);
  await host.next('lobby');
  host.intent({ type: 'startGame' });
  await ui.waitFor('.showcase');
  await ui.evaluate(`document.querySelector('.showcase-overlay').click()`);
  await ui.waitFor('.seat.self .nameplate');

  const pub = () => host.state.pub;
  const bots = new Map([[host.state.playerId, host], [van.state.playerId, van]]);
  const me = await until('Me 的座位', () => pub()?.players.find((p) => p.name === 'Me'));
  const seat = (id) => `[data-seat="${id}"]`;
  const waitTurn = () => until('下一位行动', () => (pub()?.phase === 'choosingAction' ? pub().currentPlayerId : null));
  // 问询窗口：机器人都放弃；Me 若有按钮也放弃
  const everyonePasses = async (startedTurn) => {
    for (let i = 0; i < 100 && pub().currentPlayerId === startedTurn && pub().phase !== 'choosingAction'; i += 1) {
      for (const b of bots.values()) b.intent({ type: pub().phase === 'awaitingBlock' ? 'passBlock' : 'passChallenge' });
      await press('^(Do not challenge|Do not block|不质疑|不阻挡)$');
      await sleep(150);
    }
  };

  const done = { botTax: false, steal: false, mine: false };
  for (let turn = 0; turn < 12 && !(done.botTax && done.steal && done.mine); turn += 1) {
    const current = await waitTurn();
    const bot = bots.get(current);
    if (bot && !done.botTax) {
      bot.intent({ type: 'chooseAction', action: 'tax' });
      await until('机器人座位上的公爵背后灵', () => has(`${seat(current)} .seat-ghost.role--duke`));
      await ui.frames('ghost', [0, 300, 700]);
      await everyonePasses(current);
      const delta = await until('机器人 +3', () => text(`${seat(current)} .coin-delta.gain`));
      assert(delta === '+3', `征税应显示 +3，实际 ${delta}`);
      await ui.frames('coins', [0, 150, 400]);
      done.botTax = true;
    } else if (bot && !done.steal) {
      const before = pub().players.find((p) => p.id === me.id).coins;
      bot.intent({ type: 'chooseAction', action: 'steal', targetId: me.id });
      await until('Me 被针对', () => has('.seat.self.targeted'));
      const label = await text('.seat.self .name .visually-hidden');
      assert(/targeted|被针对/.test(label ?? ''), `被针对的读屏文字缺失：${label}`);
      await ui.shot('targeted');
      await everyonePasses(current);
      assert(!(await has('.seat.self.targeted')), '结算后被针对标记应撤掉');
      if (before > 0) {
        const delta = await until('Me 金币减少', () => text('.seat.self .coin-delta.loss'));
        assert(delta === `−${Math.min(2, before)}`, `偷窃后 Me 应显示 −${Math.min(2, before)}，实际 ${delta}`);
      }
      done.steal = true;
      await until('背后灵播完后移除', async () => !(await has('.seat-ghost')), 30);
    } else if (bot && !done.mine && pub().players.find((p) => p.id === current).coins >= 3 && (await has('.seat.self .cards-row .card--contessa'))) {
      // 机器人暗杀 Me，Me 用手里的女伯爵阻挡：阻挡也是声称，这是真声称
      bot.intent({ type: 'chooseAction', action: 'assassinate', targetId: me.id });
      await until('Me 用女伯爵阻挡', async () => {
        for (const b of bots.values()) b.intent({ type: 'passChallenge' });
        await press('^(Do not challenge|不质疑)$');
        return press('^(Block with Contessa|用女伯爵阻挡)$');
      });
      await until('真声称的牌光', () => has('.seat.self .seat-glow'));
      await ui.frames('honest-block', [0, 300, 560, 1000, 1400]);
      done.mine = true;
    } else if (bot) {
      bot.intent({ type: 'chooseAction', action: 'income' });
    } else {
      // 真声称留到机器人那两步之后：交换会停在选牌界面，场景到此为止
      const ready = done.botTax && done.steal && !done.mine;
      const duke = ready && (await has('.seat.self .cards-row .card--duke'));
      const ambassador = ready && !duke && (await has('.seat.self .cards-row .card--ambassador'));
      const honest = duke || ambassador;
      await until('Me 的行动按钮', () => press(duke ? '^(Tax|征税)' : ambassador ? '^(Exchange|交换)' : '^(Income|收入)'));
      if (honest) {
        await until('真声称的牌光', () => has('.seat.self .seat-glow'));
        await ui.frames('honest', [0, 300, 560, 1000, 1400]);
        await everyonePasses(current);
        done.mine = true;
      } else {
        const delta = await until('Me +1', () => text('.seat.self .coin-delta.gain'));
        assert(delta === '+1', `收入应显示 +1，实际 ${delta}`);
      }
    }
  }
  assert(done.botTax && done.steal, `没跑完机器人的征税与偷窃：${JSON.stringify(done)}`);
  await ui.evaluate(`document.getAnimations().forEach((a) => a.finish())`);
  await ui.shot('motion-end');
  console.log('动效场景：', JSON.stringify(done));
}
