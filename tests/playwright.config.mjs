import { defineConfig } from '@playwright/test'

const publicRun = process.env.PUBLIC_BROWSER_TESTS === 'true'
const artifactPrefix = publicRun ? 'public-browser' : 'browser'
export default defineConfig({
  testDir: './browser',
  testMatch: publicRun
    ? 'public-browser.spec.mjs'
    : ['browser.spec.mjs', 'account-console.spec.mjs', 'migration-console.spec.mjs', 'experience-browser.spec.mjs', 'browser-oauth.spec.mjs', 'oauth-lifecycle.spec.mjs'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [
    ['list'],
    ['json', { outputFile: `artifacts/${artifactPrefix}-results.json` }],
    ['html', { outputFolder: `artifacts/${artifactPrefix}-report`, open: 'never' }],
  ],
  outputDir: `artifacts/${artifactPrefix}-output`,
  use: {
    browserName: 'chromium',
    ignoreHTTPSErrors: false,
    screenshot: 'off',
    trace: 'off',
    headless: true,
  },
})
