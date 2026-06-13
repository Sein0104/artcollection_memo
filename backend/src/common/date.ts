export function missionDateKey(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function yyyyMmDd(date = new Date()) {
  return date.toISOString().slice(0, 10);
}
