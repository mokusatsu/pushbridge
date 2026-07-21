import { describe, expect, it } from 'vitest';
import { formatBytes, safeFilename, truncate } from './format';

describe('format helpers', () => {
  it('formats byte sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10 MB');
  });

  it('sanitizes download names', () => {
    expect(safeFilename('../bad:name?.txt')).toBe('.._bad_name_.txt');
  });

  it('truncates long values', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 4)).toBe('abc');
  });
});
