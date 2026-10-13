const PARAMETER_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export interface ParameterDraft {
  readonly name: string;
  readonly expression: string;
}

/** An empty name is "not yet typed", so it is not flagged as invalid. */
export function isParameterNameValid(name: string): boolean {
  const trimmed = name.trim();
  return trimmed === '' || PARAMETER_NAME.test(trimmed);
}

/** The trimmed `set_parameter` params, or null while either field is blank. */
export function parameterDraftOf(name: string, expression: string): ParameterDraft | null {
  const trimmedName = name.trim();
  const trimmedExpression = expression.trim();
  if (trimmedName === '' || trimmedExpression === '') return null;
  return { name: trimmedName, expression: trimmedExpression };
}
