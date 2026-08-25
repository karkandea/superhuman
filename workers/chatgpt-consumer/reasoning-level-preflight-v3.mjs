import { chromium } from 'playwright'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'

const CHATGPT_URL = 'https://chatgpt.com/?temporary-chat=true'
const PROFILE_DIR = process.env.CHATGPT_BROWSER_PROFILE_DIR || path.join(os.homedir(), '.superhuman', 'chatgpt-profile')
const CHROME_BIN = process.env.CHATGPT_CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CDP_PORT = Number(process.env.CHATGPT_CDP_PORT || 9222)
const CDP_URL = process.env.CHATGPT_CDP_URL || `http://127.0.0.1:${CDP_PORT}`
const HEADLESS = process.env.CHATGPT_HEADLESS !== 'false'
const REQUIRED_LEVEL = String(process.env.CHATGPT_REASONING_LEVEL || 'high').trim().toLowerCase()
const PREFLIGHT_TIMEOUT_MS = Number(process.env.CHATGPT_REASONING_PREFLIGHT_TIMEOUT_MS || 45_000)
const DO_NOT_RESTART_EXIT_CODE = 78

const LEVEL_LABELS = {
  instant: ['instant', 'instan'],
  medium: ['medium', 'sedang'],
  high: ['high', 'tinggi'],
  extra_high: ['extra high', 'sangat tinggi', 'ekstra tinggi'],
  pro: ['pro'],
}

const ALL_LEVEL_LABELS = Object.values(LEVEL_LABELS).flat()
const EXCLUDED = /\b(profile|account|accounts|avatar|sidebar|settings|workspace|history|notification|upgrade|plan)\b/i
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function normalize(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function requiredLabels(level) {
  return (LEVEL_LABELS[level] || [level.replaceAll('_', ' ')]).map(normalize)
}

function isExactLevel(text, labels) {
  return labels.includes(normalize(text))
}

async function cdpReady() {
  try {
    const response = await fetch(`${CDP_URL}/json/version`)
    if (!response.ok) return false
    const body = await response.json().catch(() => null)
    return Boolean(body?.Browser && body?.webSocketDebuggerUrl)
  } catch {
    return false
  }
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
    'https://chatgpt.com/',
  ]

  const chrome = spawn(CHROME_BIN, args, { detached: true, stdio: 'ignore' })
  chrome.unref()

  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await cdpReady()) return
    await sleep(250)
  }
  throw new Error(`Chrome CDP did not become ready at ${CDP_URL}`)
}

async function verifySession(page) {
  const url = page.url().toLowerCase()
  const body = normalize(await page.locator('body').innerText().catch(() => ''))

  if (!url.startsWith('https://chatgpt.com/')) {
    throw new Error(`Unexpected browser page: ${page.url()}`)
  }
  if (url.includes('/auth/login') || /\blog in\b|\bsign up\b/.test(body)) {
    throw new Error('ChatGPT browser session is not authenticated')
  }
  if (/verify you are human|checking your browser|security check/.test(body)) {
    throw new Error('ChatGPT browser challenge blocked reasoning-level verification')
  }
}

async function waitForComposer(page, deadline) {
  await page.locator('#prompt-textarea, textarea, div[contenteditable="true"]').first().waitFor({
    state: 'visible',
    timeout: Math.max(1000, Math.min(15_000, deadline - Date.now())),
  })
}

async function describe(locator) {
  const [innerText, ariaLabel, title, testId, popup] = await Promise.all([
    locator.innerText().catch(() => ''),
    locator.getAttribute('aria-label').catch(() => ''),
    locator.getAttribute('title').catch(() => ''),
    locator.getAttribute('data-testid').catch(() => ''),
    locator.getAttribute('aria-haspopup').catch(() => ''),
  ])
  return {
    innerText,
    ariaLabel,
    title,
    testId,
    popup,
    combined: [innerText, ariaLabel, title, testId].filter(Boolean).join(' '),
  }
}

function excluded(descriptor) {
  return EXCLUDED.test(descriptor.combined)
}

async function findReasoningTrigger(page, labels = ALL_LEVEL_LABELS.map(normalize)) {
  const candidates = page.locator('[aria-haspopup="menu"], [aria-haspopup="listbox"]')
  const count = Math.min(await candidates.count(), 200)

  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index)
    if (!await candidate.isVisible().catch(() => false)) continue
    const descriptor = await describe(candidate)
    if (excluded(descriptor)) continue
    if (!isExactLevel(descriptor.innerText, labels)) continue
    return { locator: candidate, descriptor }
  }
  return null
}

async function findReasoningOption(page, level) {
  const labels = requiredLabels(level)
  const candidates = page.locator('[role="menuitemradio"], [role="menuitem"], [role="option"], [role="radio"], button, [role="button"]')
  const count = Math.min(await candidates.count(), 260)

  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index)
    if (!await candidate.isVisible().catch(() => false)) continue
    const descriptor = await describe(candidate)
    if (excluded(descriptor)) continue
    if (isExactLevel(descriptor.innerText, labels)) return candidate
  }
  return null
}

