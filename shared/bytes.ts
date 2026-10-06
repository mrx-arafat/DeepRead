const UNITS = ["KB", "MB", "GB", "TB"] as const;

/** "820 KB", "1.2 GB", "8 GB": decimal units, the way macOS and Cloudflare count them. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return bytes === 1 ? "1 byte" : `${bytes} bytes`;
  let value = bytes / 1000;
  let unit = 0;
  // 999.96 KB would round to "1000 KB": it is shown as the next unit instead.
  while (value >= 999.95 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const shown = value >= 9.95 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${shown} ${UNITS[unit]}`;
}
