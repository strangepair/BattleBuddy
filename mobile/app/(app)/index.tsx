import { useCallback } from 'react';
import HubHomeScreen from '../../src/components/home/HubHomeScreen';
import { useUIStore } from '../../src/stores/uiStore';

export default function AppIndex() {
  const openDrawer = useUIStore((s) => s.openDrawer);
  const handleOpenDrawer = useCallback(() => openDrawer(), [openDrawer]);

  return <HubHomeScreen onOpenDrawer={handleOpenDrawer} />;
}
