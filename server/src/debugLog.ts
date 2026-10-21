/** Diagnostic stderr lines that stay quiet unless `LLULL_DEBUG` is set (the user-facing summary is a single line elsewhere). */
export function debugWarn(...parts: readonly unknown[]): void {
  const flag = process.env['LLULL_DEBUG'];
  if (flag !== undefined && flag !== '' && flag !== '0') console.warn(...parts);
}
