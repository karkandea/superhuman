/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('player routes expose a local-session logout that returns to auth entry', () => {
  const layout = fs.readFileSync(path.join(process.cwd(), 'app/[username]/layout.tsx'), 'utf8')
  const home = fs.readFileSync(path.join(process.cwd(), 'app/page.tsx'), 'utf8')

  assert.match(layout, /supabase\.auth\.signOut\(\{ scope: 'local' \}\)/)
  assert.match(layout, /router\.replace\('\/'\)/)
  assert.match(layout, /LOG OUT/)
  assert.match(layout, /LOGGING OUT/)
  assert.match(home, /type AuthMode = 'login' \| 'register'/)
  assert.match(home, /signInWithOtp/)
  assert.match(home, /shouldCreateUser: authMode === 'register'/)
})
