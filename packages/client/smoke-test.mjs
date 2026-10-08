import { io } from 'socket.io-client';

const URL = process.env.COUP_URL ?? 'http://localhost:8787';
const clients = [io(URL), io(URL), io(URL)];

clients.forEach((c, i) => c.on('error', (error) => console.error(`client${i} error:`, error.code, error.params ?? '')));

const on = (client, event) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting ${event}`)), 5000);
    client.once(event, (m) => {
      clearTimeout(t);
      resolve(m);
    });
  });

const connected = (client) =>
  client.connected ? Promise.resolve() : on(client, 'connect');

async function main() {
  // 等三个客户端都连上
  await Promise.all(clients.map(connected));
  console.log('✅ 3 个客户端已连接');

  const host = clients[0];
  host.emit('intent', { type: 'createRoom', name: 'Alice' });
  const joined = await on(host, 'joined');
  const roomCode = joined.roomCode;
  if (!/^[0-9A-F]{6}$/.test(roomCode)) throw new Error(`房间码格式无效: ${roomCode}`);
  console.log('✅ 房间创建:', roomCode, 'playerId:', joined.playerId);

  const structuredError = on(clients[2], 'error');
  clients[2].emit('intent', { type: 'joinRoom', roomCode: 'NOPE00', name: 'Carol' });
  const error = await structuredError;
  if (error.code !== 'roomNotFound' || 'message' in error) {
    throw new Error(`结构化错误信封无效: ${JSON.stringify(error)}`);
  }
  console.log('✅ 结构化错误信封:', error.code);

  const bJoined = on(clients[1], 'joined');
  const cJoined = on(clients[2], 'joined');
  clients[1].emit('intent', { type: 'joinRoom', roomCode, name: 'Bob' });
  clients[2].emit('intent', { type: 'joinRoom', roomCode, name: 'Carol' });
  const bob = await bJoined;
  const carol = await cJoined;
  console.log('✅ 3 人加入');

  host.emit('intent', { type: 'startGame' });
  const started = await Promise.all(clients.map((c) => on(c, 'gameStarted')));
  console.log('✅ 游戏开始, turnOrder:', started[0].turnOrder);

  const pub1 = await on(host, 'publicState');
  console.log('✅ 当前回合玩家:', pub1.state.currentPlayerId, '金币:', pub1.state.players[0].coins);
  if (typeof pub1.remainingMs !== 'number' || pub1.remainingMs <= 0) {
    throw new Error('publicState 缺少权威倒计时 remainingMs');
  }
  console.log('✅ 权威倒计时(ms):', pub1.remainingMs);

  const pub2Promise = on(host, 'publicState');
  const players = [
    { client: host, id: joined.playerId, name: 'Alice' },
    { client: clients[1], id: bob.playerId, name: 'Bob' },
    { client: clients[2], id: carol.playerId, name: 'Carol' },
  ];
  const actor = players.find((player) => player.id === pub1.state.currentPlayerId);
  if (!actor) throw new Error('当前玩家不在已加入玩家列表中');
  const privPromise = on(actor.client, 'privateState');
  actor.client.emit('intent', { type: 'chooseAction', action: 'income' });
  const pub2 = await pub2Promise;
  const priv = await privPromise;
  const actorState = pub2.state.players.find((player) => player.id === actor.id);
  if (!actorState) throw new Error('行动者不在公开状态中');
  console.log(`✅ ${actor.name} 收入后轮到:`, pub2.state.currentPlayerId, '行动者金币:', actorState.coins);
  console.log(`✅ ${actor.name} 暗牌数量:`, priv.hand.length);

  console.log('🎉 冒烟测试全部通过');
  process.exit(0);
}

main().catch((e) => {
  console.error('❌ 测试失败:', e.message);
  process.exit(1);
});
