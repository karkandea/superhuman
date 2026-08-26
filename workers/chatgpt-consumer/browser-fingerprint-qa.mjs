import { chromium } from 'playwright'
import os from 'node:os'
import path from 'node:path'

const TARGET_URL = process.env.QA_BROWSER_CHECK_URL || 'http://localhost:3000/qa/browser-check'
const MODE = String(process.env.QA_BROWSER_MODE || 'ephemeral').trim().toLowerCase()
const HEADLESS = process.env.QA_BROWSER_HEADLESS === 'true'
const PROFILE_DIR = process.env.QA_BROWSER_PROFILE_DIR || path.join(os.tmpdir(), 'superhuman-qa-browser-profile')
const CDP_URL = process.env.QA_BROWSER_CDP_URL || 'http://127.0.0.1:9223'

function assertLocalQaTarget(value) {
  const url = new URL(value)
  const localHosts = new Set(['localhost', '127.0.0.1', '::1'])
  if (!localHosts.has(url.hostname)) {
    throw new Error(
      `QA_BROWSER_CHECK_URL must point to a local QA endpoint; received ${url.origin}`,
    )
  }
  return url.toString()
}

async function collectFingerprint(page) {
  return page.evaluate(() => ({
    webdriver: navigator.webdriver,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    languages: Array.from(navigator.languages || []),
    plugins: Array.from(navigator.plugins || []).map(plugin => plugin.name),
    mimeTypes: Array.from(navigator.mimeTypes || []).map(mimeType => mimeType.type),
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
    chrome: Boolean(window.chrome),
    outerWidth: window.outerWidth,
    innerWidth: window.innerWidth,
    outerHeight: window.outerHeight,
    innerHeight: window.innerHeight,
  }))
}

async function openQaPage() {
  if (MODE === 'ephemeral') {
    const browser = await chromium.launch({ headless: HEADLESS })
    const context = await browser.newContext()
    const page = await context.newPage()
    return { browser, context, page, close: () => browser.close() }
  }

  if (MODE === 'persistent') {
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: HEADLESS,
      viewport: null,
    })
    const page = context.pages()[0] ?? await context.newPage()
    return { browser: null, context, page, close: () => context.close() }
  }

  if (MODE === 'cdp') {
    const browser = await chromium.connectOverCDP(CDP_URL)
    const context = browser.contexts()[0]
    if (!context) throw new Error(`No browser context available at ${CDP_URL}`)
    const page = await context.newPage()
    return { browser, context, page, close: async () => {
      await page.close().catch(() => {})
      await browser.close().catch(() => {})
    } }
  }

  throw new Error(`Unsupported QA_BROWSER_MODE=${MODE}; use ephemeral, persistent, or cdp`)
}

const targetUrl = assertLocalQaTarget(TARGET_URL)
const session = await openQaPage()

try {
  await session.page.goto(targetUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  })

  const fingerprint = await collectFingerprint(session.page)
  process.stdout.write(`${JSON.stringify({
    mode: MODE,
    targetUrl,
    cdpUrl: MODE === 'cdp' ? CDP_URL : null,
    profileDir: MODE === 'persistent' ? PROFILE_DIR : null,
    fingerprint,
  }, null, 2)}\n`)
} finally {
  await session.close()
}
