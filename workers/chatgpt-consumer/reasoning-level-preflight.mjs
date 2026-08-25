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

const PICKER_HINT = /\b(gpt(?:[-\s]?5(?:\.\d+)?)?|sol|model|reasoning|thinking|instant|medium|high|extra high|pro|auto|configure|instan|sedang|tinggi)\b/i
const EXCLUDE_CONTROL = /\b(send|submit|voice|record|microphone|mic|attach|upload|tools?|search|canvas|image|plus)\b/i
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function labelsFor(level) {
  return LEVEL_LABELS[level] || [level.replaceAll('_', ' ')]
}

function normalized(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function textMatchesLevel(value, level) {
  const text = normalized(value)
  return labelsFor(level).some(label => {
    const normalizedLabel = normalized(label)
    return text === normalizedLabel
      || text.startsWith(`${normalizedLabel} `)
      || text.endsWith(` ${normalizedLabel}`)
      || text.includes(` ${normalizedLabel} `)
  })
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

async function controlDescriptor(locator) {
  const [innerText, ariaLabel, title, testId, role, state, checked, selected, pressed, hasPopup] = await Promise.all([
    locator.innerText().catch(() => ''),
    locator.getAttribute('aria-label').catch(() => ''),
    locator.getAttribute('title').catch(() => ''),
    locator.getAttribute('data-testid').catch(() => ''),
    locator.getAttribute('role').catch(() => ''),
    locator.getAttribute('data-state').catch(() => ''),
    locator.getAttribute('aria-checked').catch(() => ''),
    locator.getAttribute('aria-selected').catch(() => ''),
    locator.getAttribute('aria-pressed').catch(() => ''),
    locator.getAttribute('aria-haspopup').catch(() => ''),
  ])
  return {
    text: [innerText, ariaLabel, title, testId].filter(Boolean).join(' '),
    innerText,
    ariaLabel,
    title,
    testId,
    role,
    state,
    checked,
    selected,
    pressed,
    hasPopup,
  }
}

function descriptorSelected(descriptor) {
  return descriptor.checked === 'true'
    || descriptor.selected === 'true'
    || descriptor.pressed === 'true'
    || ['checked', 'on', 'active', 'selected'].includes(normalized(descriptor.state))
}

async function composerBox(page) {
  return page.locator('#prompt-textarea, textarea, div[contenteditable="true"]').first().boundingBox().catch(() => null)
}

function distanceFromComposer(box, composer) {
  if (!box || !composer) return Number.POSITIVE_INFINITY
  const dx = Math.max(0, composer.x - (box.x + box.width), box.x - (composer.x + composer.width))
  const dy = Math.max(0, composer.y - (box.y + box.height), box.y - (composer.y + composer.height))
  return Math.sqrt(dx * dx + dy * dy)
}

async function currentLevelDetected(page, level) {
  const controls = page.locator('button, [role="button"], [role="radio"], [role="menuitemradio"], [role="option"]')
  const count = Math.min(await controls.count(), 200)
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index)
    if (!await control.isVisible().catch(() => false)) continue
    const descriptor = await controlDescriptor(control)
    if (!textMatchesLevel(descriptor.text, level)) continue

    if (descriptorSelected(descriptor)) return true
    if (/model|reasoning|thinking|gpt|sol/i.test(descriptor.testId || descriptor.ariaLabel || descriptor.title)) return true

    const box = await control.boundingBox().catch(() => null)
    if (distanceFromComposer(box, await composerBox(page)) <= 180) return true
  }
  return false
}

async function dumpRelevantControls(page) {
  const controls = page.locator('button, [role="button"], [aria-haspopup]')
  const count = Math.min(await controls.count(), 160)
  const composer = await composerBox(page)
  const rows = []

  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index)
    if (!await control.isVisible().catch(() => false)) continue
    const descriptor = await controlDescriptor(control)
    const box = await control.boundingBox().catch(() => null)
    const distance = distanceFromComposer(box, composer)
    if (!PICKER_HINT.test(descriptor.text) && distance > 220) continue
    rows.push({
      i: index,
      text: normalized(descriptor.text).slice(0, 180),
      testid: descriptor.testId || null,
      role: descriptor.role || null,
      popup: descriptor.hasPopup || null,
      distance: Number.isFinite(distance) ? Math.round(distance) : null,
    })
    if (rows.length >= 20) break
  }

  process.stderr.write(`[reasoning-preflight] controls=${JSON.stringify(rows)}\n`)
}

