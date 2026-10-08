import { parseNumber } from './backtestForm';
import { DEFAULT_CONTEXT, DEFAULT_TARGET, SYMBOL_PATTERN, normalizeSymbol } from './symbols';
import type { ModelType, TrainRequest, WindowMode } from './types';

// Defaults and bounds mirror api/app/routes/models.py (TrainRequest).
export interface TrainFormState {
  name: string;
  modelType: ModelType;
  targetSymbol: string;
  contextSymbol: string; // '' = no context coin
  tpPct: string;
  slPct: string;
  horizonMinutes: string;
  latencySeconds: string;
  trainMonths: string;
  testMonths: string;
  minTrainMonths: string;
  window: WindowMode;
  trainStrideMinutes: string;
  feePct: string;
  numLeaves: string;
  learningRate: string;
  minDataInLeaf: string;
  featureFraction: string;
  maxRounds: string;
}

export function defaultTrainForm(): TrainFormState {
  return {
    name: '',
    modelType: 'lgbm',
    targetSymbol: DEFAULT_TARGET,
    contextSymbol: DEFAULT_CONTEXT,
    tpPct: '0.6',
    slPct: '0.4',
    horizonMinutes: '60',
    latencySeconds: '1',
    trainMonths: '24',
    testMonths: '3',
    minTrainMonths: '12',
    window: 'rolling',
    trainStrideMinutes: '5',
    feePct: '0.1',
    numLeaves: '31',
    learningRate: '0.03',
    minDataInLeaf: '400',
    featureFraction: '0.7',
    maxRounds: '2000',
  };
}

type NumericField = Exclude<keyof TrainFormState, 'name' | 'modelType' | 'window' | 'targetSymbol' | 'contextSymbol'>;
export type TrainFormField = NumericField | 'targetSymbol' | 'contextSymbol';

interface Rule {
  label: string;
  min: number;
  max: number;
  minExclusive?: boolean;
  integer?: boolean;
}

const RULES: Record<NumericField, Rule> = {
  tpPct: { label: 'Take profit', min: 0, max: 20, minExclusive: true },
  slPct: { label: 'Stop loss', min: 0, max: 20, minExclusive: true },
  horizonMinutes: { label: 'Horizon', min: 1, max: 1440, integer: true },
  latencySeconds: { label: 'Latency', min: 0, max: 60, integer: true },
  trainMonths: { label: 'Train months', min: 3, max: 72, integer: true },
  testMonths: { label: 'Test months', min: 1, max: 12, integer: true },
  minTrainMonths: { label: 'Min train months', min: 3, max: 48, integer: true },
  trainStrideMinutes: { label: 'Train stride', min: 1, max: 60, integer: true },
  feePct: { label: 'Fee', min: 0, max: 1 },
  numLeaves: { label: 'num_leaves', min: 4, max: 255, integer: true },
  learningRate: { label: 'learning_rate', min: 0, max: 0.5, minExclusive: true },
  minDataInLeaf: { label: 'min_data_in_leaf', min: 10, max: 100000, integer: true },
  featureFraction: { label: 'feature_fraction', min: 0, max: 1, minExclusive: true },
  maxRounds: { label: 'max_rounds', min: 10, max: 10000, integer: true },
};

export function validateTrainForm(state: TrainFormState): {
  errors: Partial<Record<TrainFormField, string>>;
  warnings: string[];
  request: TrainRequest | null;
} {
  const errors: Partial<Record<TrainFormField, string>> = {};
  const target = normalizeSymbol(state.targetSymbol);
  const context = normalizeSymbol(state.contextSymbol);
  if (!SYMBOL_PATTERN.test(target)) {
    errors.targetSymbol = 'Choose the traded coin.';
  }
  if (context && !SYMBOL_PATTERN.test(context)) {
    errors.contextSymbol = 'Not a valid symbol.';
  } else if (context && context === target) {
    errors.contextSymbol = 'The context coin must differ from the traded coin.';
  }
  const values = {} as Record<NumericField, number>;

  for (const [field, rule] of Object.entries(RULES) as Array<[NumericField, Rule]>) {
    const value = parseNumber(state[field]);
    if (value === null) {
      errors[field] = `${rule.label} must be a number.`;
    } else if ((rule.minExclusive ? value <= rule.min : value < rule.min) || value > rule.max) {
      errors[field] = `${rule.label} must be ${rule.minExclusive ? `> ${rule.min}` : `≥ ${rule.min}`} and ≤ ${rule.max}.`;
    } else if (rule.integer && !Number.isInteger(value)) {
      errors[field] = `${rule.label} must be a whole number.`;
    } else {
      values[field] = value;
    }
  }

  const warnings: string[] = [];
  if (values.tpPct !== undefined && values.feePct !== undefined && values.tpPct <= 2 * values.feePct) {
    warnings.push(`Take profit ${values.tpPct}% does not cover the ${2 * values.feePct}% round-trip fee; even “hits” lose money.`);
  }

  if (Object.keys(errors).length > 0) {
    return { errors, warnings, request: null };
  }

  const request: TrainRequest = {
    model_type: state.modelType,
    label: {
      tp_pct: values.tpPct,
      sl_pct: values.slPct,
      horizon_minutes: values.horizonMinutes,
      latency_seconds: values.latencySeconds,
    },
    walk_forward: {
      train_months: values.trainMonths,
      test_months: values.testMonths,
      min_train_months: values.minTrainMonths,
      window: state.window,
    },
    train_stride_minutes: values.trainStrideMinutes,
    target_symbol: target,
    context_symbol: context || null,
    fee_pct: values.feePct,
    lgbm: {
      num_leaves: values.numLeaves,
      learning_rate: values.learningRate,
      min_data_in_leaf: values.minDataInLeaf,
      feature_fraction: values.featureFraction,
      max_rounds: values.maxRounds,
    },
  };
  if (state.name.trim()) request.name = state.name.trim();
  return { errors, warnings, request };
}
