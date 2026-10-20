// -----------------------------------------------------------------------------
// The nominal period of a cron schedule of Backrest ("0 3 * * *"), for the
// automatic "overdue" threshold: the longest gap between two runs over the
// next two months (a plan run on weekdays only waits 72 hours over the
// weekend). Standard 5 fields (lists, ranges, steps, month and day names) and
// the @hourly / @daily / @weekly / @monthly / @yearly shortcuts. Computed once
// per expression.
// -----------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const WINDOW_MS = 62 * 24 * 60 * MINUTE_MS;

const SHORTCUTS = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

const NAMES = {
  month: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'],
  day: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'],
};

const FIELDS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: NAMES.month, offset: 1 },
  { min: 0, max: 7, names: NAMES.day, offset: 0 },
];

function value(token, field) {
  const index = field.names?.indexOf(token.toUpperCase()) ?? -1;
  const number = index >= 0 ? index + field.offset : Number(token);
  if (!Number.isInteger(number) || number < field.min || number > field.max) {
    throw new Error(`bad value ${token}`);
  }
  return number;
}

/** The set of values of one field; null for "*" (every value). */
function parseField(source, field) {
  if (source === '*' || source === '?') {
    return null;
  }
  const values = new Set();
  for (const part of source.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`bad step ${part}`);
    }
    let from;
    let to;
    if (range === '*') {
      [from, to] = [field.min, field.max];
    } else if (range.includes('-')) {
      [from, to] = range.split('-').map((token) => value(token, field));
    } else {
      from = value(range, field);
      to = stepText === undefined ? from : field.max;
    }
    for (let n = from; n <= to; n += step) {
      values.add(n);
    }
  }
  return values;
}

/** @returns {(date: Date) => boolean} */
function compile(expression) {
  const fields = (SHORTCUTS[expression.toLowerCase()] ?? expression).trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error('5 fields expected');
  }
  const [minutes, hours, days, months, weekdays] = fields.map((f, i) => parseField(f, FIELDS[i]));
  if (weekdays?.has(7)) {
    weekdays.add(0); // Sunday, both ways
  }
  return (date) => {
    if (minutes && !minutes.has(date.getUTCMinutes())) return false;
    if (hours && !hours.has(date.getUTCHours())) return false;
    if (months && !months.has(date.getUTCMonth() + 1)) return false;
    const dayOk = !days || days.has(date.getUTCDate());
    const weekdayOk = !weekdays || weekdays.has(date.getUTCDay());
    // Classic cron: day of month and day of week restricted both = either matches.
    return days && weekdays ? dayOk || weekdayOk : dayOk && weekdayOk;
  };
}

const cache = new Map();

/**
 * The longest gap between two runs of a cron schedule, in ms; null when the
 * expression is not understood or runs less than twice in two months.
 * @param {string} expression
 * @param {number} [from] start of the window (a fixed date keeps it stable)
 */
export function cronPeriodMs(expression, from = Date.UTC(2026, 6, 1)) {
  const key = `${expression}|${from}`;
  if (cache.has(key)) {
    return cache.get(key);
  }
  let period = null;
  try {
    const matches = compile(expression);
    let previous = null;
    for (let time = from; time < from + WINDOW_MS; time += MINUTE_MS) {
      if (matches(new Date(time))) {
        if (previous !== null) {
          period = Math.max(period ?? 0, time - previous);
        }
        previous = time;
      }
    }
  } catch {
    period = null;
  }
  cache.set(key, period);
  return period;
}
