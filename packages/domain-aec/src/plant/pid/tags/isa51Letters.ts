/** ISA 5.1 identification letters as data: transcribed from validation/data/isa51_letters.json (a test compares the two). Grade B rows are returned flagged unverified (AF-32). */

export type LetterGrade = 'A' | 'B';
export type LetterRole = 'readout' | 'output' | 'modifier';

export interface FirstLetterRow {
  readonly letter: string;
  readonly meaning: string;
  /** Meaning of the letter when it follows the first letter as a modifier (D, F, J, K, Q, S, X, Y, Z), else null. */
  readonly modifier: string | null;
  readonly grade: LetterGrade;
}

export interface SucceedingLetterRow {
  readonly letter: string;
  readonly role: LetterRole;
  readonly meaning: string;
  readonly grade: LetterGrade;
}

export const FIRST_LETTERS: readonly FirstLetterRow[] = [
  { letter: 'A', meaning: 'Analysis', modifier: null, grade: 'A' },
  { letter: 'B', meaning: 'Burner, combustion', modifier: null, grade: 'A' },
  { letter: 'C', meaning: "User's choice", modifier: null, grade: 'A' },
  { letter: 'D', meaning: "User's choice", modifier: 'Differential', grade: 'A' },
  { letter: 'E', meaning: 'Voltage', modifier: null, grade: 'A' },
  { letter: 'F', meaning: 'Flow, flow rate', modifier: 'Ratio (fraction)', grade: 'A' },
  { letter: 'G', meaning: "User's choice", modifier: null, grade: 'A' },
  { letter: 'H', meaning: 'Hand (manually initiated)', modifier: null, grade: 'A' },
  { letter: 'I', meaning: 'Current (electrical)', modifier: null, grade: 'B' },
  { letter: 'J', meaning: 'Power', modifier: 'Scan', grade: 'B' },
  { letter: 'K', meaning: 'Time, time schedule', modifier: 'Time rate of change', grade: 'B' },
  { letter: 'L', meaning: 'Level', modifier: null, grade: 'A' },
  { letter: 'M', meaning: "User's choice", modifier: null, grade: 'A' },
  { letter: 'N', meaning: "User's choice", modifier: null, grade: 'A' },
  { letter: 'O', meaning: "User's choice", modifier: null, grade: 'A' },
  { letter: 'P', meaning: 'Pressure, vacuum', modifier: null, grade: 'A' },
  { letter: 'Q', meaning: 'Quantity', modifier: 'Integrate, totalize', grade: 'A' },
  { letter: 'R', meaning: 'Radiation', modifier: null, grade: 'A' },
  { letter: 'S', meaning: 'Speed, frequency', modifier: 'Safety', grade: 'A' },
  { letter: 'T', meaning: 'Temperature', modifier: null, grade: 'A' },
  { letter: 'U', meaning: 'Multivariable', modifier: null, grade: 'A' },
  { letter: 'V', meaning: 'Vibration, mechanical analysis', modifier: null, grade: 'A' },
  { letter: 'W', meaning: 'Weight, force', modifier: null, grade: 'A' },
  { letter: 'X', meaning: 'Unclassified', modifier: 'X axis', grade: 'B' },
  { letter: 'Y', meaning: 'Event, state or presence', modifier: 'Y axis', grade: 'A' },
  { letter: 'Z', meaning: 'Position, dimension', modifier: 'Z axis', grade: 'A' },
];

export const SUCCEEDING_LETTERS: readonly SucceedingLetterRow[] = [
  { letter: 'A', role: 'readout', meaning: 'Alarm', grade: 'A' },
  { letter: 'B', role: 'readout', meaning: "User's choice", grade: 'A' },
  { letter: 'C', role: 'output', meaning: 'Control', grade: 'A' },
  { letter: 'E', role: 'readout', meaning: 'Sensor, primary element', grade: 'A' },
  { letter: 'G', role: 'readout', meaning: 'Glass, gauge, viewing device', grade: 'A' },
  { letter: 'H', role: 'modifier', meaning: 'High', grade: 'A' },
  { letter: 'I', role: 'readout', meaning: 'Indicate', grade: 'A' },
  { letter: 'K', role: 'output', meaning: 'Control station', grade: 'A' },
  { letter: 'L', role: 'readout', meaning: 'Light', grade: 'A' },
  { letter: 'L', role: 'modifier', meaning: 'Low', grade: 'A' },
  { letter: 'M', role: 'modifier', meaning: 'Middle, intermediate', grade: 'B' },
  { letter: 'N', role: 'readout', meaning: "User's choice", grade: 'A' },
  { letter: 'O', role: 'readout', meaning: 'Orifice, restriction', grade: 'A' },
  { letter: 'P', role: 'readout', meaning: 'Point (test connection)', grade: 'A' },
  { letter: 'R', role: 'readout', meaning: 'Record', grade: 'A' },
  { letter: 'S', role: 'output', meaning: 'Switch', grade: 'A' },
  { letter: 'T', role: 'output', meaning: 'Transmit', grade: 'A' },
  { letter: 'U', role: 'readout', meaning: 'Multifunction', grade: 'A' },
  { letter: 'U', role: 'output', meaning: 'Multifunction', grade: 'A' },
  { letter: 'V', role: 'output', meaning: 'Valve, damper, louver', grade: 'A' },
  { letter: 'W', role: 'readout', meaning: 'Well, probe', grade: 'A' },
  { letter: 'X', role: 'readout', meaning: 'Unclassified', grade: 'A' },
  { letter: 'Y', role: 'output', meaning: 'Relay, compute, convert', grade: 'A' },
  { letter: 'Z', role: 'output', meaning: 'Driver, actuator, unclassified final control element', grade: 'A' },
];
