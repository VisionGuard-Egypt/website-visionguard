/* =========================================================================
   Leave: the calendar, the counting, and the balance.

   Two kinds of request, one table. Sick leave is reported (it has already
   happened, or is happening) and carries a certificate; vacation is asked for
   in advance and is capped. They differ in what they need from the person and
   in what the administrator does with them, not in how a day is counted.

   THE 14-DAY CAP, EXACTLY AS IT IS MEANT
   --------------------------------------
   Fourteen days per CALENDAR YEAR, and a public holiday inside a requested
   range DOES come out of the fourteen. That is a policy decision, not a
   technical one, and it is the harsher of the two readings: an employee who
   books the week containing Eid spends the Eid days out of their own
   allowance even though the office is shut. It is written here in one place
   so that reversing it later is a single change — see countDays().

   The holiday calendar therefore does NOT affect the maths at all. It exists
   so the request form can tell someone "3 of these 9 days are public
   holidays" BEFORE they commit them, which is the only thing that makes the
   policy above visible rather than a nasty surprise at the end of the year.

   Sick leave is NOT capped. Capping it would push someone to come in ill, and
   the certificate is what controls it instead.
   ========================================================================= */

/* -------------------------------------------------------------------------
   Egyptian public holidays.

   Sources cross-checked against officeholidays.com and calendarlabs.com.
   Where they disagreed it was always the same disagreement, and it is worth
   understanding before correcting anything here: since 2020 Egypt observes
   most midweek holidays on the nearest Thursday, so one source lists the
   CANONICAL date (Armed Forces Day is the 6th of October, because that is
   when the war started) and the other lists the date actually taken off.

   The canonical dates are stored. They are the ones a person recognises and
   the ones that do not change, and since holidays do not alter the arithmetic
   the in-lieu shuffle costs nothing here. If you later want the day actually
   taken off, that is a second field, not an edit to these.

   THE LUNAR ONES ARE ESTIMATES AND ARE MARKED AS SUCH. Eid al-Fitr, Eid
   al-Adha, the Hijri New Year and the Prophet's Birthday follow the Islamic
   calendar and are fixed in Egypt by Cabinet announcement after a moon
   sighting, usually only weeks ahead. A date here can be a day or two out
   until then, which is fine for showing someone what is in their range and
   is NOT fine as a basis for telling them a day was not deducted — which is
   the other reason the maths deliberately ignores this table.

   ADDING A YEAR: append it. A year that is missing is not an error and does
   not throw; holidaysIn() simply returns nothing for it, the request form
   stops annotating ranges, and the deduction is unchanged. Check the dates
   against the Cabinet announcement rather than against last year plus eleven
   days.
   ------------------------------------------------------------------------- */
