# Browser Web Push setup

Naelao sends browser notifications through the Notifications Worker. Browser subscriptions are stored per `(tenant, user)` and the endpoint plus browser encryption keys are AES-GCM encrypted with a key derived from `PLATFORM_SECRET`. A user can register at most 20 browser endpoints per tenant. Space network-egress policy is checked for each send.

Generate one VAPID key pair for the platform with the `web-push` CLI (`npx web-push generate-vapid-keys`). Configure `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, and `WEB_PUSH_VAPID_SUBJECT` for each Notifications Worker environment. The subject must be a valid `mailto:` address or HTTPS URL. Keep the private key secret; the public key is returned to authenticated Shell clients by the Spaces route.

Apply `infra/migrations/0095_web_push_subscriptions.sql` to the platform D1 database before enabling the UI. Then deploy Notifications, Spaces, Router, and Shell. Users can enable or disable browser push on the active Space's Notifications page. A real browser/provider delivery is required to verify deployment configuration; unit tests only verify the protocol adapter, encryption, routing token, and stale-endpoint behavior with a mocked provider.
