import {
  CalendarCheck,
  Wallet,
  FolderOpen,
  RefreshCw,
  LayoutDashboard,
  Users,
  FileCheck2,
  Library,
  Settings2,
  UserCog,
} from 'lucide-react';
import type { workspacePageImports } from '../../workspace-page-imports';

export const navigation = [
  {
    path: '/',
    label: 'Genel Bakış',
    icon: LayoutDashboard,
    description: 'Gününüzü planlayın, çalışma alanınıza hızlıca geçin.',
  },
  {
    path: '/today-work',
    label: 'Bugünkü İşler',
    icon: CalendarCheck,
    description: 'Takiplerinizi ve günlük görevlerinizi yönetin.',
  },
  {
    path: '/customers',
    label: 'Müşteriler',
    icon: Users,
    description: 'Acente müşterileri ve ortak müşteri geçmişi.',
  },
  {
    path: '/renewals',
    label: 'Yenilemeler',
    icon: RefreshCw,
    description: 'Açık ve tamamlanan müşteri yenilemeleri.',
  },
  {
    path: '/policies',
    label: 'Poliçeler',
    icon: FileCheck2,
    description: 'Poliçe kayıtları ve dönem bilgileri.',
  },
  {
    path: '/catalogs',
    label: 'Kataloglar',
    icon: Library,
    description: 'Sigorta şirketleri, ürünler ve seçenekler.',
  },
  {
    path: '/finance',
    label: 'Muhasebe',
    icon: Wallet,
    description: 'Acente alacakları, ödeme vadeleri ve tahsilatlar.',
  },
  {
    path: '/claims',
    label: 'Hasarlar',
    icon: FolderOpen,
    description: 'Hasar dosyaları, durum ve not geçmişi.',
  },
  // Settings reads are available to active members in the existing contract;
  // mutation authority stays with the existing server permission checks.
  {
    path: '/agency-settings',
    label: 'Acente Ayarları',
    icon: Settings2,
    description: 'Acente çalışma ve yenileme ayarları.',
  },
  {
    path: '/personnel',
    label: 'Personel ve İzinler',
    icon: UserCog,
    description: 'Personel hesapları ve erişim izinleri.',
    ownerOnly: true,
  },
] satisfies Array<{
  path: keyof typeof workspacePageImports;
  label: string;
  icon: typeof LayoutDashboard;
  description: string;
  ownerOnly?: boolean;
}>;
