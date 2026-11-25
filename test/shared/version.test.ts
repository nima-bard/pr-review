import { describe, expect, it } from 'vitest';
import { isNewer } from '../../src/shared/version';

describe('isNewer', () => {
  it('compares versions part by part, as numbers', () => {
    expect(isNewer('0.2.0', '0.1.0')).toBe(true);
    expect(isNewer('1.10.0', '1.9.2')).toBe(true);
    expect(isNewer('v1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('0.1.0', '0.1.1')).toBe(false);
    expect(isNewer('2.0', '1.9.9')).toBe(true);
  });

  it('puts a pre-release before its release', () => {
    expect(isNewer('1.2.0', '1.2.0-beta.1')).toBe(true);
    expect(isNewer('1.2.0-beta.1', '1.2.0')).toBe(false);
    expect(isNewer('1.2.0-beta.10', '1.2.0-beta.9')).toBe(true);
  });
});
