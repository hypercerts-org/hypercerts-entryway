import base from './playwright.config.mjs'
export default { ...base, testMatch: 'external-migration.spec.mjs', reporter: [['list'], ['json', { outputFile: `artifacts/external-${process.env.EXTERNAL_PHASE ?? 'complete'}-browser.json` }]] }
