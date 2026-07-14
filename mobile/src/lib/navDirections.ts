// The single source of truth for "which physical direction goes where" —
// shared by the hub's full-screen swipe gesture and the BB joystick overlay
// so a drag and a d-pad tap in the same direction always agree.
export type Direction = 'up' | 'down' | 'left' | 'right';

export const NAV_ROUTES: Record<Direction, string> = {
  down: '/session-voice',
  // The One Conversation surface (session.tsx) — chat, dashboard, and content
  // in one place. session-chat retires once the remaining phases land.
  up: '/session',
  left: '/content-feed',
  right: '/profile',
};

export const NAV_LABELS: Record<Direction, string> = {
  down: 'Voice',
  up: 'Buddy',
  left: 'Content',
  right: 'Profile',
};
