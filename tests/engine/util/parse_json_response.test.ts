import { describe, it, expect } from 'vitest';
import { parseJsonResponse } from '../../../src/engine/util/parse_json_response.js';

describe('parseJsonResponse', () => {
  it('parses plain JSON object', () => {
    const r = parseJsonResponse<{ a: number }>('{"a":1}', { op: 'test' });
    expect(r.a).toBe(1);
  });

  it('parses plain JSON array', () => {
    const r = parseJsonResponse<number[]>('[1,2,3]', { op: 'test' });
    expect(r).toEqual([1, 2, 3]);
  });

  it('parses with whitespace padding', () => {
    const r = parseJsonResponse<{ a: number }>('  \n  {"a":1}\n  ', { op: 'test' });
    expect(r.a).toBe(1);
  });

  it('strips a ```json ... ``` fence', () => {
    const r = parseJsonResponse<{ a: number }>('```json\n{"a":1}\n```', { op: 'test' });
    expect(r.a).toBe(1);
  });

  it('strips a bare ``` ... ``` fence', () => {
    const r = parseJsonResponse<{ a: number }>('```\n{"a":1}\n```', { op: 'test' });
    expect(r.a).toBe(1);
  });

  it('strips a fence with extra trailing whitespace', () => {
    const r = parseJsonResponse<{ a: number }>('```json\n{"a":1}\n```\n   ', { op: 'test' });
    expect(r.a).toBe(1);
  });

  it('strips a fence around an array', () => {
    const r = parseJsonResponse<number[]>('```json\n[1,2,3]\n```', { op: 'test' });
    expect(r).toEqual([1, 2, 3]);
  });

  it('extracts the first JSON object when prose precedes it', () => {
    const text = 'Here is the result:\n\n{"a":1, "b":[2,3]}';
    const r = parseJsonResponse<{ a: number; b: number[] }>(text, { op: 'test' });
    expect(r.a).toBe(1);
    expect(r.b).toEqual([2, 3]);
  });

  it('extracts JSON even when prose follows it', () => {
    const text = '{"a":1}\n\nNotes: I chose 1 because...';
    const r = parseJsonResponse<{ a: number }>(text, { op: 'test' });
    expect(r.a).toBe(1);
  });

  it('respects string-literal braces when extracting', () => {
    const text = 'preamble {"key": "value with } in it", "n": 2} trailing';
    const r = parseJsonResponse<{ key: string; n: number }>(text, { op: 'test' });
    expect(r.key).toBe('value with } in it');
    expect(r.n).toBe(2);
  });

  it('throws with op name and raw snippet on unparseable input', () => {
    expect(() =>
      parseJsonResponse('this is definitely not json', { op: 'discover' }),
    ).toThrow(/discover: failed to parse.*Raw \(first 300 chars\): this is definitely/);
  });

  it('truncates raw snippet to rawSnippetLength', () => {
    const long = 'x'.repeat(1000);
    expect(() =>
      parseJsonResponse(long, { op: 'verify', rawSnippetLength: 20 }),
    ).toThrow(/Raw \(first 20 chars\): x{20}$/);
  });
});
