// 牌桌落座：自己坐近端（下方），对手按行动顺序顺时针落在远端半圈。
// 角度以自己为视角：180° 在左手边，90° 正对面，0° 在右手边。

export type SeatSide = 'left' | 'top' | 'right';

export interface PlacedSeat<P> {
  player: P;
  angle: number;
  side: SeatSide;
}

export function seatAngles(count: number): number[] {
  if (count === 1) return [90];
  // 两位对手抬到左上/右上，避免远端正中空出一大块
  if (count === 2) return [150, 30];
  return Array.from({ length: count }, (_, i) => 180 - (i * 180) / (count - 1));
}

export function sideOf(angle: number): SeatSide {
  return angle > 90 ? 'left' : angle < 90 ? 'right' : 'top';
}

// players 按行动顺序排列；下一位行动者坐在自己左手边。
export function placeSeats<P extends { id: string }>(
  players: readonly P[],
  selfId: string | undefined,
): { self: P | null; opponents: PlacedSeat<P>[] } {
  const selfIndex = players.findIndex((p) => p.id === selfId);
  const others =
    selfIndex < 0 ? [...players] : [...players.slice(selfIndex + 1), ...players.slice(0, selfIndex)];
  const angles = seatAngles(others.length);
  return {
    self: selfIndex < 0 ? null : players[selfIndex],
    opponents: others.map((player, i) => ({ player, angle: angles[i], side: sideOf(angles[i]) })),
  };
}
