import { countLines } from './encoding';

describe('countLines', () => {
  it('should return 0 for empty content', () => {
    expect(countLines('')).toBe(0);
  });

  it('should match wc -l behavior with trailing newline', () => {
    expect(countLines('a\nb\n')).toBe(2);
  });

  it('should match wc -l behavior without trailing newline', () => {
    expect(countLines('a\nb')).toBe(2);
  });

  it('should return 1 for single line without newline', () => {
    expect(countLines('a')).toBe(1);
  });

  it('should return 1 for single line with trailing newline', () => {
    expect(countLines('a\n')).toBe(1);
  });
});
