// Tests for the dependency audit (scripts/audit/advisories.mjs) and its settings in src/config/app.mjs.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AUDIT_ALLOWED, AUDIT_LEVEL } from '../../src/config/app.mjs';
import { SEVERITIES, advisories, advisoryId, auditPasses, auditResult } from '../../scripts/audit/advisories.mjs';

const advisory = (id, name, severity) => ({
  source: 1, name, dependency: name, title: `${name} is vulnerable`, url: `https://github.com/advisories/${id}`,
  severity, range: '<=1.0.0',
});

// The shape of `npm audit --json`: a package with its own advisory lists it in `via`; a package affected only
// through a dependency lists that dependency's name.
const REPORT = {
  vulnerabilities: {
    picomatch: { name: 'picomatch', severity: 'high', via: [advisory('GHSA-high', 'picomatch', 'high')] },
    anymatch: { name: 'anymatch', severity: 'high', via: ['picomatch'] },
    vite: { name: 'vite', severity: 'high', via: ['picomatch', advisory('GHSA-low', 'vite', 'low')] },
    // the same advisory reached through another install path
    astro: { name: 'astro', severity: 'high', via: ['vite', advisory('GHSA-high', 'picomatch', 'high')] },
    sharp: { name: 'sharp', severity: 'critical', via: [advisory('GHSA-critical', 'sharp', 'critical')] },
  },
};

const ids = (list) => list.map((a) => a.id ?? a.advisory);
const run = (allowList, today = '2026-11-17', report = REPORT) => auditResult(report, { level: 'high', allowList, today });

describe('advisories', () => {
  test('each advisory once, packages affected through a dependency add none', () => {
    assert.deepEqual(ids(advisories(REPORT)), ['GHSA-high', 'GHSA-low', 'GHSA-critical']);
  });

  test('the id comes from the advisory URL', () => {
    assert.equal(advisoryId('https://github.com/advisories/GHSA-fc5q-39xc-vjpf'), 'GHSA-fc5q-39xc-vjpf');
  });

  test('a clean report has none', () => {
    assert.deepEqual(advisories({ vulnerabilities: {} }), []);
    assert.deepEqual(advisories({}), []);
  });
});

describe('auditResult', () => {
  test('without allowances every advisory at the level or above fails, lower ones are ignored', () => {
    const result = run([]);
    assert.deepEqual(ids(result.failing), ['GHSA-high', 'GHSA-critical']);
    assert.equal(auditPasses(result), false);
  });

  test('an allowance lets its advisory through up to and including its date', () => {
    for (const today of ['2026-11-17', '2026-11-24']) {
      const result = run([{ advisory: 'GHSA-high', until: '2026-11-24' }, { advisory: 'GHSA-critical', until: '2026-11-24' }], today);
      assert.deepEqual(ids(result.allowed), ['GHSA-high', 'GHSA-critical'], today);
      assert.deepEqual(result.failing, []);
      assert.equal(auditPasses(result), true);
    }
  });

  test('after its date the allowance fails the audit again', () => {
    const result = run([{ advisory: 'GHSA-high', until: '2026-11-24' }], '2026-11-25');
    assert.deepEqual(ids(result.expired), ['GHSA-high']);
    assert.deepEqual(ids(result.failing), ['GHSA-critical']);
    assert.equal(auditPasses(run([{ advisory: 'GHSA-high', until: '2026-11-24' }], '2026-11-25', {
      vulnerabilities: { picomatch: REPORT.vulnerabilities.picomatch },
    })), false);
  });

  test('an allowance covers only its own advisory', () => {
    const result = run([{ advisory: 'GHSA-high', until: '2026-11-24' }]);
    assert.deepEqual(ids(result.allowed), ['GHSA-high']);
    assert.deepEqual(ids(result.failing), ['GHSA-critical']);
    assert.equal(auditPasses(result), false);
  });

  test('allowances that match nothing are reported as unused', () => {
    const result = run([{ advisory: 'GHSA-gone', until: '2026-11-24' }, { advisory: 'GHSA-high', until: '2026-11-24' }]);
    assert.deepEqual(ids(result.unused), ['GHSA-gone']);
  });

  test('a clean report passes', () => {
    assert.equal(auditPasses(run([], '2026-11-17', { vulnerabilities: {} })), true);
  });

  test('an unknown level is refused', () => {
    assert.throws(() => auditResult(REPORT, { level: 'severe', allowList: [], today: '2026-11-17' }), /Unknown audit level/);
  });
});

describe('audit settings', () => {
  test('the level is an npm severity', () => {
    assert.ok(SEVERITIES.includes(AUDIT_LEVEL));
  });

  test('every allowance names a GitHub advisory, a real review date and a reason', () => {
    for (const entry of AUDIT_ALLOWED) {
      assert.match(entry.advisory, /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/, entry.advisory);
      assert.match(entry.until, /^\d{4}-\d{2}-\d{2}$/, entry.advisory);
      assert.equal(new Date(`${entry.until}T00:00:00Z`).toISOString().slice(0, 10), entry.until, entry.advisory);
      assert.ok(entry.reason.trim(), entry.advisory);
    }
    assert.equal(new Set(ids(AUDIT_ALLOWED)).size, AUDIT_ALLOWED.length, 'no advisory is listed twice');
  });
});
