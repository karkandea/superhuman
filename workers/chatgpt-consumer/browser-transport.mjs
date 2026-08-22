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
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024

export class WorkerError extends Error {
  constructor(code, message, retryable = true) {
    super(message)
    this.name = 'WorkerError'
    this.code = code
    this.retryable = retryable
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function timeoutUntil(deadline, cap = 30_000) {
  return Math.max(1_000, Math.min(cap, deadline - Date.now()))
}

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

function safeAttachmentName(value, index) {
  const base = path.basename(String(value || `attachment-${index}`)).replace(/[^A-Za-z0-9._-]/g, '_')
  return base.slice(0, 180) || `attachment-${index}`
}

async function materializeAttachments(attachments = []) {
  if (!attachments.length) return { paths: [], cleanup: async () => {} }
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'superhuman-ai-attachments-'))
  const paths = []

  try {
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index]
      if (attachment.kind !== 'audio') throw new WorkerError('attachment_type_unsupported', 'Only audio model attachments are supported', false)
      const response = await fetch(attachment.sourceUrl)
      if (!response.ok) throw new WorkerError('attachment_download_failed', `Audio evidence could not be loaded (${response.status})`, true)
      const declaredSize = Number(response.headers.get('content-length') || 0)
      if (declaredSize > MAX_ATTACHMENT_BYTES) throw new WorkerError('attachment_too_large', 'Audio evidence exceeds the 15 MB worker limit', false)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length < 1 || bytes.length > MAX_ATTACHMENT_BYTES) throw new WorkerError('attachment_too_large', 'Audio evidence is empty or exceeds the 15 MB worker limit', false)
      const filePath = path.join(tempDir, `${index}-${safeAttachmentName(attachment.fileName, index)}`)
      await fs.writeFile(filePath, bytes, { mode: 0o600 })
      paths.push(filePath)
    }
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }

  return {
    paths,
    cleanup: async () => { await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {}) },
  }
}

async function waitForFileInput(page, deadline) {
  while (Date.now() < deadline) {
    const input = page.locator('input[type="file"]').first()
    if (await input.count().catch(() => 0)) return input
    await sleep(200)
  }
  return null
}

async function attachFiles(page, filePaths, deadline) {
  if (!filePaths.length) return

  let fileInput = await waitForFileInput(page, Date.now() + 750)
  if (!fileInput) {
    const attachButton = await firstVisible(page, [
      'button[data-testid="composer-plus-btn"]',
      'button[aria-label*="Attach"]',
      'button[aria-label*="Add photos"]',
      'button[aria-label*="Add files"]',
      'button[aria-label*="Upload"]',
    ])
    if (attachButton) await attachButton.click({ timeout: timeoutUntil(deadline) })

    const uploadMenuItem = await firstVisible(page, [
      '[role="menuitem"]:has-text("Upload from computer")',
      '[role="menuitem"]:has-text("Upload files")',
      'button:has-text("Upload from computer")',
    ])
    if (uploadMenuItem) await uploadMenuItem.click({ timeout: timeoutUntil(deadline) }).catch(() => {})
    fileInput = await waitForFileInput(page, Math.min(deadline, Date.now() + 5000))
  }

  if (!fileInput) throw new WorkerError('attachment_upload_unavailable', 'ChatGPT file attachment input was not available', true)
  try {
    await fileInput.setInputFiles(filePaths, { timeout: timeoutUntil(deadline, 60_000) })
  } catch {
    throw new WorkerError('attachment_upload_timeout', 'ChatGPT attachment upload did not accept the selected files before timeout', true)
  }
  await throwIfProviderRateLimited(page)
}

async function waitForSendReady(page, deadline) {
  const selectors = [
    'button[data-testid="send-button"]',
    'button[aria-label*="Send"]',
  ]

  while (Date.now() < deadline) {
    await throwIfProviderRateLimited(page)
    const sendButton = await firstVisible(page, selectors)
    if (sendButton && await sendButton.isEnabled().catch(() => false)) return sendButton
    await sleep(300)
  }
  return null
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
  async execute({ prompt, correlationId, timeoutMs, attachments = [] }) {
    const materialized = await materializeAttachments(attachments)
    const context = await chatGptContext()
    const page = await context.newPage()

    try {
      const deadline = Date.now() + timeoutMs
      await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, 45000) })
      await throwIfProviderRateLimited(page)

      const composer = await waitForComposer(page, deadline)
      const assistantMessages = page.locator('[data-message-author-role="assistant"]')
      const previousCount = await assistantMessages.count()

      // Fill text before adding large audio evidence. ChatGPT temporarily locks or
      // replaces composer state while attachments are being processed; filling after
      // a multi-file upload can time out even though the composer locator is visible.
      try {
        await composer.fill(prompt, { timeout: timeoutUntil(deadline) })
      } catch {
        throw new WorkerError('composer_fill_timeout', 'ChatGPT composer did not accept the request before timeout', true)
      }

      await attachFiles(page, materialized.paths, deadline)
      await throwIfProviderRateLimited(page)

      const sendButton = await waitForSendReady(page, deadline)
      if (!sendButton) {
        throw new WorkerError(
          materialized.paths.length > 0 ? 'attachment_upload_timeout' : 'composer_send_unavailable',
          materialized.paths.length > 0
            ? 'ChatGPT attachments did not become ready to send before timeout'
            : 'ChatGPT send control did not become ready before timeout',
          true,
        )
      }
      try {
        await sendButton.click({ timeout: timeoutUntil(deadline) })
      } catch {
        throw new WorkerError('composer_send_timeout', 'ChatGPT send action did not complete before timeout', true)
      }

      const text = await waitForAssistantResponse(page, previousCount, deadline)
      const match = page.url().match(/\/c\/([^/?#]+)/)

      return {
        text,
        conversationRef: match?.[1],
        modelLabel: 'chatgpt-consumer-auto',
      }
    } catch (error) {
      if (error instanceof WorkerError && correlationId) {
        error.message = `[requestId=${correlationId}] ${error.message}`
      }
      throw error
    } finally {
      await page.close().catch(() => {})
      await materialized.cleanup()
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
