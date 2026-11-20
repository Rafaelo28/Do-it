import { addDays, easterSunday, fromParts, nextWeekday, nthWeekdayOfMonth, type PlainDate } from '@do-it/shared';

/** Ersetzt Umlaute im Muster durch Alternativen, damit "uebermorgen" wie "übermorgen" klappt. */
export function de(pattern: string): string {
  return pattern
    .replace(/ä/g, '(?:ä|ae)')
    .replace(/ö/g, '(?:ö|oe)')
    .replace(/ü/g, '(?:ü|ue)')
    .replace(/ß/g, '(?:ß|ss)');
}

/** Regex mit Wortgrenzen, die auch Umlaute als Buchstaben behandeln. */
export function rx(pattern: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${de(pattern)})(?![\\p{L}\\p{N}])`, 'gu');
}

/** Umlaute vereinheitlichen, damit Lookups für "naechsten" und "nächsten" gleich sind. */
export function foldUmlauts(s: string): string {
  return s.replace(/ae/g, 'ä').replace(/oe/g, 'ö').replace(/ue/g, 'ü').replace(/ss/g, 'ß');
}

// ---------- Zahlen ----------

const NUMBER_WORDS: Record<string, number> = {
  ein: 1, eine: 1, einen: 1, einem: 1, einer: 1, eins: 1,
  zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10,
  elf: 11, zwölf: 12, dreizehn: 13, vierzehn: 14, fünfzehn: 15, sechzehn: 16, siebzehn: 17,
  achtzehn: 18, neunzehn: 19, zwanzig: 20, dreißig: 30, vierzig: 40, fünfundvierzig: 45,
  fünfzig: 50, sechzig: 60, neunzig: 90, hundert: 100,
  anderthalb: 1.5, eineinhalb: 1.5, zweieinhalb: 2.5, halbe: 0.5, 'eine halbe': 0.5, 'einer halben': 0.5,
  halben: 0.5, 'ein paar': 3, paar: 3, 'eine dreiviertel': 0.75, dreiviertel: 0.75,
};

export const NUM =
  '\\d+(?:[.,]\\d+)?|eine[mnr]?\\s+halbe[n]?|eine\\s+dreiviertel|dreiviertel|ein\\s+paar|anderthalb|eineinhalb|zweieinhalb|halbe[n]?|' +
  'eine[mnrs]?|ein|zwei|drei|vierzehn|vierzig|vier|fünfundvierzig|fünfzehn|fünfzig|fünf|sechzehn|sechzig|sechs|siebzehn|sieben|' +
  'achtzehn|acht|neunzehn|neunzig|neun|zehn|elf|zwölf|dreizehn|zwanzig|dreißig|hundert';

export function parseNumber(s: string | undefined): number | null {
  if (!s) return null;
  const t = foldUmlauts(s.trim().replace(/\s+/g, ' '));
  if (/^\d+(?:[.,]\d+)?$/.test(t)) return Number(t.replace(',', '.'));
  return NUMBER_WORDS[t] ?? null;
}

const ORDINAL_WORDS: Record<string, number> = {
  erst: 1, zweit: 2, dritt: 3, viert: 4, fünft: 5, sechst: 6, siebt: 7, siebent: 7, acht: 8, neunt: 9,
  zehnt: 10, elft: 11, zwölft: 12, letzt: -1, vorletzt: -2,
};

export const ORD =
  '\\d{1,2}\\.|(?:erst|zweit|dritt|viert|fünft|sechst|siebt|siebent|acht|neunt|zehnt|elft|zwölft|letzt)e[nmrs]?';

export function parseOrdinal(s: string | undefined): number | null {
  if (!s) return null;
  const t = foldUmlauts(s.trim());
  const m = /^(\d{1,2})\.$/.exec(t);
  if (m) return Number(m[1]);
  const stem = t.replace(/e[nmrs]?$/, '');
  return ORDINAL_WORDS[stem] ?? null;
}

const HOUR_WORDS: Record<string, number> = {
  eins: 1, ein: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9,
  zehn: 10, elf: 11, zwölf: 12,
};
export const HOUR = '\\d{1,2}|eins|ein|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf';

export function parseHourToken(s: string | undefined): number | null {
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  return HOUR_WORDS[foldUmlauts(s)] ?? null;
}

// ---------- Wochentage und Monate ----------

const WEEKDAY_MAP: Record<string, number> = {
  montag: 1, mo: 1, dienstag: 2, di: 2, mittwoch: 3, mi: 3, donnerstag: 4, do: 4,
  freitag: 5, fr: 5, samstag: 6, sonnabend: 6, sa: 6, sonntag: 7, so: 7,
};

export const WD_FULL = 'montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonnabend|sonntag';
export const WD_ANY = `(?:${WD_FULL}|(?:mo|di|mi|do|fr|sa|so)\\.?)`;
export const WD_PLURAL = 'montags|dienstags|mittwochs|donnerstags|freitags|samstags|sonnabends|sonntags';

export function parseWeekday(s: string | undefined): number | null {
  if (!s) return null;
  let t = s.replace(/\.$/, '');
  if (!(t in WEEKDAY_MAP) && t.endsWith('s')) t = t.slice(0, -1);
  return WEEKDAY_MAP[t] ?? null;
}

const MONTH_MAP: Record<string, number> = {
  januar: 1, jänner: 1, jan: 1, februar: 2, feb: 2, märz: 3, mär: 3, mrz: 3, april: 4, apr: 4, mai: 5,
  juni: 6, jun: 6, juli: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9,
  oktober: 10, okt: 10, november: 11, nov: 11, dezember: 12, dez: 12,
};

export const MONTH_FULL = 'januar|jänner|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember';
export const MONTH_ANY = `(?:${MONTH_FULL}|(?:jan|feb|mär|mrz|apr|jun|jul|aug|sept|sep|okt|nov|dez)\\.?)`;

export function parseMonth(s: string | undefined): number | null {
  if (!s) return null;
  return MONTH_MAP[foldUmlauts(s.replace(/\.$/, ''))] ?? null;
}

// ---------- Feiertage und Anlässe ----------

type HolidayFn = (year: number) => PlainDate;
const fixed = (m: number, d: number): HolidayFn => (y) => fromParts(y, m, d);
const easter = (offset: number): HolidayFn => (y) => addDays(easterSunday(y), offset);
/** 4. Advent = letzter Sonntag vor dem 25.12. */
const advent = (n: number): HolidayFn => (y) => {
  const fourth = nextWeekday(fromParts(y, 12, 24), 7, true);
  const fourthAdvent = fourth > fromParts(y, 12, 24) ? addDays(fourth, -7) : fourth;
  return addDays(fourthAdvent, -7 * (4 - n));
};

const HOLIDAYS: [string, HolidayFn][] = [
  ['neujahr|neujahrstag', fixed(1, 1)],
  ['heilige(?:n)?\\s+drei\\s+könige|dreikönig(?:stag)?', fixed(1, 6)],
  ['valentinstag', fixed(2, 14)],
  ['rosenmontag', easter(-48)],
  ['aschermittwoch', easter(-46)],
  ['gründonnerstag', easter(-3)],
  ['karfreitag', easter(-2)],
  ['karsamstag', easter(-1)],
  ['ostersonntag|ostern', easter(0)],
  ['ostermontag', easter(1)],
  ['tag\\s+der\\s+arbeit', fixed(5, 1)],
  ['muttertag', (y) => nthWeekdayOfMonth(y, 5, 7, 2)!],
  ['vatertag|christi\\s+himmelfahrt|himmelfahrt', easter(39)],
  ['pfingstsonntag|pfingsten', easter(49)],
  ['pfingstmontag', easter(50)],
  ['fronleichnam', easter(60)],
  ['tag\\s+der\\s+deutschen\\s+einheit', fixed(10, 3)],
  ['reformationstag|halloween', fixed(10, 31)],
  ['allerheiligen', fixed(11, 1)],
  ['st\\.?\\s*martin|sankt\\s+martin|martinstag', fixed(11, 11)],
  ['nikolaus(?:tag)?', fixed(12, 6)],
  ['(?:1\\.|erste[nmrs]?)\\s+advent', advent(1)],
  ['(?:2\\.|zweite[nmrs]?)\\s+advent', advent(2)],
  ['(?:3\\.|dritte[nmrs]?)\\s+advent', advent(3)],
  ['(?:4\\.|vierte[nmrs]?)\\s+advent', advent(4)],
  ['heiligabend|heiligen\\s+abend|heilig\\s+abend', fixed(12, 24)],
  ['(?:1\\.|erste[nmrs]?)\\s+weihnachts(?:feier)?tag', fixed(12, 25)],
  ['(?:2\\.|zweite[nmrs]?)\\s+weihnachts(?:feier)?tag', fixed(12, 26)],
  ['weihnachten', fixed(12, 24)],
  ['silvester', fixed(12, 31)],
];

export const HOLIDAY_PATTERN = HOLIDAYS.map(([p]) => `(?:${p})`).join('|');
const HOLIDAY_RES = HOLIDAYS.map(([p, fn]) => [new RegExp(`^(?:${de(p)})$`, 'u'), fn] as const);

/** Nächster Termin eines Feiertags ab heute (heute zählt mit). */
export function holidayDate(text: string, today: PlainDate): PlainDate | null {
  const t = text.trim().replace(/\s+/g, ' ');
  for (const [re, fn] of HOLIDAY_RES) {
    if (re.test(t)) {
      const year = Number(today.slice(0, 4));
      const d = fn(year);
      return d >= today ? d : fn(year + 1);
    }
  }
  return null;
}
