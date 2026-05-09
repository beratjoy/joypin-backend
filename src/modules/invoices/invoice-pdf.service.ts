import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

interface InvoiceData {
  invoiceNumber: string;
  issuedAt: Date;
  dueDate?: Date;
  
  // Billing Entity (Şirket bilgileri)
  billingEntity: {
    name: string;
    legalName: string;
    taxId: string;
    vatNumber?: string;
    address: string;
    city: string;
    state?: string;
    country: string;
    postalCode: string;
    email: string;
    phone: string;
    website?: string;
    logoUrl?: string;
  };
  
  // Müşteri bilgileri
  customer: {
    name: string;
    email: string;
    address?: string;
    city?: string;
    country?: string;
    taxId?: string;
  };
  
  // Fatura kalemleri
  items: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
  }>;
  
  // Tutarlar
  subtotal: number;
  serviceFee?: number;
  taxRate: number;
  taxAmount: number;
  totalAmount: number;
  currency: string;
  
  // Notlar
  notes?: string;
  terms?: string;
}

interface PdfTemplate {
  primaryColor: string;
  secondaryColor: string;
  fontFamily: string;
  language: 'en' | 'tr' | 'ar';
}

@Injectable()
export class InvoicePdfService {
  private readonly DEFAULT_TEMPLATE: PdfTemplate = {
    primaryColor: '#2563eb',
    secondaryColor: '#64748b',
    fontFamily: 'Inter, Arial, sans-serif',
    language: 'en',
  };

