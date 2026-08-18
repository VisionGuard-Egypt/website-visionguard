/* =========================================================================
   Create (or reset) the Vision Guard administrator account.

     npm run admin:create -- --password "Vision2026@"                (remote)
     npm run admin:create -- --password "Vision2026@" --local        (local D1)
     npm run admin:create -- --email someone@visionguardeg.com --password "..."
     npm run admin:create -- --password "..." --print                (SQL only)

   WHY THIS IS A SCRIPT AND NOT AN ENDPOINT
   ----------------------------------------
   An admin can read every employee's timesheet, so the account must not be
   creatable from the public internet. There is no bootstrap URL to find and
   no "first person to register wins" window: functions/api/auth/signup.js
   refuses the administrator addresses outright, and the only way in is this
   script, run by someone who already has the deployment's credentials.

   WHY IT NEEDS SESSION_SECRET
   ---------------------------
   Passwords are peppered with SESSION_SECRET before PBKDF2 (see lib/auth.js).
   A hash built with the wrong secret is a valid-looking row that can never be
   signed into. So this script hashes with the SAME secret the deployment
   uses, and it imports lib/auth.js rather than reimplementing the algorithm —
   there is one hashing implementation in this repo and this is not a second.

   It reads the secret from, in order:
     SESSION_SECRET in the environment, then .dev.vars in the project root.
   For --remote that must be the PRODUCTION secret, the one set under
   Workers & Pages -> Settings -> Variables and Secrets. If it is not, the
   account is created and the password simply will not work.

   Re-running is safe: an existing row has its password reset and its role set
   to admin. Nothing else about it is touched.
   ========================================================================= */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { hashPassword, randomId, checkPasswordStrength, DEFAULT_ADMIN_EMAIL } from '../lib/auth.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB = 'visionguardegdata';          // the D1 binding name used in package.json

/* ---------------- arguments ---------------- */
function parseArgs(argv) {
  const out = { local: false, print: false, name: 'Vision Guard Admin' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--local') out.local = true;
    else if (a === '--print') out.print = true;
    else if (a === '--email') out.email = argv[++i];
    else if (a === '--password') out.password = argv[++i];
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--db') out.db = argv[++i];
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function die(message) {
  console.error('\n  ✗ ' + message + '\n');
  process.exit(1);
}

/* ---------------- the secret ---------------- */
function readDevVars() {
  try {
    const text = readFileSync(join(ROOT, '.dev.vars'), 'utf8');
    const vars = {};
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      vars[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    return vars;
  } catch (e) {
    return {};
  }
}

function sessionSecret() {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 24) return { value: fromEnv, source: 'the SESSION_SECRET environment variable' };
  const fromFile = readDevVars().SESSION_SECRET;
  if (fromFile && fromFile.length >= 24) return { value: fromFile, source: '.dev.vars' };
  /* The two shells want this written differently, and getting it wrong is the
     first thing that happens to anyone following a bash line on Windows:
     PowerShell has no `VAR=value command` prefix and reports the assignment
     itself as an unknown command. */
  const how = process.platform === 'win32'
    ? '      $env:SESSION_SECRET = "<the deployment\'s secret>"\n' +
      '      npm run admin:create -- --password "..."'
    : '      SESSION_SECRET="<the deployment\'s secret>" npm run admin:create -- --password "..."';
  die(
    'No SESSION_SECRET found (32+ characters), so the password cannot be hashed\n' +
    '    the way the site will verify it. Set it for this command:\n\n' +
    how + '\n\n' +
    '    or put it in .dev.vars for a --local run. For --remote it must be the\n' +
    '    same value the Pages project has, or the login will fail.'
  );
}

/* SQL string literal: the only character that can break out is a single
   quote, and doubling it is how SQLite escapes one. */
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/* ---------------- main ---------------- */
const args = parseArgs(process.argv.slice(2));
const db = args.db || DB;

const email = String(args.email || DEFAULT_ADMIN_EMAIL).trim().toLowerCase();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) die(`"${email}" is not an email address.`);

if (!args.password) {
  die(
    'Give the password on the command line:\n\n' +
    '      npm run admin:create -- --password "Vision2026@"\n\n' +
    '    It is not stored in this repository on purpose. Note that it will be\n' +
    '    in your shell history — change it from the account once you are in.'
  );
}

try {
  checkPasswordStrength(args.password);
} catch (err) {
  die(`That password is rejected by the same check the signup form uses: ${err.message}`);
}

const { value: secret, source } = sessionSecret();
const env = { SESSION_SECRET: secret, PBKDF2_ITERATIONS: process.env.PBKDF2_ITERATIONS };

const pwHash = await hashPassword(env, args.password);
const now = new Date().toISOString();
const id = randomId(16);

/* terms_at is stamped because the column records that consent was given, and
   for an account created by the company for itself it has been. */
const sql = `
INSERT INTO users
  (id, email, name, phone, pw_hash, role, marketing, newsletter, terms_at, lang, created_at, last_login_at)
VALUES
  (${q(id)}, ${q(email)}, ${q(args.name)}, NULL, ${q(pwHash)}, 'admin', 0, 0, ${q(now)}, 'ar', ${q(now)}, NULL)
ON CONFLICT(email) DO UPDATE SET
  pw_hash = excluded.pw_hash,
  role    = 'admin',
  name    = excluded.name;
`.trim() + '\n';

if (args.print) {
  console.log(sql);
  process.exit(0);
}

console.log(`\n  Vision Guard — administrator account`);
console.log(`  ------------------------------------`);
console.log(`  email     ${email}`);
console.log(`  database  ${db} (${args.local ? 'local' : 'remote'})`);
console.log(`  secret    read from ${source}`);
console.log(`  password  hashed here; neither it nor this file's SQL is kept\n`);

/* --file rather than --command: the hash is base64url and the SQL is
   multi-line, and quoting that through cmd.exe, PowerShell and sh correctly
   is not worth attempting. */
const dir = mkdtempSync(join(tmpdir(), 'vg-admin-'));
const file = join(dir, 'create-admin.sql');
writeFileSync(file, sql, 'utf8');

/* Run wrangler's own entry script under this Node, rather than going through
   `npx`. On Windows npx is npx.cmd, and Node refuses to spawn a .cmd without
   a shell (the fix for CVE-2024-27980), so spawnSync fails with EINVAL before
   wrangler is ever reached. Calling the .js directly sidesteps the shell
   entirely — no quoting rules, same behaviour on every platform. */
const wranglerJs = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

try {
  const local = existsSync(wranglerJs);
  if (!local) {
    die(
      'wrangler is not installed in this project, so the SQL cannot be run.\n' +
      '    Install it first:\n\n' +
      '      npm install\n\n' +
      '    or re-run with --print and apply the SQL yourself.'
    );
  }
  const res = spawnSync(
    process.execPath,
    [wranglerJs, 'd1', 'execute', db, args.local ? '--local' : '--remote', '--file', file, '-y'],
    { stdio: 'inherit', cwd: ROOT }
  );
  if (res.error) die(`Could not run wrangler: ${res.error.message}`);
  if (res.status !== 0) die(`wrangler exited with code ${res.status}. Nothing was changed.`);
} finally {
  try { unlinkSync(file); } catch (e) {}
  try { rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

console.log(`\n  ✓ Done. Sign in at /account.html with ${email}.`);
console.log(`    The Team tab appears next to Attendance.\n`);
