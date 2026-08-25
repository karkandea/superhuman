import { chromium } from 'playwright'

const CDP_URL = process.env.CHATGPT_CDP_URL || 'http://127.0.0.1:9222'
const CHATGPT_URL = 'https://chatgpt.com/?temporary-chat=true'

function norm(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function clip(value, max = 180) {
  const text = norm(value)
  return text.length > max ? `${text.slice(0, max)}…` : text
}

async function describe(locator, index) {
  const [tag, innerText, ariaLabel, title, testId, role, popup, expanded, state, box] = await Promise.all([
    locator.evaluate(el => el.tagName.toLowerCase()).catch(() => ''),
    locator.innerText().catch(() => ''),
    locator.getAttribute('aria-label').catch(() => ''),
    locator.getAttribute('title').catch(() => ''),
    locator.getAttribute('data-testid').catch(() => ''),
    locator.getAttribute('role').catch(() => ''),
    locator.getAttribute('aria-haspopup').catch(() => ''),
    locator.getAttribute('aria-expanded').catch(() => ''),
    locator.getAttribute('data-state').catch(() => ''),
    locator.boundingBox().catch(() => null),
  ])

  return {
    i: index,
    tag,
    text: clip(innerText),
    aria: clip(ariaLabel),
    title: clip(title),
    testid: testId || null,
    role: role || null,
    popup: popup || null,
    expanded: expanded || null,
    state: state || null,
    box: box ? {
      x: Math.round(box.x),
      y: Math.round(box.y),
      w: Math.round(box.width),
      h: Math.round(box.height),
    } : null,
  }
}

async function scanFrame(frame, frameIndex) {
  const url = frame.url()
  const bodyText = await frame.locator('body').innerText().catch(() => '')
  const interestingBody = norm(bodyText)
    .split(/(?<=[.!?])\s+|\n+/)
    .filter(Boolean)
    .filter(line => /\b(chatgpt|gpt|sol|instant|medium|high|extra high|pro|configure|reasoning|thinking|think)\b/i.test(line))
    .slice(0, 30)
    .map(line => clip(line, 240))

  const selector = [
    'button',
    '[role="button"]',
    '[aria-haspopup]',
    '[role="menuitem"]',
    '[role="menuitemradio"]',
    '[role="option"]',
    '[role="radio"]',
    '[data-testid]',
  ].join(', ')

  const controls = frame.locator(selector)
  const count = Math.min(await controls.count(), 400)
  const rows = []
  for (let i = 0; i < count; i += 1) {
    const locator = controls.nth(i)
    if (!await locator.isVisible().catch(() => false)) continue
    const row = await describe(locator, i)
    const combined = `${row.text} ${row.aria} ${row.title} ${row.testid || ''}`
    const nearHeader = row.box && row.box.y <= 180
    const nearBottom = row.box && row.box.y >= 500
    const interesting = /\b(chatgpt|gpt|sol|instant|medium|high|extra high|pro|configure|model|reasoning|thinking|think)\b/i.test(combined)
      || row.popup
      || nearHeader
      || nearBottom
    if (!interesting) continue
    rows.push(row)
    if (rows.length >= 120) break
  }

  return { frameIndex, url, interestingBody, controls: rows }
}

async function main() {
  const browser = await chromium.connectOverCDP(CDP_URL)
  try {
    const context = browser.contexts()[0]
    if (!context) throw new Error('No browser context on CDP')

    const page = await context.newPage()
    await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.locator('#prompt-textarea, textarea, div[contenteditable="true"]').first().waitFor({ state: 'visible', timeout: 15000 })
    await page.waitForTimeout(1200)

    const result = {
      page: {
        url: page.url(),
        title: await page.title().catch(() => ''),
        viewport: page.viewportSize(),
      },
      frames: [],
    }

    const frames = page.frames()
    for (let i = 0; i < frames.length; i += 1) {
      result.frames.push(await scanFrame(frames[i], i))
    }

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    await page.close().catch(() => {})
  } finally {
    await browser.close().catch(() => {})
  }
}

main().catch(error => {
  process.stderr.write(`[reasoning-dom-diagnostic] failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
