module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Several suites share the on-disk test fixture and spawn child processes;
  // parallel workers contend for them and make runs flaky (and slower).
  maxWorkers: 1,
  roots: ['<rootDir>/src'],
  /*
  | تست‌ها هرگز در data directory واقعی کاربر نمی‌نویسند. دو لایه لازم است:
  | `globalSetup` روی محیطِ واقعی پروسه اثر می‌گذارد (تا پروسه‌های CLI که
  | تست‌ها spawn می‌کنند هم همان مسیر موقت را ببینند) و `setupFiles` نیمهٔ
  | داخل sandbox است، چون `process.env` در sandbox یک کپی است.
  */
  globalSetup: '<rootDir>/src/test/globalSetupDataDir.ts',
  setupFiles: ['<rootDir>/src/test/setupDataDir.ts'],
  modulePathIgnorePatterns: ['<rootDir>/dist', '<rootDir>/test-fixture'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  /*
  | تا فاز ۱۳ اینجا یک moduleNameMapper برای 'vscode' بود که به یک mock
  | دستی اشاره می‌کرد. هیچ فایلی دیگر vscode را import نمی‌کند
  | (src/host/vscodeCoupling.test.ts این را نگه می‌دارد)، پس هم mock و
  | هم نگاشت حذف شدند.
  */
};
