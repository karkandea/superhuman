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

const MODEL_SIGNAL = /\b(chatgpt|gpt(?:[-\s]?5(?:\.\d+)?)?|sol|model|reasoning|thinking|instant|medium|high|extra high|pro|auto|configure|instan|sedang|tinggi)\b/i
const EXCLUDED_SIGNAL = /\b(profile|account|accounts|avatar|sidebar|settings|workspace|history|notification|upgrade|plan|send|submit|voice|record|microphone|mic|attach|upload|tools?|search|canvas|image)\b/i
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function normalized(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function labelsFor(level) {
  return LEVEL_LABELS[level] || [level.replaceAll('_', ' ')]
}

function textMatchesLevel(value, level) {
  const text = normalized(value)
  return labelsFor(level).some(label => {
    const wanted = normalized(label)
    return text === wanted
      || text.startsWith(`${wanted} `)
      || text.endsWith(` ${wanted}`)
      || text.includes(` ${wanted} `)
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

async function descriptor(locator) {
  const [innerText, ariaLabel, title, testId, state, checked, selected, pressed, popup] = await Promise.all([
    locator.innerText().catch(() => ''),
    locator.getAttribute('aria-label').catch(() => ''),
    locator.getAttribute('title').catch(() => ''),
    locator.getAttribute('data-testid').catch(() => ''),
    locator.getAttribute('data-state').catch(() => ''),
    locator.getAttribute('aria-checked').catch(() => ''),
    locator.getAttribute('aria-selected').catch(() => ''),
    locator.getAttribute('aria-pressed').catch(() => ''),
    locator.getAttribute('aria-haspopup').catch(() => ''),
  ])
  const text = [innerText, ariaLabel, title, testId].filter(Boolean).join(' ')
  return { text, innerText, ariaLabel, title, testId, state, checked, selected, pressed, popup }
}

function selected(d) {
  return d.checked === 'true'
    || d.selected === 'true'
    || d.pressed === 'true'
    || ['checked', 'on', 'active', 'selected'].includes(normalized(d.state))
}

function metadataText(d) {
  return normalized([d.ariaLabel, d.title, d.testId].filter(Boolean).join(' '))
}

function excluded(d) {
  return EXCLUDED_SIGNAL.test(normalized(d.text))
}

async function composerBox(page) {
  return page.locator('#prompt-textarea, textarea, div[contenteditable="true"]').first().boundingBox().catch(() => null)
}

function distance(box, target) {
  if (!box || !target) return Number.POSITIVE_INFINITY
  const dx = Math.max(0, target.x - (box.x + box.width), box.x - (target.x + target.width))
  const dy = Math.max(0, target.y - (box.y + box.height), box.y - (target.y + target.height))
  return Math.sqrt(dx * dx + dy * dy)
}

async function dumpControls(page) {
  const controls = page.locator('button, [role="button"], [aria-haspopup]')
  const composer = await composerBox(page)
  const rows = []
  const count = Math.min(await controls.count(), 180)

  for (let i = 0; i < count; i += 1) {
    const control = controls.nth(i)
    if (!await control.isVisible().catch(() => false)) continue
    const d = await descriptor(control)
    const box = await control.boundingBox().catch(() => null)
    const dist = distance(box, composer)
    if (!MODEL_SIGNAL.test(d.text) && dist > 220) continue
    rows.push({
      i,
      text: normalized(d.text).slice(0, 180),
      testid: d.testId || null,
      popup: d.popup || null,
      distance: Number.isFinite(dist) ? Math.round(dist) : null,
    })
    if (rows.length >= 24) break
  }
  process.stderr.write(`[reasoning-preflight] controls=${JSON.stringify(rows)}\n`)
}

async function currentLevelDetected(page, level) {
  const controls = page.locator('button, [role="button"], [role="radio"], [role="menuitemradio"], [role="option"]')
  const count = Math.min(await controls.count(), 220)

  for (let i = 0; i < count; i += 1) {
    const control = controls.nth(i)
    if (!await control.isVisible().catch(() => false)) continue
    const d = await descriptor(control)
    if (excluded(d) || !textMatchesLevel(d.text, level)) continue
    if (selected(d)) return true
    if (/model|reasoning|thinking|gpt|sol/.test(metadataText(d))) return true
  }
  return false
}

async function explicitPicker(page) {
  const selectors = [
    'button[data-testid="model-switcher-dropdown-button"]',
    '[role="button"][data-testid="model-switcher-dropdown-button"]',
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
  ]

  for (const selector of selectors) {
    const candidate = page.locator(selector).first()
    if (!await candidate.isVisible().catch(() => false)) continue
    const d = await descriptor(candidate)
    if (!excluded(d)) return candidate
  }
  return null
}

async function modelPicker(page) {
  const explicit = await explicitPicker(page)
  if (explicit) return explicit

  const composer = await composerBox(page)
  const controls = page.locator('button, [role="button"]')
  const count = Math.min(await controls.count(), 220)
  let best = null

  for (let i = 0; i < count; i += 1) {
    const control = controls.nth(i)
    if (!await control.isVisible().catch(() => false)) continue
    const d = await descriptor(control)
    const text = normalized(d.text)
    const meta = metadataText(d)

    if (!text || excluded(d)) continue

    const semantic = /model|reasoning|thinking/.test(meta)
      || /\b(chatgpt|gpt(?:[-\s]?5(?:\.\d+)?)?|sol|instant|medium|high|extra high|pro|auto|configure|instan|sedang|tinggi)\b/.test(text)
    if (!semantic) continue

    const box = await control.boundingBox().catch(() => null)
    const dist = distance(box, composer)
    let score = 0
    if (/model|reasoning|thinking/.test(meta)) score += 30
    if (/\b(chatgpt|gpt(?:[-\s]?5(?:\.\d+)?)?|sol)\b/.test(text)) score += 20
    if (/\b(instant|medium|high|extra high|pro|auto|configure|instan|sedang|tinggi)\b/.test(text)) score += 16
    if (d.popup === 'menu' || d.popup === 'listbox') score += 6
    if (dist <= 180) score += 4
    else if (dist <= 320) score += 2

    if (!best || score > best.score) best = { locator: control, score, d }
  }

  if (best) {
    process.stderr.write(`[reasoning-preflight] picker=${JSON.stringify({ text: normalized(best.d.text).slice(0, 160), testid: best.d.testId || null, score: best.score })}\n`)
    return best.locator
  }

  await dumpControls(page)
  return null
}

async function findLevelOption(page, level) {
  const labels = labelsFor(level).map(normalized)
  const candidates = page.locator('[role="menuitemradio"], [role="menuitem"], [role="option"], [role="radio"], button, [role="button"]')
  const count = Math.min(await candidates.count(), 260)

  for (let i = 0; i < count; i += 1) {
    const candidate = candidates.nth(i)
    if (!await candidate.isVisible().catch(() => false)) continue
    const d = await descriptor(candidate)
    if (excluded(d)) continue
    const text = normalized(d.text)
    if (labels.some(label => text === label || text.startsWith(`${label} `))) return candidate
  }
  return null
}

async function selectLevel(page, level, deadline) {
  if (await currentLevelDetected(page, level)) return

  const picker = await modelPicker(page)
  if (!picker) throw new Error('ChatGPT reasoning/model picker was not found')

  await picker.click({ timeout: Math.max(1000, Math.min(10_000, deadline - Date.now())) })
  await sleep(350)

  const option = await findLevelOption(page, level)
  if (!option) {
    await dumpControls(page)
    throw new Error(`ChatGPT reasoning option ${level} was not found after opening the picker`)
  }

  await option.click({ timeout: Math.max(1000, Math.min(10_000, deadline - Date.now())) })
  await sleep(650)
  if (await currentLevelDetected(page, level)) return

  const reopen = await modelPicker(page)
  if (reopen) {
    await reopen.click({ timeout: 5000 }).catch(() => {})
    await sleep(250)
    const selectedOption = await findLevelOption(page, level)
    if (selectedOption && selected(await descriptor(selectedOption))) {
      await page.keyboard.press('Escape').catch(() => {})
      return
    }
    await page.keyboard.press('Escape').catch(() => {})
  }

  await dumpControls(page)
  throw new Error(`ChatGPT reasoning option ${level} was clicked but could not be verified as selected`)
}

async function freshChatHasLevel(context, level, deadline) {
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
    await picker.click({ timeout: 5000 }).catch(() => {})
    await sleep(250)
    const option = await findLevelOption(page, level)
    if (!option) return false
    const isSelected = selected(await descriptor(option))
    await page.keyboard.press('Escape').catch(() => {})
    return isSelected
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

    if (!await freshChatHasLevel(context, REQUIRED_LEVEL, deadline)) {
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
