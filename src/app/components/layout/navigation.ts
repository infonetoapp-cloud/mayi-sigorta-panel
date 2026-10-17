import {
  CalendarCheck,
  LayoutDashboard,
  Users,
  FileCheck2,
  Library,
  Settings2,
  UserCog,
} from 'lucide-react';
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
];
