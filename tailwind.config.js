/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./active/manager/**/*.{html,js}"
  ],
  theme: {
    extend: {
      colors: {
        brand: '#EA5F08',
        brandLight: '#fb923c',
        brandDark: '#c2410c',
        brandBlue: '#00B7FF',
        brandGreen: '#22C55E',
        appBg: '#0B1019',
        containerBg: '#131A26',
        cardBg: '#182130',
        cardSubBg: '#1F2B3E',
        borderNormal: '#243044',
        borderHighlight: '#33435C',
        textMain: '#E6ECF3',
        textSub: '#94A3B8',
        statusGreen: '#22C55E',
        statusYellow: '#F59E0B',
        statusRed: '#EF4444'
      },
      fontFamily: {
        sans: ['Outfit', 'Noto Sans JP', 'sans-serif'],
        mono: ['Outfit', 'monospace']
      }
    }
  },
  safelist: [
    'text-white',
    'text-white/20',
    'hover:bg-white/10',
    'cursor-pointer',
    'cursor-not-allowed',
    'bg-statusRed',
    'bg-statusGreen',
    'animate-pulse',
    'opacity-20',
    'filter',
    'blur-xs',
    'text-statusRed',
    'text-brand',
    'bg-brand',
    'text-black',
    'font-bold',
    'shadow-lg',
    'shadow-brand/20',
    'hover:brightness-110',
    'bg-white/5',
    'hover:bg-white/10',
    'border',
    'border-borderNormal',
    'text-textSub',
    'hover:text-white',
    'bg-brand/15',
    'border-brand/35',
    'shadow-sm',
    'font-semibold',
    'bg-[#0B1019]/60',
    'border-borderNormal/60',
    'text-[#EF4444]',
    'hidden',
    'lg:flex',
    'flex'
  ],
  plugins: []
};
