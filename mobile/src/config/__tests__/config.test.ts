import { ModelConfig, FeatureFlags, RouterConfig, AppConfig } from '../index';

describe('ModelConfig', () => {
  it('uses correct Claude model IDs', () => {
    expect(ModelConfig.CLOUD_HOT).toBe('claude-haiku-4-5-20251001');
    expect(ModelConfig.CLOUD_REFLECT).toBe('claude-sonnet-4-6');
  });
});

describe('FeatureFlags', () => {
  it('feature flags have expected values', () => {
    expect(FeatureFlags.onDeviceModelEnabled).toBe(false);
    expect(FeatureFlags.voiceEnabled).toBe(true);
    expect(FeatureFlags.proactiveNudges).toBe(true);
    expect(FeatureFlags.personalizationV1).toBe(false);
    expect(FeatureFlags.offlineResilience).toBe(true);
  });
});

describe('RouterConfig', () => {
  it('escalation confidence threshold is between 0 and 1', () => {
    expect(RouterConfig.ESCALATE_ON_LOW_CONFIDENCE).toBeGreaterThan(0);
    expect(RouterConfig.ESCALATE_ON_LOW_CONFIDENCE).toBeLessThan(1);
  });
});

describe('AppConfig', () => {
  it('MVP targets smoking habit', () => {
    expect(AppConfig.HABIT_TARGET).toBe('smoking');
  });

  it('crisis resource is 988 for US MVP', () => {
    expect(AppConfig.CRISIS_RESOURCE).toBe('988');
  });
});
