// node --test scripts/deploy-room-check.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roomCheck } from './deploy-room-check.mjs';

const human = (id, present = true) => ({ id, isComputer: false, present });
const computer = (id) => ({ id, isComputer: true, present: true });
const game = (...alive) => ({ phase: 'choosingAction', players: alive.map(([id, a]) => ({ id, alive: a })) });

test('busy 房间要确认，列出房间码和还在打的真人数', () => {
  const { confirm, lines } = roomCheck({
    rooms: [
      { code: 'AAA111', tier: 'busy', players: [human('a'), human('b'), human('c'), computer('x')], game: game(['a', true], ['b', true], ['c', false], ['x', true]) },
      { code: 'BBB222', tier: 'waiting', players: [human('d')], game: null },
    ],
  });
  assert.equal(confirm, true);
  assert.match(lines.join('\n'), /AAA111: 2 humans playing/);
  assert.match(lines.join('\n'), /BBB222/);
});

test('只有 waiting 房间：打印提示，不确认', () => {
  const { confirm, lines } = roomCheck({ rooms: [{ code: 'BBB222', tier: 'waiting', players: [human('d'), human('e', false)], game: null }] });
  assert.equal(confirm, false);
  assert.match(lines.join('\n'), /BBB222: 1 human waiting/);
});

test('只有 idle 房间或没有房间：不提示', () => {
  assert.deepEqual(roomCheck({ rooms: [] }), { confirm: false, lines: [] });
  assert.deepEqual(roomCheck({ rooms: [{ code: 'CCC333', tier: 'idle', players: [computer('x')], game: game(['x', true]) }] }), { confirm: false, lines: [] });
});
