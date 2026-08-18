import { createClient } from '@supabase/supabase-js'

const [playerId, email] = process.argv.slice(2)
const supabaseUrl = process.env.SUPABASE_URL
const adminKey = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY

if (!playerId || !email) {
  console.error('Usage: node scripts/create-auth-user.mjs <existing-player-uuid> <email>')
  process.exit(1)
}

if (!supabaseUrl || !adminKey) {
  console.error('Set SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY). Never expose this key with NEXT_PUBLIC_.')
  process.exit(1)
}

const admin = createClient(supabaseUrl, adminKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
})

const { data, error } = await admin.auth.admin.createUser({
  id: playerId,
  email: email.trim().toLowerCase(),
  email_confirm: true,
})

if (error) {
  console.error(error.message)
  process.exit(1)
}

console.log(`Created Supabase Auth user ${data.user.id} for ${data.user.email}`)
