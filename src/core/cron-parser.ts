// ── Cron parser: supports 5-field cron expressions + ms interval strings ──

const DOW_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const MAX_FIELD = [59, 23, 31, 12, 6] as const; // minute, hour, dom, month, dow
const MIN_FIELD = [0, 0, 1, 1, 0] as const;

export type CronFields = [
  number[], // minute
  number[], // hour
  number[], // day of month
  number[], // month
  number[], // day of week (0=Sun)
];

/**
 * Parse a single cron field.
 * Supports: * , *&#47;N , exact-value , comma-list , range (1-5) , name (mon,tue,jan,feb)
 */
function parseField(raw: string, fieldIndex: number): number[] | null {
  const min = MIN_FIELD[fieldIndex]!;
  const max = MAX_FIELD[fieldIndex]!;
  const nameMap = fieldIndex === 4 ? DOW_NAMES : fieldIndex === 3 ? MONTH_NAMES : undefined;

  raw = raw.trim().toLowerCase();

  // Substitute names
  if (nameMap) {
    for (const [name, value] of Object.entries(nameMap)) {
      raw = raw.replace(new RegExp(name, "g"), String(value));
    }
  }

  // * or */N
  if (raw === "*") {
    const result: number[] = [];
    for (let i = min; i <= max; i++) result.push(i);
    return result;
  }

  const stepMatch = raw.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    const step = parseInt(stepMatch[1]!, 10);
    if (step < 1) return null;
    const result: number[] = [];
    for (let i = min; i <= max; i += step) result.push(i);
    return result;
  }

  // Comma-separated list
  if (raw.includes(",")) {
    const results: number[][] = [];
    for (const part of raw.split(",")) {
      const parsed = parseField(part.trim(), fieldIndex);
      if (!parsed) return null;
      results.push(parsed);
    }
    return results.flat();
  }

  // Range (e.g. 1-5)
  const rangeMatch = raw.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const lo = parseInt(rangeMatch[1]!, 10);
    const hi = parseInt(rangeMatch[2]!, 10);
    if (lo < min || hi > max || lo > hi) return null;
    const result: number[] = [];
    for (let i = lo; i <= hi; i++) result.push(i);
    return result;
  }

  // Exact value
  const exact = parseInt(raw, 10);
  if (isNaN(exact)) return null;
  // Dow field: 7 is an alias for Sunday (0)
  if (fieldIndex === 4 && exact === 7) return [0];
  if (exact < min || exact > max) return null;
  return [exact];
}

/**
 * Parse a 5-field cron expression into CronFields.
 * Returns null if unparseable.
 */
export function parseCronExpression(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const fields: number[][] = [];
  for (let i = 0; i < 5; i++) {
    const parsed = parseField(parts[i]!, i);
    if (!parsed || parsed.length === 0) return null;
    fields.push(parsed);
  }

  return fields as CronFields;
}

/**
 * Check if a date matches cron fields.
 */
function matchesCron(date: Date, fields: CronFields): boolean {
  const [minutes, hours, doms, months, dows] = fields;
  const m = date.getMinutes();
  const h = date.getHours();
  const d = date.getDate();
  const mo = date.getMonth() + 1;
  const dow = date.getDay();

  // Day-of-week OR day-of-month must match (standard cron behavior: if both
  // are restricted, either matching is enough; if only one is *, the other
  // governs).
  const domRestricted = doms.length < 31 || doms[0] !== 1;
  const dowRestricted = dows.length < 7 || dows[0] !== 0;

  let dayMatch = true;
  if (domRestricted && dowRestricted) {
    dayMatch = doms.includes(d) || dows.includes(dow);
  } else if (domRestricted) {
    dayMatch = doms.includes(d);
  } else if (dowRestricted) {
    dayMatch = dows.includes(dow);
  }

  return minutes.includes(m) && hours.includes(h) && dayMatch && months.includes(mo);
}

/**
 * Calculate the next fire time from a cron schedule string.
 *
 * Accepts:
 *   - A millisecond interval as a string (e.g. "60000")
 *   - A 5-field cron expression (e.g. "*&#47;5 * * * *", "0 9 * * 1-5")
 *
 * Returns the next fire time in epoch ms, or null if unparseable / no match in
 * the next 2 years.
 */
export function parseCronSchedule(schedule: string): { nextFire: number } | null {
  // Try integer ms interval first
  const msInterval = parseInt(schedule, 10);
  if (!isNaN(msInterval) && String(msInterval) === schedule.trim() && msInterval > 0) {
    return { nextFire: Date.now() + msInterval };
  }

  // Try 5-field cron
  const fields = parseCronExpression(schedule);
  if (!fields) return null;

  const now = new Date();
  // Start from the next minute boundary
  const candidate = new Date(now);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Iterate minute by minute, up to 2 years
  const maxIterations = 2 * 365 * 24 * 60;
  for (let i = 0; i < maxIterations; i++) {
    if (matchesCron(candidate, fields)) {
      return { nextFire: candidate.getTime() };
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return null;
}

/**
 * Validate a schedule string. Returns null if valid, or an error message.
 */
export function validateSchedule(schedule: string): string | null {
  if (!schedule || schedule.trim().length === 0) {
    return "Schedule must not be empty";
  }

  // Try integer ms interval
  const msInterval = parseInt(schedule, 10);
  if (!isNaN(msInterval) && String(msInterval) === schedule.trim()) {
    if (msInterval <= 0) return "Millisecond interval must be positive";
    return null;
  }

  // Try 5-field cron
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) {
    return `Expected 5-field cron expression or millisecond integer, got ${parts.length} field(s)`;
  }

  for (let i = 0; i < 5; i++) {
    const parsed = parseField(parts[i]!, i);
    if (!parsed || parsed.length === 0) {
      return `Invalid cron field ${i + 1} ("${parts[i]}"). Expected: ${
        ["minute (0-59)", "hour (0-23)", "day of month (1-31)", "month (1-12)", "day of week (0-6)"][i]
      }`;
    }
  }

  // Verify at least one match exists in the next 2 years
  const result = parseCronSchedule(schedule);
  if (!result) {
    return "Cron schedule does not match any date in the next 2 years";
  }

  return null;
}
