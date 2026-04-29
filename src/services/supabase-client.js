const { createClient } = require('@supabase/supabase-js');

let singleton;

/**
 * Server-side Supabase with service role (bypasses RLS). Used for prospects, DNC, campaign logs.
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
function getSupabase() {
  const url = (process.env.SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) return null;
  if (!singleton) {
    singleton = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return singleton;
}

function supabaseConfigured() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

module.exports = { getSupabase, supabaseConfigured };
