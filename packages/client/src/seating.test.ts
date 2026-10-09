import { describe, expect, it } from 'vitest';
import { placeSeats, seatAngles } from './seating.ts';

const players = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id }));

describe('placeSeats', () => {
  it('puts the next player in turn order on the left and wraps clockwise', () => {
    const { self, opponents } = placeSeats(players, 'c');
    expect(self?.id).toBe('c');
    expect(opponents.map((s) => [s.player.id, s.angle, s.side])).toEqual([
      ['d', 180, 'left'],
      ['e', 135, 'left'],
      ['f', 90, 'top'],
      ['a', 45, 'right'],
      ['b', 0, 'right'],
    ]);
  });

  it('seats a lone opponent opposite and two opponents up on each side', () => {
    expect(seatAngles(1)).toEqual([90]);
    expect(placeSeats(players.slice(0, 3), 'a').opponents.map((s) => s.side)).toEqual(['left', 'right']);
  });

  it('keeps everyone as an opponent when the viewer is not seated', () => {
    const { self, opponents } = placeSeats(players.slice(0, 2), 'zz');
    expect(self).toBeNull();
    expect(opponents).toHaveLength(2);
  });
});
