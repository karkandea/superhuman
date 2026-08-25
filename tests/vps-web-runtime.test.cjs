const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

function source(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
}

test('Next.js frontend is packaged as a standalone VPS runtime with a release health endpoint', () => {
  const config = source('next.config.ts')
  const health = source('app/api/health/route.ts')

  assert.match(config, /output:\s*["']standalone["']/)
  assert.match(health, /status:\s*'ok'/)
  assert.match(health, /service:\s*'superhuman-web'/)
  assert.match(health, /SUPERHUMAN_RELEASE_SHA/)
  assert.match(health, /Cache-Control/)
  assert.match(health, /no-store/)
})

test('frontend systemd runtime is isolated and memory bounded', () => {
  const unit = source('ops/vps-web/superhuman-web.service')

  assert.match(unit, /User=superhuman-web/)
  assert.match(unit, /HOSTNAME=127\.0\.0\.1/)
  assert.match(unit, /PORT=3000/)
  assert.match(unit, /Restart=on-failure/)
  assert.match(unit, /MemoryHigh=600M/)
  assert.match(unit, /MemoryMax=800M/)
  assert.match(unit, /NoNewPrivileges=true/)
})

test('VPS deploy is health-gated, atomic, and rolls back a bad frontend release', () => {
  const deploy = source('ops/vps-web/deploy.sh')

  assert.match(deploy, /git pull --ff-only origin main/)
  assert.match(deploy, /npm ci/)
  assert.match(deploy, /npm run build/)
  assert.match(deploy, /\.next\/standalone/)
  assert.match(deploy, /current\.next/)
  assert.match(deploy, /mv -Tf/)
  assert.match(deploy, /api\/health/)
  assert.match(deploy, /Rolling back to/)
  assert.match(deploy, /journalctl -u superhuman-web\.service/)
})

test('Nginx keeps the Next.js port private while providing request and error logs', () => {
  const nginx = source('ops/vps-web/nginx-superhuman.conf')
  const tls = source('ops/vps-web/enable-tls.sh')

  assert.match(nginx, /server_name superhuman\.dualangka\.com/)
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:3000/)
  assert.match(nginx, /superhuman\.access\.log/)
  assert.match(nginx, /superhuman\.error\.log/)
  assert.match(nginx, /X-Request-ID/)
  assert.match(tls, /SUPERHUMAN_WEB_EXPECTED_IPV4:-103\.175\.207\.127/)
  assert.match(tls, /DNS is not pointing/)
  assert.match(tls, /certbot --nginx/)
})

test('root preflight reads Git state as the repo owner without weakening global safe-directory policy', () => {
  const preflight = source('ops/vps-web/preflight.sh')

  assert.match(preflight, /SUPERHUMAN_REPO_USER:-superhuman-ai/)
  assert.match(preflight, /sudo -u "\$REPO_USER" -H git -C "\$REPO_DIR" status --short/)
  assert.match(preflight, /sudo -u "\$REPO_USER" -H git -C "\$REPO_DIR" rev-parse HEAD/)
  assert.doesNotMatch(preflight, /safe\.directory|git config --global/)
})
