import { Currency } from '@prisma/client';

const SUPPORTED_CURRENCIES = new Set<Currency>(['TRY', 'USD', 'EUR', 'GBP', 'AED', 'SAR']);

const COUNTRY_CURRENCY: Record<string, Currency> = {
  TR: 'TRY',
  DE: 'EUR',
  FR: 'EUR',
  NL: 'EUR',
  IT: 'EUR',
  ES: 'EUR',
  PT: 'EUR',
  FI: 'EUR',
  AT: 'EUR',
  BE: 'EUR',
  IE: 'EUR',
  HR: 'EUR',
  GR: 'EUR',
  GB: 'GBP',
  AE: 'AED',
  SA: 'SAR',
  US: 'USD',
  CA: 'USD',
  AU: 'USD',
  NZ: 'USD',
};

export function normalizeCountryCode(value?: string | null): string {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : 'TR';
}

export function normalizeCurrency(value?: string | null, countryCode?: string | null): Currency {
  const requested = String(value || '').trim().toUpperCase() as Currency;
  if (SUPPORTED_CURRENCIES.has(requested)) return requested;
  return COUNTRY_CURRENCY[normalizeCountryCode(countryCode)] || 'USD';
}

export function walletCanChangeCurrency(wallet: Record<string, unknown> | null | undefined) {
  if (!wallet) return true;
  return [
    wallet.balanceCurrent,
    wallet.balanceBonus,
    wallet.balanceWithdrawable,
    wallet.balanceCredit,
    wallet.balanceFrozen,
    wallet.balanceLottery,
    wallet.balanceCashback,
    wallet.balanceCommission,
  ].every((value) => Number(value || 0) === 0);
}
