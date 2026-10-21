/** Convert only finite decimal text whose exact magnitude is in the safe integer range. */
export function numericText(value: string): number | string {
  const match = /^[-+]?(\d+\.?\d*|\.\d+)(?:[eE]([-+]?\d+))?$/.exec(value);
  if (!match) return value;
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  const mantissa = match[1]!;
  const digits = mantissa.replace('.', '').replace(/^0+/, '');
  if (!digits) return number;
  if (number === 0) return value; // A nonzero decimal underflowed.
  const places = digits.length + Number(match[2] ?? 0) - (mantissa.split('.')[1]?.length ?? 0);
  if (places < 16) return number;
  if (places > 16) return value;
  const integer = digits.slice(0, places).padEnd(places, '0');
  if (integer < '9007199254740991') return number;
  if (integer === '9007199254740991' && /^0*$/.test(digits.slice(places))) return number;
  return value;
}
