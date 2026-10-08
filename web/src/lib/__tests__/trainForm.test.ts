import { describe, expect, it } from 'vitest';

import { defaultTrainForm, validateTrainForm } from '../trainForm';

describe('validateTrainForm', () => {
  it('builds the backend default request', () => {
    const { request, errors } = validateTrainForm(defaultTrainForm());
    expect(errors).toEqual({});
    expect(request).toMatchObject({
      model_type: 'lgbm',
      target_symbol: 'SOLUSDT',
      context_symbol: 'BTCUSDT',
      label: { tp_pct: 0.6, sl_pct: 0.4, horizon_minutes: 60, latency_seconds: 1 },
      walk_forward: { train_months: 24, test_months: 3, min_train_months: 12, window: 'rolling' },
      train_stride_minutes: 5,
      fee_pct: 0.1,
      lgbm: { num_leaves: 31, learning_rate: 0.03, min_data_in_leaf: 400, feature_fraction: 0.7, max_rounds: 2000 },
    });
    expect(request).not.toHaveProperty('name');
  });

  it('sends a null context coin and normalizes symbols', () => {
    const { request } = validateTrainForm({ ...defaultTrainForm(), targetSymbol: 'ethusdt', contextSymbol: '' });
    expect(request?.target_symbol).toBe('ETHUSDT');
    expect(request?.context_symbol).toBeNull();
  });

  it('rejects a context equal to the target and out-of-range values', () => {
    const same = validateTrainForm({ ...defaultTrainForm(), contextSymbol: 'SOLUSDT' });
    expect(same.request).toBeNull();
    expect(same.errors.contextSymbol).toMatch(/differ/);
    const bad = validateTrainForm({ ...defaultTrainForm(), trainMonths: '2', learningRate: '0', horizonMinutes: '1.5' });
    expect(Object.keys(bad.errors).sort()).toEqual(['horizonMinutes', 'learningRate', 'trainMonths']);
  });

  it('warns when TP cannot cover the round-trip fee', () => {
    expect(validateTrainForm({ ...defaultTrainForm(), tpPct: '0.15' }).warnings).toHaveLength(1);
    expect(validateTrainForm(defaultTrainForm()).warnings).toHaveLength(0);
  });
});
