ALTER TABLE "sub_orders" ADD COLUMN IF NOT EXISTS "subOrderNumber" VARCHAR(40);

WITH numbered AS (
  SELECT
    so.id,
    o."orderNumber" || '-' || LPAD(
      ROW_NUMBER() OVER (
        PARTITION BY so."parentOrderId"
        ORDER BY so."createdAt" ASC, so.id ASC
      )::text,
      2,
      '0'
    ) AS next_number
  FROM "sub_orders" so
  JOIN "orders" o ON o.id = so."parentOrderId"
  WHERE so."subOrderNumber" IS NULL
)
UPDATE "sub_orders" so
SET "subOrderNumber" = numbered.next_number
FROM numbered
WHERE so.id = numbered.id;

CREATE UNIQUE INDEX IF NOT EXISTS "sub_orders_subOrderNumber_key" ON "sub_orders"("subOrderNumber");
