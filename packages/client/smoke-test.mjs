import { io } from 'socket.io-client';

const URL = 'http://localhost:8787';
const clients = [io(URL), io(URL), io(URL)];

clients.forEach((c, i) => c.on('error', (m) => console.error(`client${i} error:`, m.message)));

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
  console.log('✅ 房间创建:', roomCode, 'playerId:', joined.playerId);

  const bJoined = on(clients[1], 'joined');
  const cJoined = on(clients[2], 'joined');
  clients[1].emit('intent', { type: 'joinRoom', roomCode, name: 'Bob' });
  clients[2].emit('intent', { type: 'joinRoom', roomCode, name: 'Carol' });
  await bJoined;
  await cJoined;
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
  const privPromise = on(host, 'privateState');
  host.emit('intent', { type: 'chooseAction', action: 'income' });
  const pub2 = await pub2Promise;
  const priv = await privPromise;
  console.log('✅ Alice 收入后轮到:', pub2.state.currentPlayerId, 'Alice 金币:', pub2.state.players[0].coins);
  console.log('✅ Alice 暗牌数量:', priv.hand.length);

  console.log('🎉 冒烟测试全部通过');
  process.exit(0);
}

main().catch((e) => {
  console.error('❌ 测试失败:', e.message);
  process.exit(1);
});