#!/usr/bin/env node
// Release gate: fail if anything that will be committed or packed looks like a real credential.
// Scans tracked-to-be files (src, tests, docs, root config, lib) for token-shaped strings outside the
// obviously fake test fixtures, and for credential files that must never ship.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const skipDirs = new Set(['node_modules', '.git', '.venv']);
const forbiddenNames = [/^\.env(\..*)?$/, /^\.credentials\.yaml$/, /^grant\.enc$/];
const rules = [
  { name: 'Twitch-style 30-char token assigned to a credential field', re: /(access_token|refresh_token|client_secret|clientSecret|accessToken|refreshToken)["']?\s*[:=]\s*["'](?!fake|new|e2e|rotated|other|selftest|\$\{|<)[a-z0-9]{30,}["']/i },
  { name: 'Authorization header with a literal token', re: /Authorization['"]?\s*[:=]\s*['"](Bearer|OAuth) (?!\$\{|tok|<)[a-z0-9]{20,}/i },
  { name: 'TWITCH_CLIENT_SECRET with a literal value', re: /TWITCH_CLIENT_SECRET\s*[:=]\s*["']?(?!<|"<)[a-z0-9]{20,}/i },
];

const problems = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skipDirs.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (forbiddenNames.some((re) => re.test(name))) problems.push(`${relative(root, p)}: credential file must not be in the project`);
    if (st.size > 2_000_000 || /\.(png|jpe?g|webp|gif|woff2?|map)$/.test(name)) continue;
    const text = readFileSync(p, 'utf8');
    for (const rule of rules) {
      const m = rule.re.exec(text);
      if (m) problems.push(`${relative(root, p)}: ${rule.name}: ${m[0].slice(0, 40)}…`);
    }
  }
}
walk(root);
if (problems.length) {
  console.error(`check-secrets: ${problems.length} problem(s)\n${problems.join('\n')}`);
  process.exit(1);
}
console.log('check-secrets: no credentials found');
