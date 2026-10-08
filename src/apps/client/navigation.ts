import { Box, CheckCircle2, Download, Gauge, Heart, LifeBuoy, Settings, Wrench } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface NavigationItem {
  path: string;
  label: string;
  icon: LucideIcon;
  enabled: boolean;
  visible: boolean;
}

export const navigationItems: readonly NavigationItem[] = [
  { path: '/', label: 'Dashboard', icon: Gauge, enabled: true, visible: true },
  { path: '/tools', label: 'Ferramentas', icon: Wrench, enabled: true, visible: true },
  { path: '/validation', label: 'Validação', icon: CheckCircle2, enabled: true, visible: true },
  { path: '/installations', label: 'Instalações', icon: Box, enabled: true, visible: true },
  { path: '/favorites', label: 'Favoritos', icon: Heart, enabled: false, visible: false },
  { path: '/support', label: 'Suporte', icon: LifeBuoy, enabled: false, visible: false },
  { path: '/download', label: 'Download', icon: Download, enabled: true, visible: true },
  { path: '/settings', label: 'Configurações', icon: Settings, enabled: true, visible: true }
];

export const visibleNavigationItems = navigationItems.filter(item => item.enabled && item.visible);