export const HOLIDAYS = {
  2026: [
    { date: '2026-01-07', ar: 'عيد الميلاد المجيد',        en: 'Coptic Christmas' },
    { date: '2026-01-25', ar: 'عيد الشرطة وثورة ٢٥ يناير', en: 'Revolution Day (25 January)' },
    { date: '2026-03-20', ar: 'عيد الفطر',                 en: 'Eid al-Fitr',            lunar: true },
    { date: '2026-03-21', ar: 'عيد الفطر — ثاني يوم',      en: 'Eid al-Fitr (day 2)',    lunar: true },
    { date: '2026-03-22', ar: 'عيد الفطر — ثالث يوم',      en: 'Eid al-Fitr (day 3)',    lunar: true },
    { date: '2026-04-12', ar: 'عيد القيامة',               en: 'Coptic Easter' },
    { date: '2026-04-13', ar: 'شم النسيم',                 en: 'Sham El-Nessim' },
    { date: '2026-04-25', ar: 'عيد تحرير سيناء',           en: 'Sinai Liberation Day' },
    { date: '2026-05-01', ar: 'عيد العمال',                en: 'Labour Day' },
    { date: '2026-05-26', ar: 'وقفة عرفات',                en: 'Arafat Day',             lunar: true },
    { date: '2026-05-27', ar: 'عيد الأضحى',                en: 'Eid al-Adha',            lunar: true },
    { date: '2026-05-28', ar: 'عيد الأضحى — ثاني يوم',     en: 'Eid al-Adha (day 2)',    lunar: true },
    { date: '2026-05-29', ar: 'عيد الأضحى — ثالث يوم',     en: 'Eid al-Adha (day 3)',    lunar: true },
    { date: '2026-06-16', ar: 'رأس السنة الهجرية',         en: 'Islamic New Year',       lunar: true },
    { date: '2026-06-30', ar: 'ثورة ٣٠ يونيو',             en: 'Revolution Day (30 June)' },
    { date: '2026-07-23', ar: 'ثورة ٢٣ يوليو',             en: 'Revolution Day (23 July)' },
    { date: '2026-08-25', ar: 'المولد النبوي الشريف',      en: 'Prophet Muhammad’s Birthday', lunar: true },
    { date: '2026-10-06', ar: 'عيد القوات المسلحة',        en: 'Armed Forces Day' }
  ],
  2027: [
    { date: '2027-01-07', ar: 'عيد الميلاد المجيد',        en: 'Coptic Christmas' },
    { date: '2027-01-25', ar: 'عيد الشرطة وثورة ٢٥ يناير', en: 'Revolution Day (25 January)' },
    { date: '2027-03-09', ar: 'عيد الفطر',                 en: 'Eid al-Fitr',            lunar: true },
    { date: '2027-03-10', ar: 'عيد الفطر — ثاني يوم',      en: 'Eid al-Fitr (day 2)',    lunar: true },
    { date: '2027-03-11', ar: 'عيد الفطر — ثالث يوم',      en: 'Eid al-Fitr (day 3)',    lunar: true },
    { date: '2027-04-25', ar: 'عيد تحرير سيناء',           en: 'Sinai Liberation Day' },
    { date: '2027-05-01', ar: 'عيد العمال',                en: 'Labour Day' },
    { date: '2027-05-02', ar: 'عيد القيامة',               en: 'Coptic Easter' },
    { date: '2027-05-03', ar: 'شم النسيم',                 en: 'Sham El-Nessim' },
    { date: '2027-05-15', ar: 'وقفة عرفات',                en: 'Arafat Day',             lunar: true },
    { date: '2027-05-16', ar: 'عيد الأضحى',                en: 'Eid al-Adha',            lunar: true },
    { date: '2027-05-17', ar: 'عيد الأضحى — ثاني يوم',     en: 'Eid al-Adha (day 2)',    lunar: true },
    { date: '2027-05-18', ar: 'عيد الأضحى — ثالث يوم',     en: 'Eid al-Adha (day 3)',    lunar: true },
    { date: '2027-06-06', ar: 'رأس السنة الهجرية',         en: 'Islamic New Year',       lunar: true },
    { date: '2027-06-30', ar: 'ثورة ٣٠ يونيو',             en: 'Revolution Day (30 June)' },
    { date: '2027-07-23', ar: 'ثورة ٢٣ يوليو',             en: 'Revolution Day (23 July)' },
    { date: '2027-08-14', ar: 'المولد النبوي الشريف',      en: 'Prophet Muhammad’s Birthday', lunar: true },
    { date: '2027-10-06', ar: 'عيد القوات المسلحة',        en: 'Armed Forces Day' }
  ]
};

/* The annual vacation allowance, in days. Sick leave is not counted against
   it — see the header. */
export const VACATION_DAYS_PER_YEAR = 14;

/* A single request cannot be longer than the whole annual allowance. Without
   this a typo in the end date ("2027" for "2026") asks for four hundred days
   and the balance goes sharply negative rather than being refused. */
export const MAX_REQUEST_DAYS = VACATION_DAYS_PER_YEAR;

