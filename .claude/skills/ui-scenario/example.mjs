// 机器人建房开局；若机器人先手就拿收入，截下行动后的画面；若真人先手，截下行动栏。
export default async (ui) => {
  const host = ui.bot();
  const joined = host.next('joined');
  host.intent({ type: 'createRoom', name: 'Bot' });
  const { roomCode } = await joined;

  // createRoom 自己也会推一条 lobby：要等到真人入座后的那条
  const seated = (async () => { while ((await host.next('lobby')).players.length < 2); })();
  await ui.joinAs('Me', roomCode);
  await seated;

  const started = host.next('publicState');
  host.intent({ type: 'startGame' });
  await started;
  await ui.waitFor('.showcase');
  await ui.evaluate(`document.getAnimations().forEach((a) => a.finish())`);

  if (host.state.pub.currentPlayerId === host.state.playerId) {
    const acted = host.next('events');
    host.intent({ type: 'chooseAction', action: 'income' });
    await acted;
    await ui.shot('bot-income');
  } else {
    await ui.shot('my-turn');
  }
};
