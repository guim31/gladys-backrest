// -----------------------------------------------------------------------------
// The nominal period of a cron schedule of Backrest ("0 3 * * *"), for the
// automatic "overdue" threshold: the longest gap between two runs over a
// year and a month (a plan run on weekdays only waits 72 hours over the
// weekend, one run on the 31st waits two months). Standard 5 fields (lists, ranges, steps, month and day names) and
// the @hourly / @daily / @weekly / @monthly / @yearly shortcuts. Computed once
// per expression.
// -----------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const WINDOW_DAYS = 400;

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
  // 7 is Sunday too, as an explicit value only: "1/2" is 1,3,5.
  { min: 0, max: 6, names: NAMES.day, offset: 0, seven: true },
];

function value(token, field) {
  const index = field.names?.indexOf(token.toUpperCase()) ?? -1;
  const number = index >= 0 ? index + field.offset : Number(token);
  const max = field.seven ? 7 : field.max;
  if (!Number.isInteger(number) || number < field.min || number > max) {
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
      if (field.seven && to === 0 && from > 0) {
        to = 7; // "MON-SUN"
      }
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

/** @returns {{ day: (date: Date) => boolean, minutes: number[] }} */
function compile(expression) {
  const fields = (SHORTCUTS[expression.toLowerCase()] ?? expression).trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error('5 fields expected');
  }
  const [minutes, hours, days, months, weekdays] = fields.map((f, i) => parseField(f, FIELDS[i]));
  if (weekdays?.has(7)) {
    weekdays.add(0); // Sunday, both ways
  }
  const all = (n) => [...Array(n).keys()];
  const minuteList = minutes ? [...minutes].sort((a, b) => a - b) : all(60);
  const hourList = hours ? [...hours].sort((a, b) => a - b) : all(24);
  return {
    // Minutes of the day a run starts at, for a matching day.
    minutes: hourList.flatMap((hour) => minuteList.map((minute) => hour * 60 + minute)),
    day: (date) => {
      if (months && !months.has(date.getUTCMonth() + 1)) return false;
      const dayOk = !days || days.has(date.getUTCDate());
      const weekdayOk = !weekdays || weekdays.has(date.getUTCDay());
      // Classic cron: day of month and day of week restricted both = either matches.
      return days && weekdays ? dayOk || weekdayOk : dayOk && weekdayOk;
    },
  };
}

const cache = new Map();

/**
 * The longest gap between two runs of a cron schedule, in ms; null when the
 * expression is not understood or runs less than twice in the window.
 * @param {string} expression
 * @param {number} [from] start of the window (a fixed date keeps it stable)
 */
export function cronPeriodMs(expression, from = Date.UTC(2026, 0, 1)) {
  const key = `${expression}|${from}`;
  if (cache.has(key)) {
    return cache.get(key);
  }
  let period = null;
  try {
    const schedule = compile(expression);
    let previous = null;
    for (let day = from; day < from + WINDOW_DAYS * DAY_MS; day += DAY_MS) {
      if (!schedule.day(new Date(day))) {
        continue;
      }
      for (const minute of schedule.minutes) {
        const time = day + minute * MINUTE_MS;
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