  // Çoklu dil desteği (i18n)
  private readonly TRANSLATIONS = {
    en: {
      invoice: 'INVOICE',
      invoiceNumber: 'Invoice Number',
      invoiceDate: 'Invoice Date',
      dueDate: 'Due Date',
      billedTo: 'Billed To',
      from: 'From',
      description: 'Description',
      quantity: 'Qty',
      unitPrice: 'Unit Price',
      amount: 'Amount',
      subtotal: 'Subtotal',
      serviceFee: 'Service Fee',
      tax: 'Tax ({rate}%)',
      total: 'Total',
      notes: 'Notes',
      terms: 'Terms & Conditions',
      thankYou: 'Thank you for your business!',
      page: 'Page',
      of: 'of',
    },
    tr: {
      invoice: 'FATURA',
      invoiceNumber: 'Fatura No',
      invoiceDate: 'Fatura Tarihi',
      dueDate: 'Son Ödeme',
      billedTo: 'Fatura Edilen',
      from: 'Gönderen',
      description: 'Açıklama',
      quantity: 'Adet',
      unitPrice: 'Birim Fiyat',
      amount: 'Tutar',
      subtotal: 'Ara Toplam',
      serviceFee: 'Hizmet Bedeli',
      tax: 'KDV (%{rate})',
      total: 'Genel Toplam',
      notes: 'Notlar',
      terms: 'Şartlar ve Koşullar',
      thankYou: 'Bizi tercih ettiğiniz için teşekkür ederiz!',
      page: 'Sayfa',
      of: '/',
    },
    ar: {
      invoice: 'فاتورة',
      invoiceNumber: 'رقم الفاتورة',
      invoiceDate: 'تاريخ الفاتورة',
      dueDate: 'تاريخ الاستحقاق',
      billedTo: 'فاتورة إلى',
      from: 'من',
      description: 'الوصف',
      quantity: 'الكمية',
      unitPrice: 'سعر الوحدة',
      amount: 'المبلغ',
      subtotal: 'المجموع الفرعي',
      serviceFee: 'رسوم الخدمة',
      tax: 'الضريبة (%{rate})',
      total: 'الإجمالي',
      notes: 'ملاحظات',
      terms: 'الشروط والأحكام',
      thankYou: 'شكراً لتعاملكم معنا!',
      page: 'صفحة',
      of: 'من',
    },
  };

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Fatura oluştur ve PDF HTML'i hazırla
   * Joy Bilişim Yazılım E-Ticaret Danışmanlık Limited Şirketi varsayılan şirket
   */
  async generateInvoicePdf(
    invoiceId: string,
    templateOverride?: Partial<PdfTemplate>,
  ): Promise<{ html: string; pdfBuffer?: Buffer }> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        items: true,
        user: true,
        billingEntity: true,
      },
    });

    if (!invoice) {
      throw new Error('Invoice not found');
    }

    // Billing entity yoksa varsayılanı oluştur/getir
    const billingEntity = invoice.billingEntity || await this.getDefaultBillingEntity();

    const template = { ...this.DEFAULT_TEMPLATE, ...templateOverride };
    const t = this.TRANSLATIONS[template.language];

    const data: InvoiceData = {
      invoiceNumber: invoice.invoiceNumber,
      issuedAt: invoice.issuedAt || invoice.createdAt,
      billingEntity: {
        name: billingEntity.name,
        legalName: billingEntity.legalName,
        taxId: billingEntity.taxId,
        vatNumber: billingEntity.vatNumber || undefined,
        address: billingEntity.address,
        city: billingEntity.city,
        state: billingEntity.state || undefined,
        country: billingEntity.country,
        postalCode: billingEntity.postalCode,
        email: billingEntity.email,
        phone: billingEntity.phone,
        website: billingEntity.website || undefined,
        logoUrl: billingEntity.logoUrl || undefined,
      },
      customer: {
        name: invoice.customerName,
        email: invoice.customerEmail,
        address: invoice.customerAddress || undefined,
      },
      items: invoice.items.map(item => ({
        description: item.productName,
        quantity: item.quantity,
        unitPrice: Number(item.unitPrice),
        totalPrice: Number(item.totalPrice),
      })),
      subtotal: Number(invoice.subtotal),
      serviceFee: Number(invoice.serviceFee) || undefined,
      taxRate: Number(invoice.taxRate),
      taxAmount: Number(invoice.taxAmount),
      totalAmount: Number(invoice.totalAmount),
      currency: invoice.currency,
      notes: invoice.notes || undefined,
    };

    const html = this.renderHtmlTemplate(data, template, t);

    return { html };
  }

  /**
   * Varsayılan billing entity oluştur (Joy Bilişim)
   */
  async getDefaultBillingEntity() {
    const defaultEntity = await this.prisma.billingEntity.findFirst({
      where: { isDefault: true, isActive: true },
    });

    if (defaultEntity) return defaultEntity;

    // Oluştur varsayılan şirket
    return this.prisma.billingEntity.create({
      data: {
        name: 'Joy Bilisim',
        legalName: 'Joy Bilişim Yazılım E-Ticaret Danışmanlık Limited Şirketi',
        taxId: '1234567890',
        vatNumber: 'TR1234567890',
        address: 'Örnek Mahallesi, Yazılım Plaza No:42',
        city: 'Istanbul',
        country: 'TR',
        postalCode: '34000',
        email: 'billing@joybilisim.com',
        phone: '+90 212 555 00 00',
        website: 'https://joybilisim.com',
        isDefault: true,
        isActive: true,
        paymentAccounts: {
          banks: [
            { name: 'Ziraat Bankasi', iban: 'TR00 0000 0000 0000 0000 0000 00', swift: 'TCZBTR2A' },
          ],
          crypto: [
            { currency: 'USDT', network: 'TRC20', address: 'TXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' },
          ],
        },
      },
    });
  }

  /**
   * HTML Template render
   */
  private renderHtmlTemplate(
    data: InvoiceData,
    template: PdfTemplate,
    t: typeof this.TRANSLATIONS.en,
  ): string {
    const currencySymbol = this.getCurrencySymbol(data.currency);

    return `<!DOCTYPE html>
<html lang="${template.language}">
<head>
  <meta charset="UTF-8">
  <title>${t.invoice} - ${data.invoiceNumber}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: ${template.fontFamily};
      font-size: 14px;
      line-height: 1.5;
      color: #1f2937;
      background: #fff;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
      padding: 40px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 40px;
      padding-bottom: 20px;
      border-bottom: 2px solid ${template.primaryColor};
    }
    .company-info {
      flex: 1;
    }
    .company-logo {
      width: 120px;
      height: 60px;
      object-fit: contain;
      margin-bottom: 10px;
    }
    .company-name {
      font-size: 24px;
      font-weight: 700;
      color: ${template.primaryColor};
    }
    .company-legal {
      font-size: 12px;
      color: ${template.secondaryColor};
      margin-top: 4px;
    }
    .company-details {
      font-size: 11px;
      color: ${template.secondaryColor};
      margin-top: 10px;
      line-height: 1.6;
    }
    .invoice-title {
      text-align: right;
    }
    .invoice-title h1 {
      font-size: 36px;
      font-weight: 700;
      color: ${template.primaryColor};
      text-transform: uppercase;
      letter-spacing: 2px;
    }
    .invoice-meta {
      margin-top: 15px;
      text-align: right;
      font-size: 12px;
    }
    .invoice-meta-row {
      margin: 4px 0;
      color: ${template.secondaryColor};
    }
    .invoice-meta-label {
      font-weight: 600;
      color: #374151;
    }
    .parties {
      display: flex;
      justify-content: space-between;
      margin: 30px 0;
      gap: 40px;
    }
    .party-box {
      flex: 1;
      background: #f8fafc;
      padding: 20px;
      border-radius: 8px;
    }
    .party-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: ${template.secondaryColor};
      margin-bottom: 8px;
    }
    .party-name {
      font-size: 16px;
      font-weight: 600;
      color: #1f2937;
    }
    .party-details {
      font-size: 12px;
      color: ${template.secondaryColor};
      margin-top: 8px;
      line-height: 1.6;
    }
    .items-table {
      width: 100%;
      border-collapse: collapse;
      margin: 30px 0;
    }
    .items-table th {
      background: ${template.primaryColor};
      color: white;
      padding: 12px;
      text-align: left;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .items-table td {
      padding: 12px;
      border-bottom: 1px solid #e5e7eb;
      font-size: 13px;
    }
    .items-table tr:last-child td {
      border-bottom: 2px solid ${template.primaryColor};
    }
    .text-right {
      text-align: right;
    }
    .totals-section {
      display: flex;
      justify-content: flex-end;
      margin-top: 20px;
    }
    .totals-box {
      width: 300px;
    }
    .total-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      font-size: 13px;
      color: ${template.secondaryColor};
    }
    .total-row.final {
      font-size: 18px;
      font-weight: 700;
      color: ${template.primaryColor};
      border-top: 2px solid ${template.primaryColor};
      padding-top: 12px;
      margin-top: 8px;
    }
    .notes-section {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #e5e7eb;
    }
    .notes-title {
      font-size: 12px;
      font-weight: 600;
      color: ${template.secondaryColor};
      margin-bottom: 8px;
    }
    .notes-content {
      font-size: 12px;
      color: #6b7280;
      line-height: 1.6;
    }
    .footer {
      margin-top: 60px;
      text-align: center;
      font-size: 11px;
      color: ${template.secondaryColor};
      padding-top: 20px;
      border-top: 1px solid #e5e7eb;
    }
    .thank-you {
      font-weight: 600;
      color: ${template.primaryColor};
      margin-bottom: 8px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="company-info">
        ${data.billingEntity.logoUrl ? `<img src="${data.billingEntity.logoUrl}" class="company-logo" alt="Logo">` : ''}
        <div class="company-name">${data.billingEntity.name}</div>
        <div class="company-legal">${data.billingEntity.legalName}</div>
        <div class="company-details">
          ${data.billingEntity.address}<br>
          ${data.billingEntity.city}, ${data.billingEntity.postalCode}<br>
          ${data.billingEntity.country}<br>
          ${t.invoiceNumber}: ${data.billingEntity.taxId}${data.billingEntity.vatNumber ? ` / VAT: ${data.billingEntity.vatNumber}` : ''}<br>
          ${data.billingEntity.email} | ${data.billingEntity.phone}
        </div>
      </div>
      <div class="invoice-title">
        <h1>${t.invoice}</h1>
        <div class="invoice-meta">
          <div class="invoice-meta-row">
            <span class="invoice-meta-label">${t.invoiceNumber}:</span> ${data.invoiceNumber}
          </div>
          <div class="invoice-meta-row">
            <span class="invoice-meta-label">${t.invoiceDate}:</span> ${data.issuedAt.toLocaleDateString(template.language)}
          </div>
        </div>
      </div>
    </div>

    <div class="parties">
      <div class="party-box">
        <div class="party-label">${t.from}</div>
        <div class="party-name">${data.billingEntity.legalName}</div>
        <div class="party-details">
          Tax ID: ${data.billingEntity.taxId}<br>
          ${data.billingEntity.address}<br>
          ${data.billingEntity.city}, ${data.billingEntity.postalCode}
        </div>
      </div>
      <div class="party-box">
        <div class="party-label">${t.billedTo}</div>
        <div class="party-name">${data.customer.name}</div>
        <div class="party-details">
          ${data.customer.email}<br>
          ${data.customer.address ? `${data.customer.address}<br>` : ''}
          ${data.customer.country || ''}
        </div>
      </div>
    </div>

    <table class="items-table">
      <thead>
        <tr>
          <th style="width: 50%">${t.description}</th>
          <th class="text-right">${t.quantity}</th>
          <th class="text-right">${t.unitPrice}</th>
          <th class="text-right">${t.amount}</th>
        </tr>
      </thead>
      <tbody>
        ${data.items.map(item => `
          <tr>
            <td>${item.description}</td>
            <td class="text-right">${item.quantity}</td>
            <td class="text-right">${currencySymbol}${item.unitPrice.toFixed(2)}</td>
            <td class="text-right">${currencySymbol}${item.totalPrice.toFixed(2)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>

    <div class="totals-section">
      <div class="totals-box">
        <div class="total-row">
          <span>${t.subtotal}</span>
          <span>${currencySymbol}${data.subtotal.toFixed(2)}</span>
        </div>
        ${data.serviceFee ? `
          <div class="total-row">
            <span>${t.serviceFee}</span>
            <span>${currencySymbol}${data.serviceFee.toFixed(2)}</span>
          </div>
        ` : ''}
        <div class="total-row">
          <span>${t.tax.replace('{rate}', data.taxRate.toString())}</span>
          <span>${currencySymbol}${data.taxAmount.toFixed(2)}</span>
        </div>
        <div class="total-row final">
          <span>${t.total}</span>
          <span>${currencySymbol}${data.totalAmount.toFixed(2)} ${data.currency}</span>
        </div>
      </div>
    </div>

    ${data.notes ? `
      <div class="notes-section">
        <div class="notes-title">${t.notes}</div>
        <div class="notes-content">${data.notes}</div>
      </div>
    ` : ''}

    <div class="footer">
      <div class="thank-you">${t.thankYou}</div>
      <div>${data.billingEntity.legalName} | ${data.billingEntity.email}</div>
    </div>
  </div>
</body>
</html>`;
  }

  private getCurrencySymbol(currency: string): string {
    const symbols: Record<string, string> = {
      USD: '$',
      EUR: '€',
      GBP: '£',
      TRY: '₺',
      JPY: '¥',
    };
    return symbols[currency] || currency + ' ';
  }

  /**
   * Özet rapor HTML'i oluştur (Admin panel için)
   */
  async generateReportHtml(
    startDate: Date,
    endDate: Date,
    billingEntityId?: string,
  ): Promise<string> {
    const billingEntity = billingEntityId 
      ? await this.prisma.billingEntity.findUnique({ where: { id: billingEntityId } })
      : await this.getDefaultBillingEntity();

    const invoices = await this.prisma.invoice.findMany({
      where: {
        createdAt: { gte: startDate, lte: endDate },
        status: 'ISSUED',
      },
    });

    const totalRevenue = invoices.reduce((sum, inv) => sum + Number(inv.totalAmount), 0);

    return `
      <div style="font-family: Arial, sans-serif; padding: 20px;">
        <h2>Financial Report</h2>
        <p><strong>Company:</strong> ${billingEntity.legalName}</p>
        <p><strong>Period:</strong> ${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}</p>
        <p><strong>Total Invoices:</strong> ${invoices.length}</p>
        <p><strong>Total Revenue:</strong> $${totalRevenue.toFixed(2)}</p>
      </div>
    `;
  }
}
