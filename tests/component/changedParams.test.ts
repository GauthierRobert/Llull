import { describe, expect, it } from 'vitest';
import { changedFields, changedNumber, changedText } from '@ui/panels/changedParams';

describe('changedNumber', () => {
  it('returns the number when the text differs from the original', () => {
    expect(changedNumber('height', '3200', 3000)).toEqual({ height: 3200 });
  });
  it('is empty when unchanged', () => {
    expect(changedNumber('height', '3000', 3000)).toEqual({});
  });
  it('treats blank or invalid text as unset, not as 0', () => {
    expect(changedNumber('height', '', 3000)).toEqual({});
    expect(changedNumber('height', '   ', 3000)).toEqual({});
    expect(changedNumber('height', 'abc', 3000)).toEqual({});
  });
});

describe('changedText', () => {
  it('returns the trimmed text when it differs', () => {
    expect(changedText('name', ' Roof ', 'Floor')).toEqual({ name: 'Roof' });
  });
  it('skips blank and unchanged text', () => {
    expect(changedText('name', '  ', 'Floor')).toEqual({});
    expect(changedText('name', 'Floor', 'Floor')).toEqual({});
  });
});

describe('changedFields', () => {
  it('lists the keys whose text differs, as typed (blank clears)', () => {
    const initial = { a: '1', b: 'x', c: 'z' };
    expect(changedFields(initial, { a: '1', b: '', c: 'q' }, ['a', 'b', 'c'])).toEqual({ b: '', c: 'q' });
  });
});
