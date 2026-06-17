# Naelao — Complete Project File Tree

Generate files **in numbered order**. Each prompt is self-contained.
Files in lower-numbered prompts are referenced (as inline types) by higher-numbered ones.

```
naelao/                                      ← monorepo root
│
├── package.json                             ← prompt 01
├── tsconfig.json                            ← prompt 01
│
├── packages/
│   ├── types/src/
│   │   └── index.ts                         ← prompt 02  (all shared TS types)
│   ├── analytics-schema/src/
│   │   └── index.ts                         ← prompt 03  (AE positional schema)
│   └── billing-providers/src/
│       ├── types.ts                         ← prompt 04a
│       ├── lemon-squeezy.ts                 ← prompt 04b
│       ├── stripe.ts                        ← prompt 04c (stub → real later)
│       └── index.ts                         ← prompt 04d
│
└── workers/
    ├── naelao-auth/
    │   ├── wrangler.jsonc                   ← prompt 38
    │   └── src/
    │       ├── index.ts                     ← prompt 05a
    │       ├── jwt.ts                       ← prompt 05b
    │       └── middleware.ts                ← prompt 05c
    │
    ├── naelao-credentials/
    │   ├── wrangler.jsonc                   ← prompt 38
    │   └── src/
    │       ├── index.ts                     ← prompt 06a
    │       └── encrypt.ts                   ← prompt 06b
    │
    ├── naelao-spaces/
    │   ├── wrangler.jsonc                   ← prompt 38
    │   └── src/
    │       ├── index.ts                     ← prompt 07a
    │       ├── SpaceDO.ts                   ← prompt 07b  ★ CRITICAL
    │       ├── schema.ts                    ← prompt 07c
    │       ├── WalletDO.ts                  ← prompt 08
    │       ├── ConcurrencyDO.ts             ← prompt 09
    │       └── BuilderAccountDO.ts          ← prompt 10
    │
    ├── naelao-threads/
    │   ├── wrangler.jsonc                   ← prompt 38
    │   └── src/
    │       ├── index.ts                     ← prompt 11a
    │       └── ThreadsDO.ts                 ← prompt 11b
    │
    ├── naelao-knowledge/
    │   ├── wrangler.jsonc                   ← prompt 38
    │   └── src/
    │       ├── index.ts                     ← prompt 12a
    │       ├── chunker.ts                   ← prompt 12b
    │       └── embedder.ts                  ← prompt 12c
    │
    ├── naelao-agents/
    │   ├── wrangler.jsonc                   ← prompt 38
    │   └── src/
    │       ├── index.ts                     ← prompt 13a  (HTTP handler)
    │       ├── NaelaoAgentDO.ts             ← prompt 13b  ★ LARGEST FILE
    │       ├── fiber.ts                     ← prompt 13c
    │       ├── wal.ts                       ← prompt 13d
    │       ├── context-manager.ts           ← prompt 13e
    │       ├── tool-executor.ts             ← prompt 13f
    │       ├── remote-loop.ts               ← prompt 13g
    │       ├── websocket.ts                 ← prompt 13h
    │       └── LocalTunnelDO.ts             ← prompt 13i
    │
    ├── naelao-mcp-hub/
    │   ├── wrangler.jsonc                   ← prompt 38
    │   └── src/
    │       ├── index.ts                     ← prompt 14a
    │       └── route-resolver.ts            ← prompt 14b
    │
    ├── naelao-billing/
    │   ├── wrangler.jsonc                   ← prompt 38
    │   └── src/
    │       ├── index.ts                     ← prompt 15a
    │       └── credits.ts                   ← prompt 15b
    │
    ├── naelao-registry/
    │   ├── wrangler.jsonc                   ← prompt 38
    │   └── src/
    │       ├── index.ts                     ← prompt 16a
    │       ├── SpaceTypeRegistryDO.ts       ← prompt 16b
    │       ├── AppRegistryDO.ts             ← prompt 16c
    │       └── WorkflowRegistryDO.ts        ← prompt 16d
    │
    ├── naelao-sweeper/
    │   ├── wrangler.jsonc                   ← prompt 38
    │   └── src/index.ts                     ← prompt 17
    │
    ├── naelao-notifications/
    │   ├── wrangler.jsonc                   ← prompt 38
    │   └── src/index.ts                     ← prompt 18
    │
    ├── naelao-analytics/
    │   ├── wrangler.jsonc                   ← prompt 38
    │   └── src/index.ts                     ← prompt 19
    │
    ├── naelao-triggers/
    │   ├── wrangler.jsonc                   ← prompt 38
    │   └── src/
    │       ├── index.ts                     ← prompt 20a
    │       └── verify-signature.ts          ← prompt 20b
    │
    ├── naelao-workflows/
    │   ├── wrangler.jsonc                   ← prompt 38
    │   └── src/index.ts                     ← prompt 21
    │
    ├── naelao-provisioner/
    │   ├── wrangler.jsonc                   ← prompt 38
    │   └── src/
    │       ├── provision.ts                 ← prompt 22a
    │       └── deprovision.ts               ← prompt 22b
    │
    ├── naelao-together-ai/
    │   ├── wrangler.jsonc                   ← prompt 38
    │   └── src/
    │       ├── index.ts                     ← prompt 23a
    │       └── research.ts                  ← prompt 23b
    │
    ├── naelao-admin/
    │   ├── wrangler.jsonc                   ← prompt 38
    │   └── src/index.ts                     ← prompt 24
    │
    ├── naelao-eval/
    │   ├── wrangler.jsonc                   ← prompt 38
    │   └── src/index.ts                     ← prompt 25
    │
    ├── naelao-portal-router/
    │   ├── wrangler.jsonc                   ← prompt 38
    │   └── src/index.ts                     ← prompt 26
    │
    ├── naelao-artifact/
    │   ├── wrangler.jsonc                   ← prompt 38
    │   └── src/
    │       ├── index.ts                     ← prompt 27a
    │       └── sandbox.ts                   ← prompt 27b
    │
    └── naelao-router/                       ★ DEPLOY LAST
        ├── wrangler.jsonc                   ← prompt 38
        └── src/
            ├── index.ts                     ← prompt 28a
            └── middleware/
                ├── auth.ts                  ← prompt 28b
                ├── cors.ts                  ← prompt 28c
                └── rate-limit.ts            ← prompt 28d
```

## Deployment Order

Deploy workers in this exact order (Service Bindings require targets to exist first):

1. `naelao-spaces` (contains SpaceDO, WalletDO, ConcurrencyDO, BuilderAccountDO)
2. `naelao-auth`
3. `naelao-credentials`
4. `naelao-threads`
5. `naelao-knowledge`
6. `naelao-billing`
7. `naelao-analytics`
8. `naelao-notifications`
9. `naelao-registry`
10. `naelao-agents`
11. `naelao-mcp-hub`
12. `naelao-triggers`
13. `naelao-workflows`
14. `naelao-sweeper`
15. `naelao-provisioner`
16. `naelao-together-ai`
17. `naelao-admin`
18. `naelao-eval`
19. `naelao-portal-router`
20. `naelao-artifact`
21. `naelao-router` ← LAST (depends on all others)