export const LEAVE_KINDS = ['vacation', 'sick'];
export const LEAVE_STATUSES = ['pending', 'approved', 'declined', 'cancelled'];

/* -------------------------------------------------------------------------
   Dates

   Everything here is a plain YYYY-MM-DD string in Cairo terms. They are never
   turned into a Date and back for arithmetic — a Date is an instant in UTC,
   and "add one day" across a timezone gives you the same date twice or skips
   one, which is exactly the bug that makes a leave request come out a day
   short. Days are counted by walking the calendar with UTC noon as the
   anchor, which no timezone shift can push over a date boundary.
   ------------------------------------------------------------------------- */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  /* Rejects the 31st of a 30-day month and the 29th of a common February,
     which a regex cannot. */
  const probe = new Date(Date.UTC(y, m - 1, d, 12));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

const toUtcNoon = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 12);
};

const fromUtcNoon = (ms) => new Date(ms).toISOString().slice(0, 10);

const DAY_MS = 86400000;

/* Every date from start to end, inclusive of both. */
export function datesBetween(start, end) {
  const out = [];
  let cur = toUtcNoon(start);
  const last = toUtcNoon(end);
  /* Bounded rather than trusted: the caller validates the range first, and
     this stops a reversed or absurd pair from spinning forever if one ever
     slips past. */
  for (let i = 0; cur <= last && i < 1000; i++) {
    out.push(fromUtcNoon(cur));
    cur += DAY_MS;
  }
  return out;
}

export function holidaysIn(start, end) {
  const years = new Set();
  for (let y = Number(start.slice(0, 4)); y <= Number(end.slice(0, 4)); y++) years.add(y);
  const out = [];
  for (const y of years) {
    for (const h of HOLIDAYS[y] || []) {
      if (h.date >= start && h.date <= end) out.push(h);
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/* How many days a request costs.

   EVERY calendar day in the range, public holidays included — that is the
   policy. Weekends are also included, because this team's days off are not
   uniform (the shop's own hours say Friday) and silently discounting a day
   somebody might have been rostered for is a worse error than counting one
   they were not.

   `holidays` is returned alongside so the caller can SHOW what is being spent
   without it changing the total. */
export function countDays(start, end) {
  const dates = datesBetween(start, end);
  return {
    days: dates.length,
    dates,
    holidays: holidaysIn(start, end)
  };
}

/* -------------------------------------------------------------------------
   Validation

   Returns a plain reason string, or '' when the range is usable. The caller
   turns it into an ApiError with the right field, so this file stays free of
   HTTP.
   ------------------------------------------------------------------------- */
export function checkRange(start, end) {
  if (!isDate(start)) return 'bad_start';
  if (!isDate(end)) return 'bad_end';
  if (end < start) return 'end_before_start';
  const { days } = countDays(start, end);
  if (days > MAX_REQUEST_DAYS) return 'too_long';
  return '';
}

/* Which year an allowance comes out of.

   A range that straddles New Year is charged to the year it STARTS in, all of
   it. Splitting it across two balances is the more precise answer and a worse
   one to explain to somebody: they asked for six days and would be told they
   have four left in one year and thirteen in another. One request, one year,
   and the rule is stated on the form. */
export const yearOf = (startDate) => Number(startDate.slice(0, 4));

/* -------------------------------------------------------------------------
   Balance

   `taken` is the sum of days on requests that are approved or still pending.
   Pending counts on purpose: two requests submitted before either is answered
   must not both be allowed to pass the cap, or the administrator approves
   them one at a time and discovers the overspend afterwards.
   ------------------------------------------------------------------------- */
export function balance(takenDays) {
  const taken = Math.max(0, Number(takenDays) || 0);
  return {
    allowance: VACATION_DAYS_PER_YEAR,
    taken,
    remaining: Math.max(0, VACATION_DAYS_PER_YEAR - taken)
  };
}
