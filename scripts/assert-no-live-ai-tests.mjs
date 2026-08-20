import fs from 'node:fs'
import path from 'node:path'

const testsDir = path.join(process.cwd(), 'tests')
const forbidden = [
  {
    label: 'direct browser transport import',
    pattern: /(?:require\s*\(|from\s+|import\s*\()\s*['"][^'"]*browser-transport\.mjs['"]/,
  },
  {
    label: 'live AI smoke opt-in inside ordinary tests',
    pattern: /SUPERHUMAN_LIVE_AI_SMOKE\s*=\s*['"]?1/,
  },
  {
    label: 'Playwright ChatGPT transport construction',
    pattern: /new\s+PlaywrightChatGptTransport\s*\(/,
  },
]

const violations = []
for (const entry of fs.readdirSync(testsDir, { withFileTypes: true })) {
  if (!entry.isFile() || !/\.test\.cjs$/.test(entry.name)) continue
  const file = path.join(testsDir, entry.name)
  const source = fs.readFileSync(file, 'utf8')
  for (const rule of forbidden) {
    if (rule.pattern.test(source)) violations.push(`${entry.name}: ${rule.label}`)
  }
}

if (violations.length > 0) {
  console.error('Refusing to run ordinary tests because live ChatGPT access was detected:')
  for (const violation of violations) console.error(`- ${violation}`)
  console.error('Use FakeAiProvider for tests. Live model validation must use the explicit live smoke command only.')
  process.exit(1)
}

console.log('AI test safety: ordinary suite is mock-only; live ChatGPT transport is not reachable.')
