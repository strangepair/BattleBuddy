import { computeStreakAndRate, formatCount } from '../sessionStats';

describe('computeStreakAndRate', () => {
  it('returns zero streak and zero rate for no outcomes', () => {
    expect(computeStreakAndRate([])).toEqual({ streak: 0, resistRate: 0 });
  });

  it('ignores null/undefined outcomes', () => {
    expect(computeStreakAndRate([null, undefined])).toEqual({ streak: 0, resistRate: 0 });
  });

  it('counts a streak of consecutive resisted outcomes from the front', () => {
    expect(computeStreakAndRate(['resisted', 'resisted', 'resisted'])).toEqual({
      streak: 3,
      resistRate: 100,
    });
  });

  it('stops the streak at the first non-resisted outcome', () => {
    expect(computeStreakAndRate(['resisted', 'resisted', 'submitted', 'resisted'])).toEqual({
      streak: 2,
      resistRate: 75,
    });
  });

  it('returns a zero streak when the most recent outcome was not a resist', () => {
    expect(computeStreakAndRate(['submitted', 'resisted', 'resisted'])).toEqual({
      streak: 0,
      resistRate: 67,
    });
  });
});

describe('formatCount', () => {
  it('uses singular form for 1', () => {
    expect(formatCount(1, 'session')).toBe('1 session');
    expect(formatCount(1, 'resist')).toBe('1 resist');
  });

  it('uses plural form for 0 and >1', () => {
    expect(formatCount(0, 'session')).toBe('0 sessions');
    expect(formatCount(8, 'session')).toBe('8 sessions');
  });
});
