import base from './playwright.config.mjs'
export default { ...base, testDir: './browser', testMatch: ['operational-fixture.spec.mjs', 'process-crash.spec.mjs', 'restored-backup.spec.mjs', 'rotation-browser.spec.mjs'], timeout: 180_000,
  reporter: [['list']], outputDir: '/app/artifacts/operational-browser-output' }
