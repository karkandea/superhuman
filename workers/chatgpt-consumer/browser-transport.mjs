import { chromium } from 'playwright'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'

import {
  composerTextMatches,
  composerVerificationLengths,
} from './composer-verification.mjs'

const CHATGPT_URL = 'https://chatgpt.com/'
const TEMPORARY_CHAT_URL = 'https://chatgpt.com/?temporary-chat=true'
const PROFILE_DIR = process.env.CHATGPT_BROWSER_PROFILE_DIR || path.join(os.homedir(), '.superhuman', 'chatgpt-profile')
const CHROME_BIN = process.env.CHATGPT_CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CDP_PORT = Number(process.env.CHATGPT_CDP_PORT || 9222)
const CDP_URL = process.env.CHATGPT_CDP_URL || `http://127.0.0.1:${CDP_PORT}`
const HEADLESS = process.env.CHATGPT_HEADLESS !== 'false'
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024
const PRE_SUBMISSION_RECOVERY_ATTEMPTS = Number(process.env.CHATGPT_PRE_SUBMISSION_RECOVERY_ATTEMPTS || 2)

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

function checkpoint(correlationId, stage, status, detail = '') {
  const request = correlationId ? ` requestId=${correlationId}` : ''
  const suffix = detail ? ` ${detail}` : ''
  process.stdout.write(`[worker-checkpoint]${request} stage=${stage} status=${status}${suffix}\n`)
}