async function modelPicker(page) {
  const explicit = await firstVisible(page, [
    'button[data-testid="model-switcher-dropdown-button"]',
    '[data-testid="model-switcher-dropdown-button"]',
    '[data-testid*="model-switcher"] button',
    'button[data-testid*="model" i]',
    '[role="button"][data-testid*="model" i]',
    'button[data-testid*="reasoning" i]',
    '[role="button"][data-testid*="reasoning" i]',
    'button[aria-label*="model" i]',
    '[role="button"][aria-label*="model" i]',
    'button[aria-label*="reasoning" i]',
    '[role="button"][aria-label*="reasoning" i]',
    'button[aria-label*="thinking" i]',
    '[role="button"][aria-label*="thinking" i]',
  ])
  if (explicit) return explicit

  const composer = await composerBox(page)
  const controls = page.locator('button, [role="button"]')
  const count = Math.min(await controls.count(), 200)
  let best = null

  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index)
    if (!await control.isVisible().catch(() => false)) continue
    const descriptor = await controlDescriptor(control)
    const text = normalized(descriptor.text)
    if (!text || EXCLUDE_CONTROL.test(text)) continue

    const box = await control.boundingBox().catch(() => null)
    const distance = distanceFromComposer(box, composer)
    let score = 0

    if (/model|reasoning|thinking/i.test(descriptor.testId || descriptor.ariaLabel || descriptor.title)) score += 20
    if (/gpt|sol/i.test(text)) score += 14
    if (/instant|medium|high|extra high|pro|auto|configure|instan|sedang|tinggi/i.test(text)) score += 12
    if (descriptor.hasPopup === 'menu' || descriptor.hasPopup === 'listbox') score += 4
    if (distance <= 180) score += 8
    else if (distance <= 300) score += 3

    if (score > 0 && (!best || score > best.score)) best = { locator: control, score }
  }

  if (best) return best.locator
  await dumpRelevantControls(page)
  return null
}

async function findLevelOption(page, level) {
  const labels = labelsFor(level).map(normalized)
  const candidates = page.locator('[role="menuitemradio"], [role="menuitem"], [role="option"], [role="radio"], button, [role="button"]')
  const count = Math.min(await candidates.count(), 220)

  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index)
    if (!await candidate.isVisible().catch(() => false)) continue
    const descriptor = await controlDescriptor(candidate)
    const text = normalized(descriptor.text)
    if (labels.some(label => text === label || text.startsWith(`${label} `))) return candidate
  }
  return null
}

async function selectLevel(page, level, deadline) {
  if (await currentLevelDetected(page, level)) return

  const picker = await modelPicker(page)
  if (!picker) throw new Error('ChatGPT reasoning/model picker was not found in or near the composer')

  await picker.click({ timeout: Math.max(1000, Math.min(10_000, deadline - Date.now())) })
  await sleep(350)

  const option = await findLevelOption(page, level)
  if (!option) {
    await dumpRelevantControls(page)
    throw new Error(`ChatGPT reasoning option ${level} was not found after opening the picker`)
  }

  await option.click({ timeout: Math.max(1000, Math.min(10_000, deadline - Date.now())) })
  await sleep(650)

  if (await currentLevelDetected(page, level)) return

  const reopen = await modelPicker(page)
  if (reopen) {
    await reopen.click().catch(() => {})
    await sleep(250)
    const selectedOption = await findLevelOption(page, level)
    if (selectedOption) {
      const descriptor = await controlDescriptor(selectedOption)
      if (descriptorSelected(descriptor)) {
        await page.keyboard.press('Escape').catch(() => {})
        return
      }
    }
    await page.keyboard.press('Escape').catch(() => {})
  }

  await dumpRelevantControls(page)
  throw new Error(`ChatGPT reasoning option ${level} was clicked but could not be verified as selected`)
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

    if (await currentLevelDetected(page, level)) return true

    const picker = await modelPicker(page)
    if (!picker) return false
    await picker.click({ timeout: Math.max(1000, Math.min(10_000, deadline - Date.now())) }).catch(() => {})
    await sleep(250)
    const option = await findLevelOption(page, level)
    if (!option) return false
    const descriptor = await controlDescriptor(option)
    await page.keyboard.press('Escape').catch(() => {})
    return descriptorSelected(descriptor)
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
