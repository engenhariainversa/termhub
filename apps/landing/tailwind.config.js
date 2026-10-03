/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './brand/index.html', './security/index.html', './termos/index.html', './privacidade/index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'Menlo', 'Monaco', '"SF Mono"', 'Consolas', 'monospace'],
      },
      // midnight SRE console palette: depth comes from surface tones, never from shadows
      colors: {
        canvas: '#0f101a', // page, nav and "well" backgrounds
        surface: '#151621', // card surfaces
        'border-2': '#1f2433', // elevated border, icon tile background
        border: '#939db8', // structural hairline
        muted: '#646e87', // secondary/muted text
        frost: '#c9d3ee', // secondary text, icon strokes
        accent: '#98a4f7', // links and small accents (never a filled button background)
        // the CTA gradient's stops (#5b63d3 -> #7c87f7) live in backgroundImage.cta below
      },
      screens: {
        // touch screens, whatever their width: where the 44px tap targets apply
        coarse: { raw: '(pointer: coarse)' },
      },
      fontSize: {
        display: ['53px', { lineHeight: '1.08' }],
        'heading-lg': ['40px', { lineHeight: '1.1' }],
        'heading-sm': ['28px', { lineHeight: '1.45' }],
        subheading: ['20px', { lineHeight: '1.45' }],
        body: ['16px', { lineHeight: '1.6' }],
        'body-sm': ['14px', { lineHeight: '1.55' }],
        caption: ['12px', { lineHeight: '1.45' }],
        'caption-sm': ['10px', { lineHeight: '1.4' }],
      },
      borderRadius: {
        card: '16px',
        field: '10px',
        tint: '6px',
      },
      boxShadow: {
        // the only shadow on the page: an inset rim light
        rim: 'rgba(255,255,255,0.25) 0px 1px 3px 0px inset',
      },
      backgroundImage: {
        cta: 'linear-gradient(353deg, #5b63d3 17.51%, #7c87f7 183.08%)',
      },
      maxWidth: {
        page: '1200px',
      },
    },
  },
  plugins: [],
};
