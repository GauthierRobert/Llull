/**
 * @layer ui/components
 *
 * Icon — the single inline-SVG icon set for llull chrome (24×24 grid, stroke icons).
 * Decorative by default (aria-hidden); pair with a labelled control.
 */

import React from 'react';

const ICON_PATHS = {
  layers: 'M12 3 2.5 8 12 13l9.5-5L12 3ZM2.5 12.5 12 17.5l9.5-5M2.5 16.5 12 21.5l9.5-5',
  assembly:
    'M3.5 7.5 9 4.5l5.5 3v6L9 16.5l-5.5-3v-6ZM9 10.5v6M3.5 7.5 9 10.5l5.5-3M14.5 13.5l6-3.3v6.3l-5.5 3-3.5-1.9',
  mechanism:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  parameters: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3.5 2',
  configurations: 'M12 2 3 7v10l9 5 9-5V7l-9-5ZM3 7l9 5 9-5M12 12v10M7.5 4.5l9 5',
  materials:
    'M12 22a10 10 0 1 1 0-20c5.5 0 10 4 10 9a5 5 0 0 1-5 5h-1.8a1.7 1.7 0 0 0-1.2 2.8A1.7 1.7 0 0 1 12 22ZM7.5 11.5h.01M10.5 7.5h.01M15.5 7.5h.01',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z',
  open: 'M3 7.5V18a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9.5a2 2 0 0 0-2-2h-7L10 5H5a2 2 0 0 0-2 2.5ZM12 11v6M9 14l3-3 3 3',
  save: 'M12 3v12M7 10l5 5 5-5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  plug: 'M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0V7ZM12 17v5',
  cube: 'M12 2.5 3.5 7v10L12 21.5 20.5 17V7L12 2.5ZM3.5 7 12 11.5 20.5 7M12 11.5v10',
  square: 'M4 4h16v16H4zM4 9h16M9 4v16',
  section: 'M6 3v18M18 3v18M3 12h18M9 7l-3 5 3 5M15 7l3 5-3 5',
  magnet: 'M6 3v8a6 6 0 0 0 12 0V3M6 3h4v8a2 2 0 0 0 4 0V3h4M6 7h4M14 7h4',
  gauge: 'M12 14 15.5 9.5M3.5 17a9 9 0 1 1 17 0M12 14a.01.01 0 1 0 0 .01',
  fit: 'M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3M8 8h8v8H8z',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  eyeOff:
    'M9.9 4.2A10 10 0 0 1 12 4c6.5 0 10 8 10 8a17 17 0 0 1-2.2 3.2M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6M14.1 14.2a3 3 0 0 1-4.2-4.2M2 2l20 20',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  unlock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 7.9-1',
  close: 'M18 6 6 18M6 6l12 12',
  play: 'M7 4v16l13-8L7 4Z',
  pause: 'M7 4h3v16H7zM14 4h3v16h-3z',
  reset: 'M3 12a9 9 0 1 0 2.6-6.4L3 8M3 3v5h5',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  bookmark: 'M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16Z',
  panelLeft: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5ZM9 3v18',
  panelRight: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5ZM15 3v18',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 16v-4M12 8h.01',
  cursor: 'M4 4l7 17 2.5-7.5L21 11 4 4Z',
  sparkle:
    'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3ZM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  check: 'M20 6 9 17l-5-5',
  ruler:
    'M21.3 15.3 8.7 2.7a1 1 0 0 0-1.4 0L2.7 7.3a1 1 0 0 0 0 1.4l12.6 12.6a1 1 0 0 0 1.4 0l4.6-4.6a1 1 0 0 0 0-1.4ZM7.5 10.5l2-2M10.5 13.5l2-2M13.5 16.5l2-2',
  wireframe:
    'M12 2.5 3.5 7v10L12 21.5 20.5 17V7L12 2.5ZM3.5 7 12 11.5 20.5 7M12 11.5v10M3.5 17 12 11.5 20.5 17M12 2.5v9',
  xray: 'M12 2.5 3.5 7v10L12 21.5 20.5 17V7L12 2.5Z M12 11.5v10M3.5 7 12 11.5 20.5 7',
  shaded: 'M12 2.5 3.5 7v10L12 21.5 20.5 17V7L12 2.5ZM3.5 7 12 11.5 20.5 7M12 11.5v10',
  plus: 'M12 5v14M5 12h14',
  trash: 'M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6M10 11v6M14 11v6',
  arrowUp: 'M12 19V5M5 12l7-7 7 7',
  arrowDown: 'M12 5v14M19 12l-7 7-7-7',
  zap: 'M13 2 4 14h7l-1 8 9-12h-7l1-8Z',
  explode: 'M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8',
} as const;

export type IconName = keyof typeof ICON_PATHS;

export interface IconProps {
  name: IconName;
  /** Rendered width/height in px. Default 16. */
  size?: number;
  /** Stroke width on the 24px grid. Default 1.75. */
  strokeWidth?: number;
  className?: string;
}

export function Icon({
  name,
  size = 16,
  strokeWidth = 1.75,
  className,
}: IconProps): React.ReactElement {
  return (
    <svg
      className={['icon', className].filter(Boolean).join(' ')}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
