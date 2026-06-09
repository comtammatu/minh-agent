const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2,
});

type NullableNumber = number | null | undefined;

function isDisplayableNumber(value: NullableNumber): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function formatUsd(value: NullableNumber): string {
  if (!isDisplayableNumber(value)) return "—";
  return usdFormatter.format(value);
}

export function formatNumber(value: NullableNumber, digits = 2): string {
  if (!isDisplayableNumber(value)) return "—";
  return value.toFixed(digits);
}

export function formatPercent(value: NullableNumber): string {
  if (!isDisplayableNumber(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

export function formatChangePercent(value: NullableNumber): string {
  if (!isDisplayableNumber(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export function formatCompact(value: NullableNumber): string {
  if (!isDisplayableNumber(value)) return "—";
  return compactFormatter.format(value);
}

export function formatTimestamp(value: string | number): string {
  const date = typeof value === "string" ? new Date(value) : new Date(value);
  return date.toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "0m";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}
