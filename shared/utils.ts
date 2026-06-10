export function compareStrings(a: string, b: string): number {
  return a.localeCompare(b);
}

export function dateKeyFromIso(iso: string): string {
  return iso.slice(0, 10);
}

export function todayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function previousDay(dayKey: string): string {
  const value = new Date(`${dayKey}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

export function coinRewardForMinutes(minutes: number): number {
  return minutes * 2;
}

export function clamp(number: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, number));
}

export function uniqueBy<T, K>(items: T[], keyFn: (item: T) => K): T[] {
  const seen = new Set<K>();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

