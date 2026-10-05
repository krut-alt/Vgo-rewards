// All VGO stores are on Eastern time (SC, NC, GA).
export const STORE_TZ = 'America/New_York';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Store-local calendar parts of an instant. */
export function localParts(at: string | Date, tz = STORE_TZ) {
  const d = typeof at === 'string' ? new Date(at) : at;
  const parts = formatter(tz).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    ymd: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
    dayOfWeek: DAYS.indexOf(get('weekday')),
  };
}

/** ISO instant for midnight at the start of `ymd` (YYYY-MM-DD) in store time. */
export function localMidnight(ymd: string, tz = STORE_TZ): string {
  // 05:00Z is just after midnight Eastern and before the 2am DST switch, so its offset is midnight's.
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
    .formatToParts(new Date(`${ymd}T05:00:00Z`))
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name ?? '');
  const offset = m ? `${m[1]}${m[2]!.padStart(2, '0')}:${m[3] ?? '00'}` : 'Z';
  return new Date(`${ymd}T00:00:00${offset}`).toISOString();
}

export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "Dec 31" for a YYYY-MM-DD date. */
export function shortDate(ymd: string): string {
  const [, m, d] = ymd.split('-');
  return `${MONTHS[Number(m) - 1]} ${Number(d)}`;
}

export function monthIndex(name: string): number {
  return MONTHS.findIndex((m) => name.toLowerCase().startsWith(m.toLowerCase()));
}

export function dayList(days: number[]): string {
  const sorted = [...days].sort();
  if (sorted.join() === '0,6') return 'Weekends';
  if (sorted.join() === '1,2,3,4,5') return 'Weekdays';
  if (sorted.length === 7) return 'Every day';
  if (sorted.length === 1) return `${DAY_NAMES[sorted[0]!]}s`;
  return sorted.map((d) => DAYS[d]).join(', ');
}

export { DAYS, DAY_NAMES, MONTHS };
