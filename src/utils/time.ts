const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export function nowIso() {
  return new Date().toISOString();
}

export function unixSeconds(date: Date | string) {
  return Math.floor(new Date(date).getTime() / 1000);
}

export function discordTimestamp(date: Date | string, style: "F" | "R" | "D" | "d" | "t" | "T" = "F") {
  return `<t:${unixSeconds(date)}:${style}>`;
}

export function parseDateInput(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function dayName(day: number) {
  return WEEKDAYS[((day % 7) + 7) % 7];
}

export function parseWeekday(value: string) {
  const normalized = value.trim().toLowerCase();
  const index = WEEKDAYS.findIndex((day) => day.toLowerCase().startsWith(normalized));
  if (index === -1) throw new Error("Use a weekday like Sunday, Monday, Tuesday, etc.");
  return index;
}

export function parseTime(value: string) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error("Use 24-hour time like 21:00.");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error("Use a valid 24-hour time like 21:00.");
  }
  return { hour, minute };
}

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short"
  }).formatToParts(date);

  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(pick("weekday"));
  return {
    year: Number(pick("year")),
    month: Number(pick("month")),
    day: Number(pick("day")),
    hour: Number(pick("hour")),
    minute: Number(pick("minute")),
    weekday: Math.max(weekday, 0)
  };
}

function timeZoneOffsetMs(date: Date, timeZone: string) {
  const parts = getZonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return asUtc - date.getTime();
}

export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string) {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const offset = timeZoneOffsetMs(utcGuess, timeZone);
  return new Date(utcGuess.getTime() - offset);
}

function addLocalDays(parts: ZonedParts, days: number) {
  const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour, parts.minute));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate()
  };
}

export function computeNextQuotaEnd(options: {
  timeZone: string;
  checkDay: number;
  checkHour: number;
  checkMinute: number;
  frequencyDays: number;
  from?: Date;
}) {
  const from = options.from ?? new Date();
  const local = getZonedParts(from, options.timeZone);
  const targetDay = ((options.checkDay % 7) + 7) % 7;
  let daysUntil = (targetDay - local.weekday + 7) % 7;
  const alreadyPassedToday =
    daysUntil === 0 &&
    (local.hour > options.checkHour || (local.hour === options.checkHour && local.minute >= options.checkMinute));

  if (alreadyPassedToday) {
    daysUntil = options.frequencyDays > 0 ? options.frequencyDays : 7;
  }

  const target = addLocalDays(
    {
      ...local,
      hour: options.checkHour,
      minute: options.checkMinute
    },
    daysUntil
  );

  return zonedTimeToUtc(target.year, target.month, target.day, options.checkHour, options.checkMinute, options.timeZone);
}

export function addHours(date: Date | string, hours: number) {
  return new Date(new Date(date).getTime() + hours * 60 * 60 * 1000);
}

export function addDays(date: Date | string, days: number) {
  return new Date(new Date(date).getTime() + days * 24 * 60 * 60 * 1000);
}
