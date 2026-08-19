import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
if (!url || !key) throw new Error('Missing Supabase public build configuration')

const lock = await readFile('package-lock.json')
const response = await fetch(`${url}/rest/v1/_qa_lock_artifact_20260819`, {
  method: 'POST',
  headers: {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates',
  },
  body: JSON.stringify({
    id: 'canonical',
    payload_b64: lock.toString('base64'),
    byte_length: lock.length,
    sha256: createHash('sha256').update(lock).digest('hex'),
  }),
})
if (!response.ok) throw new Error(`Artifact export failed: ${response.status} ${await response.text()}`)
console.log(`canonical lock exported: ${lock.length} bytes`)
