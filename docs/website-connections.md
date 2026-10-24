# Website accounts for assistants

Apps → Website accounts connects a website without an API integration. A user chooses a
Space assistant workspace or one project, signs in through a private screenshot/control
panel, and closes the browser. Workers acting for that user in that exact workspace can
then discover the connection with `browser.connections` and open it with
`browser.navigate({ connection_id: "...", interactive: true })`. Optional assistant IDs
further restrict the grant. Existing tool grants, membership checks and execution ceilings
still apply; authenticated browsing requires tier 5. Accounts are not automatically shared
with other members, projects, or the Space assistant.

Passwords and verification codes entered in the panel travel directly to the browser host;
they do not become chat messages or agent tool arguments. Models receive observations and
handles, never saved cookies or storage. The host saves cookies (including HttpOnly cookies)
and local storage encrypted with AES-GCM and a key derived for the exact connection owner.
Profile state has a 64 KB plaintext cap and is erased after 30 days without a successful save.
Disconnect revokes future operations, purges saved state, and cancels the active browser.
Space/account erasure also purges the profiles before deleting their discovery metadata.

A connection has one task browser lease at a time. Browsers close after two idle minutes;
saved account state survives. Closing a tab cannot erase the last saved login. On expired
login, the assistant preserves its task in the thread, closes its browser to release the
account, and directs the user to reconnect under Apps. After verification, it opens a new
session with the same connection ID and continues the saved task. This is not a live remote
desktop takeover of the worker's existing page. The sign-in panel supports observed DOM
controls and screenshots; browser-native passkey dialogs, arbitrary canvas interactions,
OAuth popups, IndexedDB, service workers, and full browser disk profiles are not supported.
Some websites will require a fuller browser backend or their supported integration.

Only explicitly approved HTTPS origins can load. Add the site's sign-in and asset origins
when connecting it. The page cannot expand its own grants. Routine DOM changes require a
fresh observation; uncertain mutations retain the existing action reconciliation journal.
Site challenges are handed to the user through supported flows; browser identity spoofing
and automated challenge evasion are not implemented.

## Rollout

Apply migration `0129_website_connections.sql` to each environment's `PLATFORM_DB`, then
deploy browser, Spaces, agents, router and shell from the same commit. Browser requires the
new `WEBSITE_PROFILE_DO` binding and `v2-website-profiles` migration, Browser Rendering,
`BROWSER_ARTIFACTS`, `SPACES_WORKER`, and the existing platform secret. Spaces requires
`BROWSER_WORKER`. Production and staging bindings are included. Rotating the platform
secret invalidates saved profile decryption; users must reconnect.

Before enabling production usage, run an authorized live test account through: sign-in,
MFA, close/reopen, reuse from the Space assistant, reuse from a project assistant, denied
cross-project access, concurrent account access, expired login, disconnect during a task,
and user/Space erasure. Local unit tests and deployment dry runs do not establish that a
particular website supports this browser backend. No live sign-in was performed during
implementation because this execution environment had no Cloudflare credentials.
