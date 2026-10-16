# Router dependency probe load check

`platform-health.js` runs a bounded k6 ramp against the non-mutating
`/health/dependencies` endpoint. It is a service-capacity check, not a full
channel/user-journey acceptance test.

The script refuses hostnames containing `prod` or `production`. Local and
`.test` hosts run without extra flags. A remote target requires an explicit
`CONFIRM_NON_PRODUCTION=yes` acknowledgement and its hostname must contain
`dev`, `test`, `stage`, or `preview`; only use a deployment you control. The run
peaks at 20 virtual users and lasts 60 seconds.

```sh
TARGET_URL=http://127.0.0.1:8787 k6 run tests/load/platform-health.js
TARGET_URL=https://staging.example.test k6 run tests/load/platform-health.js
```

For a remote staging host, add `CONFIRM_NON_PRODUCTION=yes`. Do not point this
test at production or a third-party service.
