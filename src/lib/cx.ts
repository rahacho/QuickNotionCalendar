/** Joins truthy class names: cx('a', cond && 'b', null) → "a b". */
export function cx(...c: Array<string | false | null | undefined>): string {
  let out = '';
  for (const part of c) {
    if (part) out = out ? `${out} ${part}` : part;
  }
  return out;
}
