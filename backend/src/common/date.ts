const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function parseDateKey(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  if (!year || !month || !day) throw new Error("invalid_date_key");
  return { year, month, day };
}

export function missionDateKey(date = new Date()) {
  const { year, month, day } = parseDateKey(yyyyMmDd(date));
  return new Date(Date.UTC(year, month - 1, day) - KST_OFFSET_MS);
}

export function yyyyMmDd(date = new Date()) {
  return new Date(date.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDaysToDateKey(dateKey: string, days: number) {
  const { year, month, day } = parseDateKey(dateKey);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function missionDateRangeForKey(dateKey: string) {
  const { year, month, day } = parseDateKey(dateKey);
  const start = new Date(Date.UTC(year, month - 1, day) - KST_OFFSET_MS);
  return {
    start,
    end: new Date(start.getTime() + 24 * 60 * 60 * 1000),
  };
}
