// `npm run audit`: `npm audit` of the production dependencies that fails on advisories at AUDIT_LEVEL or above,
// except those in AUDIT_ALLOWED until their review date (src/config/app.mjs). Run by CI.
// This file only runs npm and prints; the decision lives in ./audit/advisories.mjs.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUDIT_ALLOWED, AUDIT_LEVEL } from '../src/config/app.mjs';
import { auditPasses, auditResult } from './audit/advisories.mjs';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// npm audit exits with 1 whenever it finds anything, so its exit code says nothing here: read the report.
const npm = spawnSync('npm', ['audit', '--omit=dev', '--json'], { cwd: SITE, encoding: 'utf8' });
let report;
try {
  report = JSON.parse(npm.stdout);
} catch {
  console.error(`audit: npm audit gave no report (exit code ${npm.status})\n${npm.stderr}`);
  process.exit(1);
}
if (report.error) {
  console.error(`audit: npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const result = auditResult(report, { level: AUDIT_LEVEL, allowList: AUDIT_ALLOWED, today });
const describe = (a) => `  ${a.id} ${a.severity} ${a.name} ${a.range}: ${a.title}\n  ${a.url}`;
for (const a of result.allowed) console.log(`audit: allowed until ${a.until} (AUDIT_ALLOWED)\n${describe(a)}`);
for (const e of result.unused) console.log(`audit: AUDIT_ALLOWED entry ${e.advisory} matches nothing any more; remove it`);
for (const a of result.expired) {
  console.error(`audit: the allowance ended on ${a.until}; update the dependency or review AUDIT_ALLOWED\n${describe(a)}`);
}
for (const a of result.failing) console.error(`audit: vulnerable\n${describe(a)}`);
if (!auditPasses(result)) process.exit(1);
console.log(`audit: passed (no ${AUDIT_LEVEL}-or-above advisories beyond the allowed ones)`);
