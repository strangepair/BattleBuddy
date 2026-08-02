import { create } from 'zustand';

interface UIState {
  drawerOpen: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
  menuOpen: boolean;
  openMenu: () => void;
  closeMenu: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  drawerOpen: false,
  openDrawer: () => set({ drawerOpen: true }),
  closeDrawer: () => set({ drawerOpen: false }),
  menuOpen: false,
  openMenu: () => set({ menuOpen: true }),
  closeMenu: () => set({ menuOpen: false }),
}));
