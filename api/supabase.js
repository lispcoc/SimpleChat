const Supabase = ({ createClient } = require('@supabase/supabase-js'))

const db = Supabase.createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
)

module.exports = {
  db: db
}
