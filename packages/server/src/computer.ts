import { ACTION_CLAIM, ASSASSINATE_COST, BLOCK_ROLES, COUP_COST, needsTarget, type ActionType, type GameEvent, type PrivateState, type PublicState, type Role } from '@coup/engine';
import type { ClientIntent } from '@coup/shared';

export type ComputerIntent = Extract<
  ClientIntent,
  { type: 'chooseAction' | 'challenge' | 'passChallenge' | 'block' | 'passBlock' | 'revealShowdownCard' | 'resolveLoss' | 'resolveExchange' }
>;

const pick = <T>(items: readonly T[], random: () => number): T => items[Math.floor(random() * items.length)];

// 电脑玩家的决策：只看真人在这个座位上能看到的东西（ADR 0013）。此刻无需它决定时返回 null。events 留给后续的局内记忆
export function decideComputerIntent(state: PublicState, own: PrivateState, _events: readonly GameEvent[], random: () => number): ComputerIntent | null {
  const me = own.playerId;
  const self = state.players.find((p) => p.id === me);
  if (!self?.alive) return null;
  const held = new Set(own.hand.map((c) => c.role));
  const { pending } = state;
  switch (state.phase) {
    case 'choosingAction':
      return state.currentPlayerId === me ? pickAction(state, me, self.coins, held, random) : null;
    case 'awaitingChallenge': {
      const claimantId = state.challengeSubject === 'action' ? pending!.actorId : pending!.blockById;
      return claimantId !== me && !state.passed.includes(me) ? { type: 'passChallenge' } : null;
    }
    case 'awaitingBlock': {
      const eligible = pending!.action === 'foreignAid' ? pending!.actorId !== me : pending!.targetId === me;
      if (!eligible || state.passed.includes(me)) return null;
      const role = BLOCK_ROLES[pending!.action].find((r) => held.has(r));
      return role ? { type: 'block', role } : { type: 'passBlock' };
    }
    case 'showdown': {
      if (state.showdown!.claimantId !== me) return null;
      const card = own.hand.find((c) => c.role === state.showdown!.role) ?? pick(own.hand, random);
      return { type: 'revealShowdownCard', cardId: card.id };
    }
    case 'choosingLoss':
      return state.lossPlayerId === me ? { type: 'resolveLoss', cardId: pick(own.hand, random).id } : null;
    case 'choosingExchange': {
      if (pending!.actorId !== me) return null;
      const cards = own.hand.slice();
      const keepIds = Array.from({ length: state.exchangeKeepCount! }, () => cards.splice(Math.floor(random() * cards.length), 1)[0].id);
      return { type: 'resolveExchange', keepIds };
    }
    default:
      return null;
  }
}

function pickAction(state: PublicState, me: string, coins: number, held: Set<Role>, random: () => number): ComputerIntent {
  const opponents = state.players.filter((p) => p.alive && p.id !== me).map((p) => p.id);
  if (coins >= COUP_COST) return { type: 'chooseAction', action: 'coup', targetId: pick(opponents, random) };
  const actions = (Object.keys(ACTION_CLAIM) as ActionType[]).filter((a) => {
    const role = ACTION_CLAIM[a];
    return role ? held.has(role) && (a !== 'assassinate' || coins >= ASSASSINATE_COST) : a !== 'coup';
  });
  const action = pick(actions, random);
  return needsTarget(action) ? { type: 'chooseAction', action, targetId: pick(opponents, random) } : { type: 'chooseAction', action };
}
