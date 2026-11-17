// Reads the report of `npm audit --json` and decides which advisories fail the audit. Pure, so it is tested
// without npm (tests/audit/advisories.test.mjs); scripts/audit.mjs runs npm and prints the result.

/** npm severities, lowest first. */
export const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];

/** Advisory id from its URL: https://github.com/advisories/GHSA-… → GHSA-…. */
export const advisoryId = (url) => url.slice(url.lastIndexOf('/') + 1);

/**
 * Every advisory in the report, once each. A package affected only through its dependencies lists their names
 * instead of advisories, so the advisories themselves cover every vulnerable package.
 * @returns {{ id: string, name: string, title: string, severity: string, range: string, url: string }[]}
 */
export function advisories(report) {
  const found = new Map();
  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via) {
      if (typeof via !== 'object') continue;
      const id = advisoryId(via.url);
      if (!found.has(id)) {
        found.set(id, { id, name: via.name, title: via.title, severity: via.severity, range: via.range, url: via.url });
      }
    }
  }
  return [...found.values()];
}

/**
 * Sorts the report's advisories at `level` or above: `failing` have no entry in `allowList`, `allowed` have an
 * entry dated today or later, `expired` have an entry whose date has passed (they fail the audit too).
 * `unused` are entries that match no advisory in the report and can be removed.
 * @param {object} report parsed `npm audit --json` output
 * @param {{ level: string, allowList: { advisory: string, until: string }[], today: string }} options
 *   `until` and `today` as YYYY-MM-DD (UTC)
 */
export function auditResult(report, { level, allowList, today }) {
  const minimum = SEVERITIES.indexOf(level);
  if (minimum === -1) throw new Error(`Unknown audit level "${level}", expected one of ${SEVERITIES.join(', ')}`);
  const entries = new Map(allowList.map((entry) => [entry.advisory, entry]));
  const all = advisories(report);
  const failing = [];
  const allowed = [];
  const expired = [];
  for (const advisory of all) {
    if (SEVERITIES.indexOf(advisory.severity) < minimum) continue;
    const entry = entries.get(advisory.id);
    if (!entry) failing.push(advisory);
    else if (today <= entry.until) allowed.push({ ...advisory, until: entry.until });
    else expired.push({ ...advisory, until: entry.until });
  }
  const reported = new Set(all.map((advisory) => advisory.id));
  const unused = allowList.filter((entry) => !reported.has(entry.advisory));
  return { failing, allowed, expired, unused };
}

/** Whether the audit passes: nothing failing and no allowance past its date. */
export const auditPasses = (result) => result.failing.length === 0 && result.expired.length === 0;
