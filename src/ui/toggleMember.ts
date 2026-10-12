/** @layer ui — membership toggles for view state and form checklists. @pure */

/** A copy of `list` with `value` removed if present, else appended (order kept). */
export function toggledInList<Value>(list: ReadonlyArray<Value>, value: Value): Value[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

/** A copy of `members` with `member` removed if present, else added. */
export function toggledInSet<Member>(members: ReadonlySet<Member>, member: Member): Set<Member> {
  const next = new Set(members);
  if (!next.delete(member)) next.add(member);
  return next;
}
