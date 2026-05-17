INSERT INTO "payment_methods" (
  "id",
  "name",
  "code",
  "description",
  "gatewayConfig",
  "minAmount",
  "maxAmount",
  "feePercent",
  "fixedFee",
  "sortOrder",
  "isActive",
  "updatedAt"
) VALUES (
  'default-bank-transfer',
  'Banka Havalesi / EFT',
  'BANK_TRANSFER',
  'TR/TRY icin manuel banka transferi',
  '{"allowedCountries":["TR"],"allowedCurrencies":["TRY"],"manual":true}'::jsonb,
  0,
  0,
  0,
  0,
  10,
  true,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("code") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = COALESCE("payment_methods"."description", EXCLUDED."description"),
  "gatewayConfig" = CASE
    WHEN "payment_methods"."gatewayConfig" IS NULL OR "payment_methods"."gatewayConfig" = '{}'::jsonb
    THEN EXCLUDED."gatewayConfig"
    ELSE "payment_methods"."gatewayConfig"
  END,
  "isActive" = true,
  "updatedAt" = CURRENT_TIMESTAMP;
