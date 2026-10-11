// Resolves what the buyer actually said this turn: a clarification choice by id, or the typed text.

import { CORE_LIMITS, type ChatTurn, type Clarification, type CoreSession, type CoreTurnRequest } from './contract.ts';

export interface ResolvedTurnText<TTurn extends ChatTurn = ChatTurn> {
  /** Text the model should treat as the buyer's message. */
  effectiveText: string;
  choice: { id: string; label: string } | null;
  question: Clarification | null;
  /** Conversation without the in-flight buyer turn (the backend appends it before invoking the agent). */
  history: TTurn[];
}

/**
 * Resolve `choiceId` against the most recent tailor turn that carries a clarification.
 * An unknown choiceId (or one with no open question) is ignored and the typed text is used as free text.
 */
export function resolveTurnText<S extends CoreSession>(session: S, request: CoreTurnRequest): ResolvedTurnText<S['conversation'][number]> {
  const history = [...session.conversation] as S['conversation'][number][];
  const last = history[history.length - 1];
  if (last && last.role === 'buyer' && last.text.trim() === request.text.trim()) history.pop();
  let question: Clarification | null = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i]!;
    if (turn.role !== 'tailor') continue;
    question = turn.clarification ?? null;
    break;
  }
  const choice = request.choiceId && question ? question.choices.find(c => c.id === request.choiceId) ?? null : null;
  const effective = choice ? choice.label : request.text;
  return {
    effectiveText: effective.trim().slice(0, CORE_LIMITS.maxTurnTextChars),
    choice: choice ? { id: choice.id, label: choice.label } : null,
    question,
    history,
  };
}
