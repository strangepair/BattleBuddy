export const Colors = {
  // Brand
  coral: '#E8624A',
  coralSoft: '#FF6B6B',

  // Mascot state colors (eye + ring)
  stateIdle: '#5B9FFF',
  stateListening: '#FF9F0A',
  stateUserSpeaking: '#34C759',
  stateSpeaking: '#E8624A',

  // Surfaces
  background: '#1C1C1E',
  surface: '#2C2C2E',
  surfaceBorder: '#3A3A3C',
  surfaceLight: '#48484A',

  // Text
  textPrimary: '#FFFFFF',
  textSecondary: '#8E8E93',
  textTertiary: '#636366',

  // Semantic
  success: '#34C759',
  warning: '#FF9F0A',
  error: '#FF453A',

  // Chrome scrims (corner nav buttons over media/entity backgrounds)
  iconScrim: 'rgba(0,0,0,0.35)',
} as const;

// Mascot body palette (grays with warm tint)
export const MascotColors = {
  body: '#3A3A3C',
  bodyDark: '#2C2C2E',
  bodyLight: '#48484A',
  eyeSocket: '#1C1C1E',
  highlight: '#FFFFFF',
} as const;

export const Typography = {
  heading: { fontSize: 32, fontWeight: '700' as const, color: Colors.textPrimary },
  screenTitle: { fontSize: 18, fontWeight: '700' as const, color: Colors.textPrimary },
  subheading: { fontSize: 16, fontWeight: '400' as const, color: Colors.textSecondary },
  body: { fontSize: 16, fontWeight: '400' as const, color: Colors.textPrimary },
  caption: { fontSize: 13, fontWeight: '400' as const, color: Colors.textTertiary },
  label: { fontSize: 14, fontWeight: '600' as const, color: Colors.textPrimary },
  // One numeral scale for hero stat displays (Analytics/Goals streak, etc.)
  statHero: { fontSize: 48, fontWeight: '800' as const, color: Colors.coral },
  statValue: { fontSize: 28, fontWeight: '700' as const, color: Colors.textPrimary },
} as const;

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const Radii = {
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  full: 9999,
} as const;
