#!/usr/bin/env node
/**
 * Run all migrations/*.sql in lexical order against DATABASE_URL (or arg).
 * Usage: DATABASE_URL=postgresql://... node scripts/run-migrations.js
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const url = process.argv[2] || process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
if (!url) {
  console.error('Set DATABASE_URL or pass connection string as first argument');
  process.exit(1);
}

const dir = path.join(__dirname, '..', 'migrations');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

async function main() {
  const client = new Client({
    connectionString: url,
    ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  console.log('[migrations] connected');
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    console.log('[migrations] applying', f);
    await client.query(sql);
  }
  await client.end();
  console.log('[migrations] done', files.length, 'files');
}

main().catch((e) => {
  console.error('[migrations] FAIL', e.message);
  process.exit(1);
});
