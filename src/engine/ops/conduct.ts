// src/engine/ops/conduct.ts
//
// Conductor's meta-op. Decides whether to approve, escalate, or halt a
// Task Agent recommendation given the project's autonomy mode and
// confidence threshold. Spec § 9 commits v1 to a "simple threshold
// scheme"; this implementation matches that scheme exactly. The signature
// keeps `adapter` + `model` optional so a v2 LLM-routed implementation
// drops in without changing call sites.

import type { ModelAdapter } from '../../adapters/adapter.js';
import type { Recommendation } from '../types.js';

export type ConductMode = 'escort' | 'assist' | 'auto' | 'critical';
export type ConductAction = 'approve' | 'escalate' | 'halt';

export interface ConductDecision {
  action: ConductAction;
  reason: string;
  optionId: string;
}

export interface ConductArgs {
  mode: ConductMode;
  recommendation: Recommendation;
  threshold: number;
  adapter?: ModelAdapter;
  model?: string;
}

export async function conduct(args: ConductArgs): Promise<ConductDecision> {
  const { mode, recommendation, threshold } = args;
  const recommended = recommendation.options.find((o) => o.id === recommendation.recommended);
  const optionId = recommended?.id ?? recommendation.options[0]?.id ?? 'unknown';
  const conf = recommended?.confidence ?? 0;
  const level = recommendation.blast_radius.level;

  if (mode === 'escort') {
    return { action: 'escalate', reason: 'escort mode: every decision goes to user', optionId };
  }

  if (mode === 'assist') {
    if (level === 'high') {
      return { action: 'escalate', reason: `assist mode: blast_radius=high requires user`, optionId };
    }
    if (conf < threshold) {
      return { action: 'escalate', reason: `assist mode: confidence ${conf.toFixed(2)} < threshold ${threshold}`, optionId };
    }
    return { action: 'approve', reason: `assist mode: confidence ${conf.toFixed(2)} >= ${threshold} and blast_radius=${level}`, optionId };
  }

  if (mode === 'auto') {
    if (conf < threshold) {
      return { action: 'escalate', reason: `auto mode: confidence ${conf.toFixed(2)} < threshold ${threshold}`, optionId };
    }
    return { action: 'approve', reason: `auto mode: confidence ${conf.toFixed(2)} >= ${threshold}`, optionId };
  }

  // critical: auto, but halt the queue if confidence drops
  if (conf < threshold) {
    return { action: 'halt', reason: `critical mode: confidence ${conf.toFixed(2)} < threshold ${threshold} — halting queue`, optionId };
  }
  return { action: 'approve', reason: `critical mode: confidence ${conf.toFixed(2)} >= ${threshold}`, optionId };
}
