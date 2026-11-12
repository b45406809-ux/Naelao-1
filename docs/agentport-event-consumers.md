# AgentPort event consumer loop

`AgentPortClient.consumePendingEvents` provides a bounded, sequential poll/claim/dispatch/ack loop for an external consumer. It claims each delivery with a lease, calls the consumer handler with metadata-only event references, and acknowledges `delivered` only after the handler resolves. A handler may return `retry` or `dead_letter`; a thrown error requests retry. A batch is limited to 25 events.

The handler must durably accept work before returning. It should use `delivery_id` as an idempotency key because delivery is at least once: if durable acceptance succeeds but the acknowledgement is lost, AgentPort may deliver the event again. A `dead_letter` return should be used only after the consumer has durably stored its failure record.

AgentPort events contain provider references, not message bodies. The consumer must fetch provider data through its own authenticated adapter and respect current account grants. A `sessionBinding` is returned only for the subscription's matching consumer group; the consumer must route it only to that external session and preserve its own session authorization and durability rules.

```ts
const result = await client.consumePendingEvents({
  agentId,
  consumerId: "support-worker",
  limit: 10,
  ttlSeconds: 90,
  handle: async (event) => {
    // Fetch event.dataRef using the consumer's provider adapter, then atomically
    // enqueue/dedupe by event.delivery_id in its own durable session store.
    await sessionStore.acceptProviderEvent({
      deliveryId: event.delivery_id,
      accountId: event.account_id,
      serviceId: event.service_id,
      type: event.event_type,
      threadRef: event.thread_ref,
      dataRef: event.dataRef,
      sessionBinding: event.sessionBinding,
    });
  },
});
```

The SDK helper serializes one batch. Consumers that require strict ordering across workers must also partition by provider thread/session and coordinate those workers in their durable store. A notification webhook is only a wake signal; event claim and acknowledgement remain authoritative.
