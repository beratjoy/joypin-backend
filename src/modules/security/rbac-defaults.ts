export const DEFAULT_PERMISSIONS = [
  { code: 'orders.view', name: 'Siparisleri Goruntule', module: 'orders' },
  { code: 'orders.manage', name: 'Siparisleri Yonet', module: 'orders' },
  { code: 'orders.refund', name: 'Siparis Iadesi Yap', module: 'orders' },
  { code: 'orders.assign', name: 'Siparis Devral', module: 'orders' },

  { code: 'stocks.view', name: 'Stok Goruntule', module: 'stocks' },
  { code: 'stocks.add', name: 'Stok Ekle', module: 'stocks' },
  { code: 'stocks.delete', name: 'Stok Sil', module: 'stocks' },
  { code: 'stocks.manage_pools', name: 'Havuz Yonetimi', module: 'stocks' },

  { code: 'epins.view_masked', name: 'E-pinleri Maskeli Gor', module: 'epins' },
  { code: 'epins.decrypt', name: 'E-pin Kodunu Coz', module: 'epins' },
  { code: 'epins.approve_unlock', name: 'Unlock Taleplerini Onayla', module: 'epins' },

  { code: 'users.view', name: 'Kullanicilari Goruntule', module: 'users' },
  { code: 'users.manage', name: 'Kullanici Duzenle', module: 'users' },
  { code: 'users.delete', name: 'Kullanici Sil', module: 'users' },
  { code: 'users.impersonate', name: 'Kullanici Kimligine Burun', module: 'users' },

  { code: 'dealers.view', name: 'Bayileri Goruntule', module: 'dealers' },
  { code: 'dealers.manage', name: 'Bayi Yonet', module: 'dealers' },
  { code: 'dealers.pricing', name: 'Bayi Fiyatlandirma', module: 'dealers' },
  { code: 'dealers.api_logs', name: 'Bayi API Loglari', module: 'dealers' },

  { code: 'finance.view_reports', name: 'Mali Raporlari Gor', module: 'finance' },
  { code: 'finance.manage_wallets', name: 'Cuzdan Yonet', module: 'finance' },
  { code: 'finance.withdrawals', name: 'Cekim Taleplerini Yonet', module: 'finance' },
  { code: 'finance.view_costs', name: 'Maliyet ve Kar Gor', module: 'finance' },

  { code: 'affiliates.view', name: 'Yayincilari Gor', module: 'affiliates' },
  { code: 'affiliates.manage', name: 'Yayinci Basvurularini Yonet', module: 'affiliates' },
  { code: 'affiliates.commissions', name: 'Komisyon Oranlarini Duzenle', module: 'affiliates' },
  { code: 'affiliates.payments', name: 'Yayinci Odemelerini Yonet', module: 'affiliates' },

  { code: 'staff.manage_roles', name: 'Rol Yonetimi', module: 'staff' },
  { code: 'staff.manage_users', name: 'Personel Yonetimi', module: 'staff' },
  { code: 'staff.view_audit', name: 'Denetim Loglarini Gor', module: 'staff' },

  { code: 'system.settings', name: 'Kritik Ayarlar', module: 'system' },
  { code: 'system.integrations', name: 'Entegrasyonlar', module: 'system' },
  { code: 'system.maintenance', name: 'Bakim Modu', module: 'system' },

  { code: 'products.view', name: 'Urunleri Gor', module: 'products' },
  { code: 'products.manage', name: 'Urun Ekle ve Duzenle', module: 'products' },
  { code: 'products.delete', name: 'Urun Sil', module: 'products' },

  { code: 'campaigns.view', name: 'Kampanyalari Gor', module: 'campaigns' },
  { code: 'campaigns.manage', name: 'Kampanya Yonet', module: 'campaigns' },
] as const;

const ALL_PERMISSIONS = DEFAULT_PERMISSIONS.map((permission) => permission.code);
const VIEW_PERMISSIONS = DEFAULT_PERMISSIONS
  .filter((permission) => permission.code.includes('.view'))
  .map((permission) => permission.code);

export const DEFAULT_STAFF_ROLES = [
  {
    name: 'yazilimci_yonetici',
    displayName: 'Yazilimci Yonetici',
    description: 'Tum modullere teknik yonetim yetkisi. Kritik ayarlar, entegrasyonlar ve personel rolleri dahil.',
    color: '#ef4444',
    isSystem: true,
    canDecryptWithoutApproval: true,
    permissions: ALL_PERMISSIONS,
  },
  {
    name: 'yonetici',
    displayName: 'Yonetici',
    description: 'Operasyon, siparis, stok, urun, kampanya ve personel yonetimi.',
    color: '#3b82f6',
    isSystem: true,
    canDecryptWithoutApproval: false,
    permissions: ALL_PERMISSIONS.filter((code) => !['system.maintenance', 'users.delete'].includes(code)),
  },
  {
    name: 'bayi_sorumlusu',
    displayName: 'Bayi Sorumlusu',
    description: 'Bayi hesaplari, bayi fiyatlandirmasi, bayi siparisleri ve ilgili raporlar.',
    color: '#f59e0b',
    isSystem: true,
    canDecryptWithoutApproval: false,
    permissions: [
      'dealers.view',
      'dealers.manage',
      'dealers.pricing',
      'dealers.api_logs',
      'orders.view',
      'orders.assign',
      'users.view',
      'finance.view_reports',
      'products.view',
      'stocks.view',
    ],
  },
  {
    name: 'yayinci_sorumlusu',
    displayName: 'Yayinci Sorumlusu',
    description: 'Yayinci basvurulari, komisyonlar, odeme talepleri ve kampanya gorunurlugu.',
    color: '#10b981',
    isSystem: true,
    canDecryptWithoutApproval: false,
    permissions: [
      'affiliates.view',
      'affiliates.manage',
      'affiliates.commissions',
      'affiliates.payments',
      'users.view',
      'finance.withdrawals',
      'campaigns.view',
    ],
  },
  {
    name: 'salt_okuma',
    displayName: 'Salt Okuma',
    description: 'Tum ana modulleri gorur, degisiklik yapamaz.',
    color: '#8b5cf6',
    isSystem: true,
    canDecryptWithoutApproval: false,
    permissions: VIEW_PERMISSIONS,
  },
] as const;
