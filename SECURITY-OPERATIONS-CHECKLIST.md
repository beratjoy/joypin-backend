# Epin365 Production Security and Operations Checklist

This checklist tracks the production controls that should stay enabled for the e-pin platform.

## Access Control

- Admin routes must require JWT and staff/admin roles.
- Staff access must be limited by RBAC permissions, not only by role name.
- Enable `ADMIN_IP_ALLOWLIST` for `/admin` when stable office/VPN IPs are available.
- Use Cloudflare Access in front of `/admin` for an extra identity layer.
- Enable 2FA/TOTP for all admin and staff accounts before wider staff rollout.

## API and Webhooks

- Payment webhooks must verify provider signatures before touching orders.
- Webhook processing must be idempotent; duplicate success callbacks must not charge or process twice.
- Compare paid amount with order total and reject lower-than-expected amounts.
- Keep Swagger disabled in production unless `ENABLE_SWAGGER=true` is explicitly set for a maintenance window.
- Keep `CORS_ORIGIN` restricted to exact storefront/admin domains.

## Media and CDN

- Uploads are admin-only and normalized to WebP.
- Do not accept SVG uploads from the admin panel because SVG can carry scriptable content.
- Keep image size limits enabled to prevent decompression and processing abuse.
- Move persistent uploads to Cloudflare R2 and serve through `cdn.epin365.com`.
- Keep product, category, slider and blog images on CDN URLs.

## Cloudflare

- Enable WAF managed rules.
- Add rate limits for login, register, checkout, payment create and webhook endpoints.
- Use Bot Fight Mode or Turnstile on login/register if abuse starts.
- Set SSL mode to Full Strict.
- Keep HSTS enabled after certificate and domain routing are confirmed.

## Database and Backups

- Take automated daily PostgreSQL backups.
- Keep at least 7 daily and 4 weekly restore points.
- Run a restore test after every database or server migration.
- Use connection pooling when traffic grows.
- Partition or archive audit logs if the table grows beyond operational query speed.

## Monitoring

- Alert on backend 5xx spikes, payment webhook failures, high login failures and failed provider orders.
- Track checkout funnel: product view, field entry, payment selection, payment start, paid order.
- Track provider health: balance, failure rate, average delivery time and reject reason.
- Alert when stock or provider balance falls below thresholds.

## Customer Experience

- Keep partial delivery visible to customers.
- Send mail notifications for order created, paid, processing, partial delivery, delivered, cancelled and refunded.
- Use abandoned checkout mails only for opted-in or logged-in customers.
- Keep fraud document generation available from admin order detail.

