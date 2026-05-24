// tests/rpc/chat_classifier.test.ts
//
// Phase 22 (Control 30.14) feature #62: classifier-route tests.

import { describe, it, expect } from 'vitest';
import { classifyChatMessage, COMMAND_PATTERNS } from '../../src/rpc/chat_classifier.js';

describe('classifyChatMessage', () => {
  it('returns false for empty string', () => {
    expect(classifyChatMessage('')).toBe(false);
    expect(classifyChatMessage('   ')).toBe(false);
  });

  it('returns true for any slash-prefixed message (escape hatch)', () => {
    expect(classifyChatMessage('/diagnose')).toBe(true);
    expect(classifyChatMessage('/anything goes here')).toBe(true);
    expect(classifyChatMessage('  /leading whitespace  ')).toBe(true);
  });

  it('matches each COMMAND_PATTERN against a representative message', () => {
    expect(classifyChatMessage('what next?')).toBe(true);
    expect(classifyChatMessage("what's next for this card?")).toBe(true);
    expect(classifyChatMessage('what should I do?')).toBe(true);
    expect(classifyChatMessage('advance this card to verifying')).toBe(true);
    expect(classifyChatMessage('Advance card to shipped')).toBe(true);
    expect(classifyChatMessage('diagnose this halt')).toBe(true);
    expect(classifyChatMessage('reset substrate')).toBe(true);
    expect(classifyChatMessage('reset this card')).toBe(true);
    expect(classifyChatMessage('run analyze op')).toBe(true);
    expect(classifyChatMessage('run step1 step')).toBe(true);
  });

  it('returns false for conversational messages', () => {
    expect(classifyChatMessage('How does this card work?')).toBe(false);
    expect(classifyChatMessage('Tell me about the design.')).toBe(false);
    expect(classifyChatMessage('Thanks!')).toBe(false);
    expect(classifyChatMessage('That looks good to me.')).toBe(false);
  });

  it('exports COMMAND_PATTERNS as a non-empty readonly array', () => {
    expect(COMMAND_PATTERNS.length).toBeGreaterThan(0);
    for (const p of COMMAND_PATTERNS) {
      expect(p).toBeInstanceOf(RegExp);
    }
  });
});