function conversationUrl(conversationRef) {
  const ref = String(conversationRef || '').trim()
  if (!/^[A-Za-z0-9_-]{6,240}$/.test(ref)) {
    throw new WorkerError('conversation_ref_invalid', 'Provider conversation reference is invalid', false)
  }
  return `https://chatgpt.com/c/${encodeURIComponent(ref)}`
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

async function verifyChatGptPage(page) {
  if (!page || page.isClosed()) {
    throw new WorkerError('page_not_ready', 'ChatGPT request page is missing or already closed', true)
  }

  const url = page.url().toLowerCase()
  if (!url.startsWith('https://chatgpt.com/')) {
    throw new WorkerError('page_not_ready', `Unexpected browser page: ${page.url()}`, true)
  }

  await throwIfProviderRateLimited(page)
  const readyState = await page.evaluate(() => document.readyState).catch(() => 'unavailable')
  if (readyState === 'loading' || readyState === 'unavailable') {
    throw new WorkerError('page_not_ready', `ChatGPT page DOM is not ready (readyState=${readyState})`, true)
  }

  const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase()
  if (url.includes('/auth/login') || /log in|sign up/.test(body)) {
    throw new WorkerError('auth_invalid', 'ChatGPT browser session is not authenticated', false)
  }
  if (/verify you are human|checking your browser|security check/.test(body)) {
    throw new WorkerError('browser_challenge', 'ChatGPT browser challenge blocked the worker', true)
  }
}

async function waitForComposer(page, deadline) {
  const selectors = [
    '#prompt-textarea',
    'textarea[placeholder*="Message"]',
    'div[contenteditable="true"][data-placeholder]',
    'div[contenteditable="true"]',
  ]
  let sawVisibleComposer = false

  while (Date.now() < deadline) {
    await verifyChatGptPage(page)
    const composer = await firstVisible(page, selectors)
    if (composer) {
      sawVisibleComposer = true
      if (await composer.isEditable().catch(() => false)) return composer
    }
    await sleep(500)
  }

  if (sawVisibleComposer) {
    throw new WorkerError('composer_not_editable', 'ChatGPT prompt composer was visible but never became editable', true)
  }
  throw new WorkerError('page_not_ready', 'ChatGPT page did not expose a usable prompt composer before timeout', true)
}

async function composerTextCandidates(composer) {
  const tagName = await composer.evaluate(element => element.tagName.toLowerCase()).catch(() => '')
  if (tagName === 'textarea' || tagName === 'input') {
    return [String(await composer.inputValue().catch(() => ''))]
  }

  const [innerText, textContent] = await Promise.all([
    composer.innerText().catch(() => ''),
    composer.textContent().catch(() => ''),
  ])
  return [...new Set([String(innerText || ''), String(textContent || '')])]
}

async function fillComposerVerified(composer, prompt, deadline) {
  let fillError = null
  try {
    await composer.fill(prompt, { timeout: timeoutUntil(deadline, 60_000) })
  } catch (error) {
    fillError = error
  }

  const candidates = await composerTextCandidates(composer)
  if (composerTextMatches(prompt, candidates)) return

  const lengths = composerVerificationLengths(prompt, candidates)
  const reason = fillError ? 'fill_timeout' : 'content_mismatch'
  throw new WorkerError(
    'composer_fill_failed',
    `ChatGPT composer fill failed (${reason}; expectedChars=${lengths.expectedChars}, actualChars=${lengths.actualChars})`,
    true,
  )
}

async function waitForAssistantResponse(page, previousCount, deadline) {
  const assistantMessages = page.locator('[data-message-author-role="assistant"]')

  while (Date.now() < deadline) {
    await verifyChatGptPage(page)
    if (await assistantMessages.count() > previousCount) break
    await sleep(500)
  }

  if (await assistantMessages.count() <= previousCount) {
    throw new WorkerError('generation_timeout', 'ChatGPT did not start an assistant response before timeout', true)
  }

  let previousText = ''
  let stablePasses = 0

  while (Date.now() < deadline) {
    await verifyChatGptPage(page)
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
  await verifyChatGptPage(page)
}

async function waitForSendReady(page, deadline) {
  const selectors = [
    'button[data-testid="send-button"]',
    'button[aria-label*="Send"]',
  ]

  while (Date.now() < deadline) {
    await verifyChatGptPage(page)
    const sendButton = await firstVisible(page, selectors)
    if (sendButton && await sendButton.isEnabled().catch(() => false)) return sendButton
    await sleep(300)
  }
  return null
}

async function waitForSubmissionStarted(page, previousAssistantCount, previousUserCount, deadline) {
  const assistantMessages = page.locator('[data-message-author-role="assistant"]')
  const userMessages = page.locator('[data-message-author-role="user"]')
  const verifyDeadline = Math.min(deadline, Date.now() + 10_000)
  while (Date.now() < verifyDeadline) {
    await verifyChatGptPage(page)
    if (await assistantMessages.count() > previousAssistantCount) return
    if (await userMessages.count() > previousUserCount) return
    const stopVisible = await firstVisible(page, [
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop"]',
      'button:has-text("Stop generating")',
    ])
    if (stopVisible) return
    await sleep(250)
  }
  throw new WorkerError('composer_send_unverified', 'ChatGPT send action could not be verified after click', true)
}

function temporaryChatUrlActive(page) {
  try {
    const url = new URL(page.url())
    return url.searchParams.get('temporary-chat') === 'true'
  } catch {
    return false
  }
}

async function temporaryChatControl(page) {
  return firstVisible(page, [
    'button[data-testid="temporary-chat-button"]',
    'button[aria-label*="Temporary chat"]',
    'button[aria-label*="temporary chat"]',
    '[role="button"][aria-label*="Temporary chat"]',
    'button:has-text("Temporary")',
  ])
}

async function activateTemporaryChat(page, deadline) {
  if (temporaryChatUrlActive(page)) return

  const control = await temporaryChatControl(page)
  if (control) {
    try {
      await control.click({ timeout: timeoutUntil(deadline) })
      await sleep(250)
      await verifyChatGptPage(page)
      if (temporaryChatUrlActive(page)) return
    } catch {
      // Fall through to the deterministic URL fallback.
    }
  }

  await page.goto(TEMPORARY_CHAT_URL, {
    waitUntil: 'domcontentloaded',
    timeout: timeoutUntil(deadline, 45_000),
  })
  await verifyChatGptPage(page)
  if (!temporaryChatUrlActive(page)) {
    throw new WorkerError('temporary_chat_not_active', 'Temporary Chat activation could not be verified', true)
  }
}

async function webSearchSelected(page) {
  return Boolean(await firstVisible(page, [
    '[data-testid*="search"][aria-pressed="true"]',
    'button[aria-label*="Search"][aria-pressed="true"]',
    '[role="button"][aria-label*="Search"][aria-pressed="true"]',
  ]))
}

async function verifyWebSearchActive(page) {
  if (!await webSearchSelected(page)) {
    throw new WorkerError('tool_state_invalid', 'ChatGPT Search selection could not be verified', true)
  }
}

async function activateWebSearch(page, deadline) {
  if (await webSearchSelected(page)) return

  const toolsButton = await firstVisible(page, [
    'button[data-testid="composer-plus-btn"]',
    'button[aria-label*="View all tools"]',
    'button[aria-label*="Tools"]',
    'button[aria-label^="Add"]',
  ])
  if (toolsButton) {
    await toolsButton.click({ timeout: timeoutUntil(deadline) }).catch(() => {})
    await sleep(150)
    const searchItem = await firstVisible(page, [
      '[role="menuitem"]:has-text("Search")',
      '[role="option"]:has-text("Search")',
      'button:has-text("Search")',
      '[role="menuitem"]:has-text("Web search")',
      'button:has-text("Web search")',
    ])
    if (searchItem) {
      await searchItem.click({ timeout: timeoutUntil(deadline) })
      await sleep(200)
      await verifyChatGptPage(page)
      await verifyWebSearchActive(page)
      return
    }
  }

  const composer = await waitForComposer(page, deadline)
  try {
    await composer.fill('/', { timeout: timeoutUntil(deadline) })
  } catch {
    throw new WorkerError('tool_state_invalid', 'ChatGPT Search could not be activated from the composer', true)
  }
  await sleep(200)
  const slashSearch = await firstVisible(page, [
    '[role="option"]:has-text("Search")',
    '[role="menuitem"]:has-text("Search")',
    'button:has-text("Search")',
    '[role="option"]:has-text("Find on the web")',
    '[role="menuitem"]:has-text("Find on the web")',
  ])
  if (!slashSearch) {
    await composer.fill('').catch(() => {})
    throw new WorkerError('tool_state_invalid', 'ChatGPT Search is not available for this browser session', true)
  }
  await slashSearch.click({ timeout: timeoutUntil(deadline) })
  await sleep(200)
  await verifyChatGptPage(page)
  await verifyWebSearchActive(page)
}

async function openFreshChat(page, deadline, temporaryChat) {
  await page.goto(CHATGPT_URL, {
    waitUntil: 'domcontentloaded',
    timeout: timeoutUntil(deadline, 45_000),
  })
  await verifyChatGptPage(page)
  await waitForComposer(page, deadline)

  if (temporaryChat) {
    await activateTemporaryChat(page, deadline)
    await waitForComposer(page, deadline)
  }
}

let connectedBrowser = null
let spawnedChrome = null

async function cdpReady() {
  try {
    const response = await fetch(`${CDP_URL}/json/version`)
    if (!response.ok) return false
    const payload = await response.json().catch(() => null)
    return Boolean(payload?.Browser && payload?.webSocketDebuggerUrl)
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
  if (connectedBrowser?.isConnected() && await cdpReady()) return connectedBrowser
  connectedBrowser = null
  await ensureChromeRunning()
  try {
    connectedBrowser = await chromium.connectOverCDP(CDP_URL)
  } catch (error) {
    await sleep(500)
    await waitForCdp(Date.now() + 10_000)
    try {
      connectedBrowser = await chromium.connectOverCDP(CDP_URL)
    } catch {
      throw new WorkerError('browser_connect_failed', `Could not connect Playwright to Chrome CDP: ${error.message}`, true)
    }
  }
  connectedBrowser.on('disconnected', () => { connectedBrowser = null })
  return connectedBrowser
}

async function chatGptContext() {
  const browser = await connectBrowser()
  const context = browser.contexts()[0]
  if (!context) throw new WorkerError('browser_context_missing', 'Dedicated Chrome has no browser context', true)
  return context
}

async function preparePageForRequest(page, { conversationRef, temporaryChat, webSearch, deadline }) {
  if (conversationRef) {
    await page.goto(conversationUrl(conversationRef), {
      waitUntil: 'domcontentloaded',
      timeout: timeoutUntil(deadline, 45_000),
    })
    await verifyChatGptPage(page)
    await waitForComposer(page, deadline)
  } else {
    await openFreshChat(page, deadline, temporaryChat)
  }
  if (webSearch) await activateWebSearch(page, deadline)
  await verifyChatGptPage(page)
  return waitForComposer(page, deadline)
}

function recoveryStrategy(errorCode) {
  if (errorCode === 'composer_not_editable') return 'reload_composer'
  if (errorCode === 'tool_state_invalid') return 'reset_tool_state'
  if (errorCode === 'temporary_chat_not_active') return 'reset_temporary_chat'
  if (errorCode === 'page_not_ready') return 'reload_page'
  if (errorCode === 'composer_fill_failed') return 'fresh_page'
  return 'fresh_page'
}

async function recoverPreSubmissionPage(context, page, correlationId, attempt, error) {
  const strategy = recoveryStrategy(error.code)
  checkpoint(correlationId, 'recovery', 'start', `attempt=${attempt} code=${error.code || 'unknown'} strategy=${strategy}`)

  if (strategy === 'reload_composer' || strategy === 'reload_page') {
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
      checkpoint(correlationId, 'recovery', 'ready', `attempt=${attempt} strategy=${strategy}`)
      return page
    } catch {
      // Escalate to a new page below. The next attempt still rebuilds all invariants.
    }
  }

  if (strategy === 'reset_tool_state' || strategy === 'reset_temporary_chat') {
    try {
      await page.goto(TEMPORARY_CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      checkpoint(correlationId, 'recovery', 'ready', `attempt=${attempt} strategy=${strategy}`)
      return page
    } catch {
      // Escalate to a new page below.
    }
  }

  await page?.close().catch(() => {})
  const nextPage = await context.newPage()
  checkpoint(correlationId, 'recovery', 'ready', `attempt=${attempt} strategy=fresh_page`)
  return nextPage
}

export class PlaywrightChatGptTransport {
  async execute({ prompt, correlationId, timeoutMs, attachments = [], conversationRef, temporaryChat = true, webSearch = false }) {
    const materialized = await materializeAttachments(attachments)
    const context = await chatGptContext()
    const deadline = Date.now() + timeoutMs
    let page = await context.newPage()
    let submitted = false

    checkpoint(correlationId, 'step_isolation', 'start', 'page=fresh')

    try {
      let composer = null
      let prepared = false
      for (let attempt = 1; attempt <= Math.max(1, PRE_SUBMISSION_RECOVERY_ATTEMPTS); attempt += 1) {
        try {
          checkpoint(correlationId, 'browser_session', 'ready', `attempt=${attempt}`)
          checkpoint(correlationId, 'chatgpt_state', 'checking', `attempt=${attempt}`)
          composer = await preparePageForRequest(page, { conversationRef, temporaryChat, webSearch, deadline })
          checkpoint(correlationId, 'chatgpt_state', 'ready', `attempt=${attempt}`)

          checkpoint(correlationId, 'prompt_fill', 'checking', `attempt=${attempt}`)
          await fillComposerVerified(composer, prompt, deadline)
          checkpoint(correlationId, 'prompt_fill', 'verified', `attempt=${attempt}`)
          prepared = true
          break
        } catch (rawError) {
          const error = rawError instanceof WorkerError
            ? rawError
            : new WorkerError('page_not_ready', rawError instanceof Error ? rawError.message : String(rawError), true)
          checkpoint(correlationId, 'chatgpt_state', 'failed', `attempt=${attempt} code=${error.code}`)
          if (submitted || !error.retryable || attempt >= Math.max(1, PRE_SUBMISSION_RECOVERY_ATTEMPTS)) throw error
          page = await recoverPreSubmissionPage(context, page, correlationId, attempt, error)
        }
      }

      if (!composer || !prepared) throw new WorkerError('page_not_ready', 'ChatGPT pre-submission invariants were not prepared', true)
      checkpoint(correlationId, 'step_isolation', 'ready', `temporaryChat=${temporaryChat} webSearch=${webSearch}`)

      const assistantMessages = page.locator('[data-message-author-role="assistant"]')
      const userMessages = page.locator('[data-message-author-role="user"]')
      const previousAssistantCount = await assistantMessages.count()
      const previousUserCount = await userMessages.count()

      if (materialized.paths.length > 0) {
        checkpoint(correlationId, 'attachments', 'checking', `count=${materialized.paths.length}`)
        await attachFiles(page, materialized.paths, deadline)
        checkpoint(correlationId, 'attachments', 'accepted', `count=${materialized.paths.length}`)
      }
      await verifyChatGptPage(page)

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

      checkpoint(correlationId, 'prompt_submit', 'checking')
      try {
        await sendButton.click({ timeout: timeoutUntil(deadline) })
      } catch {
        throw new WorkerError('composer_send_timeout', 'ChatGPT send action did not complete before timeout', true)
      }
      submitted = true
      await waitForSubmissionStarted(page, previousAssistantCount, previousUserCount, deadline)
      checkpoint(correlationId, 'prompt_submit', 'verified')

      checkpoint(correlationId, 'generation', 'waiting')
      const text = await waitForAssistantResponse(page, previousAssistantCount, deadline)
      if (!text.trim()) throw new WorkerError('generation_empty', 'ChatGPT completed without a usable assistant response', true)
      checkpoint(correlationId, 'generation', 'verified', `chars=${text.length}`)

      const match = page.url().match(/\/c\/([^/?#]+)/)
      return {
        text,
        conversationRef: match?.[1],
        modelLabel: webSearch ? 'chatgpt-consumer-search' : 'chatgpt-consumer-auto',
      }
    } catch (error) {
      if (error instanceof WorkerError && correlationId) {
        error.message = `[requestId=${correlationId}] ${error.message}`
      }
      throw error
    } finally {
      await page?.close().catch(() => {})
      checkpoint(correlationId, 'step_isolation', 'disposed', 'page=closed')
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
    await verifyChatGptPage(page)
    await waitForComposer(page, Date.now() + 60_000)
    process.stdout.write('ChatGPT session detected. Dedicated Chrome is ready for worker use.\n')
  } finally {
    await browser.close().catch(() => {})
    connectedBrowser = null
  }
}

export function browserRuntimeSummary() {
  return `ChatGPT profile: ${PROFILE_DIR}; cdp=${CDP_URL}; headless=${HEADLESS}; freshChats=temporary-ui; research=search-ui; preSubmitRecovery=${PRE_SUBMISSION_RECOVERY_ATTEMPTS}; stepIsolation=fresh-page`
}
