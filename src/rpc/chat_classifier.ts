// src/rpc/chat_classifier.ts
//
// Phase 22 (Control 30.14) feature #62: chat-vs-command routing classifier.
// Determines whether a chat panel submission is a conversational message
// (route to existing chat op) or a command (route to orchestrator decide()).
// Slash-prefix is the always-reliable escape; regex array is the heuristic
// natural-language layer. Heuristic intentionally simple; future v2 may swap
// to a learned classifier or extend to return parsed action+payload for #49.

/** Natural-language patterns that indicate a command rather than conversation.
 *  Exported so tests enumerate each pattern + so /relay-plan for #49 can
 *  extend with /propose-edit-style patterns. Patterns are matched against the
 *  trimmed message. Add new patterns conservatively — false-positives are
 *  jarring (operator asks question, system tries to execute). */
export const COMMAND_PATTERNS: ReadonlyArray<RegExp> = [
  /^what'?s? next/i,
  /^what should i do/i,
  /^advance (this )?card/i,
  /^diagnose (this )?halt/i,
  /^reset (substrate|this card)/i,
  /^run (\w+) (op|step)/i,
];

/** Returns true when the message should route to the orchestrator (command),
 *  false when it should route to the conversational chat op. Slash-prefix
 *  always wins (escape hatch when heuristic mis-classifies). */
export function classifyChatMessage(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith('/')) return true;
  return COMMAND_PATTERNS.some((p) => p.test(trimmed));
}
