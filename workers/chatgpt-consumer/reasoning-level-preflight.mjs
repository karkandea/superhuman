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
  extra_high: ['extra high', 'ekstra tinggi'],
  pro: ['pro'],
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function labelsFor(level) {
  return LEVEL_LABELS[level] || [level.replaceAll('_', ' ')]
}

function normalized(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function textMatchesLevel(value, level) {
  const text = normalized(value)
  return labelsFor(level).some(label => text === label || text.includes(` ${label}`) || text.startsWith(`${label} `))
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

async function verifyChatGptSession(page) {
  const url = page.url().toLowerCase()
  const body = normalized(await page.locator('body').innerText().catch(() => ''))
  if (!url.startsWith('https://chatgpt.com/')) throw new Error(`Unexpected browser page: ${page.url()}`)
  if (url.includes('/auth/login') || /\blog in\b|\bsign up\b/.test(body)) {
    throw new Error('ChatGPT browser session is not authenticated')
  }
  if (/verify you are human|checking your browser|security check/.test(body)) {
    throw new Error('ChatGPT browser challenge blocked reasoning-level verification')
  }
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first()
    if (await locator.isVisible().catch(() => false)) return locator
  }
  return null
}

async function locatorText(locator) {
  const [innerText, ariaLabel, title] = await Promise.all([
    locator.innerText().catch(() => ''),
    locator.getAttribute('aria-label').catch(() => ''),
    locator.getAttribute('title').catch(() => ''),
  ])
  return [innerText, ariaLabel, title].filter(Boolean).join(' ')
}

async function currentLevelDetected(page, level) {
  const explicit = await firstVisible(page, [
    'button[data-testid="model-switcher-dropdown-button"]',
    '[data-testid="model-switcher-dropdown-button"]',
    '[data-testid*="model-switcher"] button',
    'button[aria-label*="model" i]',
    'button[aria-label*="reasoning" i]',
  ])
  if (explicit && textMatchesLevel(await locatorText(explicit), level)) return true

  for (const label of labelsFor(level)) {
    const selected = await firstVisible(page, [
      `[role="radio"][aria-checked="true"]:has-text("${label}")`,
      `[role="menuitemradio"][aria-checked="true"]:has-text("${label}")`,
      `[role="option"][aria-selected="true"]:has-text("${label}")`,
      `button[aria-pressed="true"]:has-text("${label}")`,
    ])
    if (selected) return true
  }
  return false
}

async function modelPicker(page) {
  const explicit = await firstVisible(page, [
    'button[data-testid="model-switcher-dropdown-button"]',
    '[data-testid="model-switcher-dropdown-button"]',
    '[data-testid*="model-switcher"] button',
    'button[aria-label*="model" i]',
    'button[aria-label*="reasoning" i]',
  ])
  if (explicit) return explicit

  const buttons = page.locator('button')
  const count = Math.min(await buttons.count(), 120)
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index)
    if (!await button.isVisible().catch(() => false)) continue
    const text = normalized(await locatorText(button))
    if (/\b(instant|medium|high|extra high|pro|instan|sedang|tinggi|ekstra tinggi)\b/.test(text)) return button
  }
  return null
}

async function selectLevel(page, level, deadline) {
  if (await currentLevelDetected(page, level)) return

  const picker = await modelPicker(page)
  if (!picker) throw new Error('ChatGPT reasoning/model picker was not found in the composer')
  await picker.click({ timeout: Math.max(1000, Math.min(10_000, deadline - Date.now())) })
  await sleep(250)

  let option = null
  for (const label of labelsFor(level)) {
    option = await firstVisible(page, [
      `[role="menuitemradio"]:has-text("${label}")`,
      `[role="menuitem"]:has-text("${label}")`,
      `[role="option"]:has-text("${label}")`,
      `[role="radio"]:has-text("${label}")`,
      `button:has-text("${label}")`,
    ])
    if (option) break
  }

  if (!option) throw new Error(`ChatGPT reasoning option ${level} is not available for this account/session`)
  await option.click({ timeout: Math.max(1000, Math.min(10_000, deadline - Date.now())) })
  await sleep(500)

  if (!await currentLevelDetected(page, level)) {
    throw new Error(`ChatGPT reasoning option ${level} was clicked but could not be verified as selected`)
  }
}

async function verifyFreshChatPersistence(context, level, deadline) {
  const page = await context.newPage()
  try {
    await page.goto(CHATGPT_URL, {
      waitUntil: 'domcontentloaded',
      timeout: Math.max(1000, Math.min(30_000, deadline - Date.now())),
    })
    await verifyChatGptSession(page)
    await page.locator('#prompt-textarea, textarea, div[contenteditable="true"]').first().waitFor({
      state: 'visible',
      timeout: Math.max(1000, Math.min(15_000, deadline - Date.now())),
    })
    return currentLevelDetected(page, level)
  } finally {
    await page.close().catch(() => {})
  }
}

async function main() {
  if (!['instant', 'medium', 'high', 'extra_high', 'pro'].includes(REQUIRED_LEVEL)) {
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
      await verifyChatGptSession(page)
      await page.locator('#prompt-textarea, textarea, div[contenteditable="true"]').first().waitFor({
        state: 'visible',
        timeout: Math.max(1000, Math.min(15_000, deadline - Date.now())),
      })
      await selectLevel(page, REQUIRED_LEVEL, deadline)
    } finally {
      await page.close().catch(() => {})
    }

    if (!await verifyFreshChatPersistence(context, REQUIRED_LEVEL, deadline)) {
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
