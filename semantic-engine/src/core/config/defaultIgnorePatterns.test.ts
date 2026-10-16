import { DEFAULT_IGNORE_DIRECTORIES } from './defaultIgnorePatterns';

describe('DEFAULT_IGNORE_DIRECTORIES', () => {
  it('should include .semantic-engine output directory', () => {
    expect(DEFAULT_IGNORE_DIRECTORIES).toContain('.semantic-engine');
  });
});
