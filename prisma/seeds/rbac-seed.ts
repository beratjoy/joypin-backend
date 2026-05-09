import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * RBAC Seed — Varsayılan Roller ve Yetkiler
 *
 * Kullanım: npx ts-node prisma/seeds/rbac-seed.ts
 */
async function main() {
  console.log('🔐 RBAC Seed başlıyor...');

  // ═══════════════════════════════════════════════════════════
  // 1. PERMISSIONS (Granüler Yetkiler)
  // ═══════════════════════════════════════════════════════════

  const permissions = [
    // Siparişler
    { code: 'orders.view', name: 'Siparişleri Görüntüle', module: 'orders' },
    { code: 'orders.manage', name: 'Siparişleri Yönet (Onayla/İptal)', module: 'orders' },
    { code: 'orders.refund', name: 'Sipariş İadesi Yap', module: 'orders' },
    { code: 'orders.assign', name: 'Sipariş Devral (Staff Pool)', module: 'orders' },

    // Stok
    { code: 'stocks.view', name: 'Stok Görüntüle', module: 'stocks' },
    { code: 'stocks.add', name: 'Stok Ekle', module: 'stocks' },
    { code: 'stocks.delete', name: 'Stok Sil', module: 'stocks' },
    { code: 'stocks.manage_pools', name: 'Havuz Yönetimi', module: 'stocks' },

    // E-Pin
    { code: 'epins.view_masked', name: 'E-pinleri Maskeli Gör', module: 'epins' },
    { code: 'epins.decrypt', name: 'E-pin Kodunu Çöz (Unlock)', module: 'epins' },
    { code: 'epins.approve_unlock', name: 'Unlock Taleplerini Onayla', module: 'epins' },

    // Kullanıcılar
    { code: 'users.view', name: 'Kullanıcıları Görüntüle', module: 'users' },
    { code: 'users.manage', name: 'Kullanıcı Düzenle', module: 'users' },
    { code: 'users.delete', name: 'Kullanıcı Sil', module: 'users' },
    { code: 'users.impersonate', name: 'Kullanıcı Kimliğine Bürün', module: 'users' },

    // Bayiler (B2B)
    { code: 'dealers.view', name: 'Bayileri Görüntüle', module: 'dealers' },
    { code: 'dealers.manage', name: 'Bayi Yönet', module: 'dealers' },
    { code: 'dealers.pricing', name: 'Bayi Fiyatlandırma', module: 'dealers' },
    { code: 'dealers.api_logs', name: 'API Loglarını Gör', module: 'dealers' },

    // Finans
    { code: 'finance.view_reports', name: 'Mali Raporları Gör', module: 'finance' },
    { code: 'finance.manage_wallets', name: 'Cüzdan Yönet', module: 'finance' },
    { code: 'finance.withdrawals', name: 'Çekim Taleplerini Yönet', module: 'finance' },
    { code: 'finance.view_costs', name: 'Maliyet/Kar Görüntüle', module: 'finance' },

    // Yayıncı / Affiliate
    { code: 'affiliates.view', name: 'Yayıncıları Gör', module: 'affiliates' },
    { code: 'affiliates.manage', name: 'Yayıncı Başvuruları Yönet', module: 'affiliates' },
    { code: 'affiliates.commissions', name: 'Komisyon Oranlarını Düzenle', module: 'affiliates' },
    { code: 'affiliates.payments', name: 'Yayıncı Ödemelerini Yönet', module: 'affiliates' },

    // Personel
    { code: 'staff.manage_roles', name: 'Rol Yönetimi', module: 'staff' },
    { code: 'staff.manage_users', name: 'Personel Yönetimi', module: 'staff' },
    { code: 'staff.view_audit', name: 'Denetim Loglarını Gör', module: 'staff' },

    // Sistem
    { code: 'system.settings', name: 'Kritik Ayarlar', module: 'system' },
    { code: 'system.integrations', name: 'Entegrasyonlar', module: 'system' },
    { code: 'system.maintenance', name: 'Bakım Modu', module: 'system' },

    // Ürünler
    { code: 'products.view', name: 'Ürünleri Gör', module: 'products' },
    { code: 'products.manage', name: 'Ürün Ekle/Düzenle', module: 'products' },
    { code: 'products.delete', name: 'Ürün Sil', module: 'products' },

    // Kampanyalar
    { code: 'campaigns.view', name: 'Kampanyaları Gör', module: 'campaigns' },
    { code: 'campaigns.manage', name: 'Kampanya Yönet', module: 'campaigns' },
  ];

  for (const perm of permissions) {
    await prisma.permission.upsert({
      where: { code: perm.code },
      create: perm,
      update: { name: perm.name, module: perm.module },
    });
  }
  console.log(`  ✓ ${permissions.length} yetki oluşturuldu`);

  // ═══════════════════════════════════════════════════════════
  // 2. ROLES (Ön Tanımlı Personel Rolleri)
  // ═══════════════════════════════════════════════════════════

  const allPermCodes = permissions.map(p => p.code);
  const viewOnlyCodes = permissions.filter(p => p.code.includes('.view')).map(p => p.code);

  const roles = [
    {
      name: 'super_admin',
      displayName: 'Süper Admin',
      description: 'Her şeye yetkili — kodları onaysız görebilir/çözebilir',
      color: '#ef4444',
      isSystem: true,
      canDecryptWithoutApproval: true,
      permissions: allPermCodes,
    },
    {
      name: 'demo_admin',
      displayName: 'Demo Admin',
      description: 'Her modülü görür ama ekleme/silme/düzenleme yapamaz',
      color: '#8b5cf6',
      isSystem: true,
      canDecryptWithoutApproval: false,
      permissions: viewOnlyCodes,
    },
    {
      name: 'operation_admin',
      displayName: 'Admin (Operasyon)',
      description: 'Stok ekleyebilir, sipariş onaylayabilir — mali raporları ve kritik ayarları göremez',
      color: '#3b82f6',
      isSystem: true,
      canDecryptWithoutApproval: false,
      permissions: [
        'orders.view', 'orders.manage', 'orders.assign',
        'stocks.view', 'stocks.add', 'stocks.manage_pools',
        'epins.view_masked', 'epins.decrypt',
        'users.view',
        'products.view', 'products.manage',
        'campaigns.view',
      ],
    },
    {
      name: 'dealer_manager',
      displayName: 'Bayi Yöneticisi',
      description: 'Sadece B2B üyeleri, bayi siparişlerini ve API loglarını yönetebilir',
      color: '#f59e0b',
      isSystem: true,
      canDecryptWithoutApproval: false,
      permissions: [
        'dealers.view', 'dealers.manage', 'dealers.pricing', 'dealers.api_logs',
        'orders.view',
        'users.view',
        'stocks.view',
      ],
    },
    {
      name: 'affiliate_manager',
      displayName: 'Yayıncı (Affiliate) Yöneticisi',
      description: 'Sadece yayıncı başvurularını, komisyon oranlarını ve ödeme taleplerini yönetebilir',
      color: '#10b981',
      isSystem: true,
      canDecryptWithoutApproval: false,
      permissions: [
        'affiliates.view', 'affiliates.manage', 'affiliates.commissions', 'affiliates.payments',
        'users.view',
        'finance.withdrawals',
      ],
    },
  ];

  for (const roleData of roles) {
    const { permissions: permCodes, ...roleFields } = roleData;

    const role = await prisma.staffRole.upsert({
      where: { name: roleFields.name },
      create: roleFields,
      update: {
        displayName: roleFields.displayName,
        description: roleFields.description,
        color: roleFields.color,
        canDecryptWithoutApproval: roleFields.canDecryptWithoutApproval,
      },
    });

    // Yetki bağlantılarını kur
    const permRecords = await prisma.permission.findMany({
      where: { code: { in: permCodes } },
      select: { id: true },
    });

    // Mevcut bağlantıları temizle
    await prisma.staffRolePermission.deleteMany({ where: { roleId: role.id } });

    // Yenilerini ekle
    await prisma.staffRolePermission.createMany({
      data: permRecords.map(p => ({ roleId: role.id, permissionId: p.id })),
      skipDuplicates: true,
    });

    console.log(`  ✓ Rol: ${role.displayName} (${permCodes.length} yetki)`);
  }

  console.log('\n🎉 RBAC Seed tamamlandı!');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
