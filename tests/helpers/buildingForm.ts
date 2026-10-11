import { screen, fireEvent } from '@testing-library/react';

export const pickTool = (id: string): void => {
  fireEvent.change(screen.getByTestId('building-tool-select'), { target: { value: id } });
};
export const setField = (key: string, value: string): void => {
  fireEvent.change(screen.getByTestId(`tool-field-${key}`), { target: { value } });
};
export const submit = (): void => {
  fireEvent.click(screen.getByTestId('tool-submit'));
};