async function dumpReasoningControls(page) {
  const candidates = page.locator('[aria-haspopup], [role="menuitemradio"], [role="menuitem"], [role="option"], [role="radio"]')
  const rows = []
  const count = Math.min(await candidates.count(), 220)

  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index)
    if (!await candidate.isVisible().catch(() => false)) continue
    const descriptor = await describe(candidate)
    const text = normalize(descriptor.innerText)
    if (!ALL_LEVEL_LABELS.map(normalize).includes(text) && !/model|reasoning|thinking|gpt|sol/i.test(descriptor.combined)) continue
    rows.push({
      index,
      text,
      popup: descriptor.popup || null,
      testid: descriptor.testId || null,
      aria: descriptor.ariaLabel || null,
    })
    if (rows.length >= 20) break
  }

  process.stderr.write(`[reasoning-preflight] controls=${JSON.stringify(rows)}\n`)
}

async function ensureLevel(page, level, deadline) {
  const wanted = requiredLabels(level)
  const alreadySelected = await findReasoningTrigger(page, wanted)
  if (alreadySelected) {
    process.stdout.write(`[reasoning-preflight] detected current=${normalize(alreadySelected.descriptor.innerText)}\n`)
    return
  }

  const trigger = await findReasoningTrigger(page)
  if (!trigger) {
    await dumpReasoningControls(page)
    throw new Error('ChatGPT reasoning trigger was not found')
  }

  process.stdout.write(`[reasoning-preflight] detected current=${normalize(trigger.descriptor.innerText)} selecting=${level}\n`)
  await trigger.locator.click({
    timeout: Math.max(1000, Math.min(10_000, deadline - Date.now())),
    force: true,
  })
  await sleep(350)

  const option = await findReasoningOption(page, level)
  if (!option) {
    await dumpReasoningControls(page)
    throw new Error(`ChatGPT reasoning option ${level} was not found after opening the reasoning menu`)
  }

  await option.click({
    timeout: Math.max(1000, Math.min(10_000, deadline - Date.now())),
    force: true,
  })
  await sleep(650)

  const verified = await findReasoningTrigger(page, wanted)
  if (!verified) {
    await dumpReasoningControls(page)
    throw new Error(`ChatGPT reasoning level ${level} could not be verified after selection`)
  }

  process.stdout.write(`[reasoning-preflight] selected current=${normalize(verified.descriptor.innerText)}\n`)
}

async function verifyFreshChat(context, level, deadline) {
  const page = await context.newPage()
  try {
    await page.goto(CHATGPT_URL, {
      waitUntil: 'domcontentloaded',
      timeout: Math.max(1000, Math.min(30_000, deadline - Date.now())),
    })
    await verifySession(page)
    await waitForComposer(page, deadline)

    const trigger = await findReasoningTrigger(page, requiredLabels(level))
    if (!trigger) {
      await dumpReasoningControls(page)
      return false
    }

    process.stdout.write(`[reasoning-preflight] fresh-chat current=${normalize(trigger.descriptor.innerText)}\n`)
    return true
  } finally {
    await page.close().catch(() => {})
  }
}

async function main() {
  if (!Object.prototype.hasOwnProperty.call(LEVEL_LABELS, REQUIRED_LEVEL)) {
    throw new Error(`Unsupported CHATGPT_REASONING_LEVEL=${REQUIRED_LEVEL}`)
  }

  await ensureChromeRunning()
  const browser = await chromium.connectOverCDP(CDP_URL)
  const deadline = Date.now() + PREFLIGHT_TIMEOUT_MS

  try {
    const context = browser.contexts()[0]
    if (!context) throw new Error('Dedicated Chrome has no browser context')

    const page = await context.newPage()
    try {
      await page.goto(CHATGPT_URL, {
        waitUntil: 'domcontentloaded',
        timeout: Math.max(1000, Math.min(30_000, deadline - Date.now())),
      })
      await verifySession(page)
      await waitForComposer(page, deadline)
      await ensureLevel(page, REQUIRED_LEVEL, deadline)
    } finally {
      await page.close().catch(() => {})
    }

    if (!await verifyFreshChat(context, REQUIRED_LEVEL, deadline)) {
      throw new Error(`ChatGPT reasoning level ${REQUIRED_LEVEL} did not persist to a fresh Temporary Chat`)
    }

    process.stdout.write(`[reasoning-preflight] verified required=${REQUIRED_LEVEL} profile=${PROFILE_DIR}\n`)
  } finally {
    await browser.close().catch(() => {})
  }
}

main().catch(error => {
  process.stderr.write(`[reasoning-preflight] blocked: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = DO_NOT_RESTART_EXIT_CODE
})
