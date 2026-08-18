import { createClient } from '@supabase/supabase-js'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const positional = args.filter((arg) => arg !== '--dry-run')
const [playerIdRaw, emailRaw] = positional

const supabaseUrl = process.env.SUPABASE_URL
const adminKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function fail(message) {
  console.error(message)
  process.exit(1)
}

if (!playerIdRaw || !emailRaw) {
  fail('Usage: node scripts/create-auth-user.mjs [--dry-run] <existing-player-uuid> <email>')
}

const playerId = playerIdRaw.trim().toLowerCase()
const email = emailRaw.trim().toLowerCase()

if (!UUID_V4.test(playerId)) fail(`Invalid UUID v4: ${playerIdRaw}`)
if (!EMAIL.test(email)) fail(`Invalid email: ${emailRaw}`)

if (!supabaseUrl || !adminKey) {
  fail('Set SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY). Never expose this key with NEXT_PUBLIC_.')
}

const admin = createClient(supabaseUrl, adminKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
})

const { data: player, error: playerError } = await admin
  .from('users')
  .select('id,name')
  .eq('id', playerId)
  .maybeSingle()

if (playerError) fail(`Could not read public.users: ${playerError.message}`)
if (!player) fail(`No legacy player exists with id ${playerId}`)

async function listAllAuthUsers() {
  const users = []
  const perPage = 1000

  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage })
    if (error) fail(`Could not list Auth users: ${error.message}`)

    users.push(...data.users)
    if (data.users.length < perPage) return users
  }
}

const authUsers = await listAllAuthUsers()
const byId = authUsers.find((user) => user.id.toLowerCase() === playerId)
const byEmail = authUsers.find((user) => user.email?.toLowerCase() === email)

if (byId && byId.email?.toLowerCase() !== email) {
  fail(`Refusing to remap ${player.name}: UUID ${playerId} already belongs to Auth email ${byId.email ?? '(none)'}`)
}

if (byEmail && byEmail.id.toLowerCase() !== playerId) {
  fail(`Refusing to reuse ${email}: it already belongs to Auth UUID ${byEmail.id}`)
}

if (byId && byEmail) {
  console.log(`Already linked: ${player.name} (${player.id}) -> ${email}`)
  process.exit(0)
}

console.log(`${dryRun ? 'DRY RUN' : 'Provision'}: ${player.name} (${player.id}) -> ${email}`)

if (dryRun) {
  console.log('No production Auth mutation performed.')
  process.exit(0)
}

const { data, error } = await admin.auth.admin.createUser({
  id: player.id,
  email,
  email_confirm: true,
})

if (error) fail(`Auth provisioning failed: ${error.message}`)
if (!data.user || data.user.id !== player.id || data.user.email?.toLowerCase() !== email) {
  fail('Auth provisioning returned an unexpected identity; inspect before continuing.')
}

console.log(`Created Supabase Auth user ${data.user.id} for ${data.user.email}`)
