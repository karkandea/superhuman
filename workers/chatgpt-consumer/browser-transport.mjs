import { chromium } from 'playwright'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'

const CHATGPT_URL = 'https://chatgpt.com/'
const PROFILE_DIR = process.env.CHATGPT_BROWSER_PROFILE_DIR || path.join(os.homedir(), '.superhuman', 'chatgpt-profile')
const CHROME_BIN = process.env.CHATGPT_CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CDP_PORT = Number(process.env.CHATGPT_CDP_PORT || 9222)
const CDP_URL = process.env.CHATGPT_CDP_URL || `http://127.0.0.1:${CDP_PORT}`
const HEADLESS = process.env.CHATGPT_HEADLESS !== 'false'

export class WorkerError extends Error {
  constructor(code, message, retryable = true) {
    super(message)
    this.name = 'WorkerError'
    this.code = code
    this.retryable = retryable
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first()
    if (await locator.isVisible().catch(() => false)) return locator
  }
  return null
}

async function throwIfProviderRateLimited(page) {
  const modal = page.locator('[data-testid="modal-conversation-history-rate-limit"]').first()
  if (await modal.isVisible().catch(() => false)) {
    throw new WorkerError(
      'provider_rate_limited',
      'ChatGPT temporarily rate-limited the browser session. Player context is safe and the job will retry later.',
      true,
    )
  }
}

async function waitForComposer(page, deadline) {
  const selectors = [
    '#prompt-textarea',
    'textarea[placeholder*="Message"]',
    'div[contenteditable="true"][data-placeholder]',
    'div[contenteditable="true"]',
  ]

  while (Date.now() < deadline) {
    await throwIfProviderRateLimited(page)
    const composer = await firstVisible(page, selectors)
    if (composer) return composer

    const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase()
    const url = page.url().toLowerCase()
    if (url.includes('/auth/login') || /log in|sign up/.test(body)) {
      throw new WorkerError('browser_auth_required', 'ChatGPT browser session is not authenticated', false)
    }
    if (/verify you are human|checking your browser|security check/.test(body)) {
      throw new WorkerError('browser_challenge', 'ChatGPT browser challenge blocked the worker', true)
    }
    await sleep(500)
  }

  throw new WorkerError('composer_not_found', 'ChatGPT prompt composer was not found', true)
}

async function waitForAssistantResponse(page, previousCount, deadline) {
  const assistantMessages = page.locator('[data-message-author-role="assistant"]')

  while (Date.now() < deadline) {
    await throwIfProviderRateLimited(page)
    if (await assistantMessages.count() > previousCount) break
    await sleep(500)
  }

  if (await assistantMessages.count() <= previousCount) {
    throw new WorkerError('generation_timeout', 'ChatGPT did not start an assistant response before timeout', true)
  }

  let previousText = ''
  let stablePasses = 0

  while (Date.now() < deadline) {
    await throwIfProviderRateLimited(page)
    const count = await assistantMessages.count()
    const latest = assistantMessages.nth(Math.max(0, count - 1))
    const text = (await latest.innerText().catch(() => '')).trim()
    const stopVisible = await firstVisible(page, [
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop"]',
      'button:has-text("Stop generating")',
    ])

    if (text && text === previousText && !stopVisible) stablePasses += 1
    else stablePasses = 0

    if (stablePasses >= 3) return text
    previousText = text
    await sleep(800)
  }

  throw new WorkerError('generation_timeout', 'ChatGPT response did not finish before timeout', true)
}

let connectedBrowser = null
let spawnedChrome = null

async function cdpReady() {
  try {
    const response = await fetch(`${CDP_URL}/json/version`)
    return response.ok
  } catch {
    return false
  }
}

async function waitForCdp(deadline) {
  while (Date.now() < deadline) {
    if (await cdpReady()) return
    await sleep(250)
  }
  throw new WorkerError('browser_start_failed', `Chrome CDP did not become ready at ${CDP_URL}`, true)
}

async function ensureChromeRunning() {
  if (await cdpReady()) return

  await fs.mkdir(PROFILE_DIR, { recursive: true, mode: 0o700 })
  await fs.chmod(PROFILE_DIR, 0o700).catch(() => {})

  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...(HEADLESS ? ['--headless=new'] : []),
    CHATGPT_URL,
  ]

  spawnedChrome = spawn(CHROME_BIN, args, { detached: true, stdio: 'ignore' })
  spawnedChrome.unref()
  await waitForCdp(Date.now() + 20_000)
}

async function connectBrowser() {
  if (connectedBrowser?.isConnected()) return connectedBrowser
  await ensureChromeRunning()
  connectedBrowser = await chromium.connectOverCDP(CDP_URL)
  connectedBrowser.on('disconnected', () => { connectedBrowser = null })
  return connectedBrowser
}

async function chatGptContext() {
  const browser = await connectBrowser()
  const context = browser.contexts()[0]
  if (!context) throw new WorkerError('browser_context_missing', 'Dedicated Chrome has no browser context', true)
  return context
}

export class PlaywrightChatGptTransport {
  async execute({ prompt, timeoutMs }) {
    const context = await chatGptContext()
    const page = await context.newPage()

    try {
      const deadline = Date.now() + timeoutMs
      await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, 45000) })
      await throwIfProviderRateLimited(page)

      const composer = await waitForComposer(page, deadline)
      const assistantMessages = page.locator('[data-message-author-role="assistant"]')
      const previousCount = await assistantMessages.count()

      await composer.fill(prompt)
      await throwIfProviderRateLimited(page)

      const sendButton = await firstVisible(page, [
        'button[data-testid="send-button"]',
        'button[aria-label*="Send"]',
      ])

      if (sendButton) await sendButton.click()
      else await composer.press('Enter')

      const text = await waitForAssistantResponse(page, previousCount, deadline)
      const match = page.url().match(/\/c\/([^/?#]+)/)

      return {
        text,
        conversationRef: match?.[1],
        modelLabel: 'chatgpt-consumer-auto',
      }
    } finally {
      await page.close().catch(() => {})
    }
  }
}

export async function loginMode() {
  const browser = await connectBrowser()

  try {
    const context = browser.contexts()[0]
    if (!context) throw new WorkerError('browser_context_missing', 'Dedicated Chrome has no browser context', true)

    let page = context.pages().find(candidate => candidate.url().includes('chatgpt.com'))
    if (!page) page = await context.newPage()
    if (!page.url().includes('chatgpt.com')) await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded' })

    process.stdout.write(`Connected to dedicated Chrome at ${CDP_URL}\nVerifying the current ChatGPT session without reopening the profile.\n`)
    await waitForComposer(page, Date.now() + 60_000)
    process.stdout.write('ChatGPT session detected. Dedicated Chrome is ready for worker use.\n')
  } finally {
    // connectOverCDP attaches to an externally managed Chrome. Closing this connected
    // Browser object disconnects Playwright without terminating the persistent Chrome process.
    await browser.close().catch(() => {})
    connectedBrowser = null
  }
}

export function browserRuntimeSummary() {
  return `ChatGPT profile: ${PROFILE_DIR}; cdp=${CDP_URL}; headless=${HEADLESS}`
}
