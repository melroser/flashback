import type { Config } from 'tailwindcss';

/**
 * Colour tokens, with measured WCAG contrast against both surfaces.
 *
 *   token   on void    on tar     body text?
 *   flash   18.05:1    17.00:1    yes
 *   bone    15.91:1    14.98:1    yes (default body)
 *   smoke    7.91:1     7.45:1    yes (labels, secondary)
 *   acid    14.95:1    14.08:1    yes
 *   siren    5.40:1     5.08:1    yes
 *   ice     12.70:1    11.96:1    decorative by convention
 *   uv       3.73:1     3.52:1    NEVER - fails 4.5:1
 */
const PALETTE = {
  // surfaces
  void: '#080809', // the room with the lights off
  tar: '#111114', // raised surface
  ash: '#1C1C21', // hairlines, tile borders
  // text-safe
  flash: '#F5F3EE', // overexposed frame, warm, not pure white
  bone: '#E8E5DE', // default body
  smoke: '#A8A29A', // labels, secondary
  acid: '#39FF6A', // night vision: focus rings, ended state
  siren: '#FF2D2D', // destructive, countdown urgency
  ice: '#2DE1FF', // chromatic fringe
  // NOT text-safe
  uv: '#7A3CFF', // blacklight. fills, glows, hairlines only
};

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: PALETTE,
      fontFamily: {
        display: ['var(--font-display)', 'Impact', 'Haettenschweiler', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        display: ['clamp(2.75rem, 12vw, 9rem)', { lineHeight: '0.82', letterSpacing: '-0.035em' }],
        h2: ['clamp(1.25rem, 4vw, 2rem)', { lineHeight: '1', letterSpacing: '-0.02em' }],
        body: ['0.9375rem', { lineHeight: '1.65', letterSpacing: '-0.005em' }],
        label: ['0.6875rem', { lineHeight: '1.2', letterSpacing: '0.28em' }],
        countdown: ['clamp(1.5rem, 6vw, 3rem)', { lineHeight: '1', letterSpacing: '0.02em' }],
      },
    },
    /**
     * `uv` is removed from the TEXT colour palette specifically, so `text-uv`
     * is not a class that exists. It remains available as bg-uv / border-uv /
     * shadow-uv / ring-uv. The accessibility rule lives in the token layer
     * rather than in a reviewer's memory.
     */
    textColor: ({ theme }) => {
      const colors = { ...(theme('colors') as Record<string, unknown>) };
      delete colors.uv;
      return colors as Record<string, string>;
    },
  },
  plugins: [],
} satisfies Config;
