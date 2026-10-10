import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Stable synthetic operational data. No credentials or externally sourced records.
export async function createFixtures(targetDir) {
  await mkdir(join(targetDir, 'runbooks'), { recursive: true });
  const services = {
    generatedAt: '2026-01-15T00:00:00Z',
    services: [
      { id: 'svc-checkout', name: 'Checkout API', tier: 1, region: 'us-east-1', ownerTeam: 'Commerce Platform', repo: 'commerce/checkout', status: 'healthy' },
      { id: 'svc-pricing', name: 'Pricing Engine', tier: 1, region: 'us-east-1', ownerTeam: 'Revenue Systems', repo: 'revenue/pricing', status: 'healthy' },
      { id: 'svc-inventory', name: 'Inventory Ledger', tier: 1, region: 'us-west-2', ownerTeam: 'Supply Platform', repo: 'supply/inventory', status: 'degraded' },
      { id: 'svc-notify', name: 'Notification Relay', tier: 2, region: 'us-east-1', ownerTeam: 'Messaging', repo: 'messaging/relay', status: 'healthy' },
      { id: 'svc-auth', name: 'Identity Gateway', tier: 0, region: 'global', ownerTeam: 'Identity', repo: 'identity/gateway', status: 'healthy' },
      { id: 'svc-catalog', name: 'Catalog Indexer', tier: 2, region: 'us-west-2', ownerTeam: 'Discovery', repo: 'discovery/catalog', status: 'healthy' }
    ]
  };
  await writeFile(join(targetDir, 'services.json'), JSON.stringify(services, null, 2) + '\n');

  // 300 records with deterministic values and enough realistic log detail to
  // make the corpus meaningfully larger than the other fixture files.
  const severities = ['SEV1', 'SEV2', 'SEV3', 'SEV4'];
  const states = ['open', 'mitigated', 'resolved'];
  const serviceIds = services.services.map(s => s.id);
  const incidents = Array.from({ length: 300 }, (_, i) => {
    const n = i + 1;
    const day = String(1 + (i % 14)).padStart(2, '0');
    const hour = String((i * 7) % 24).padStart(2, '0');
    const severity = severities[(i * 7 + 2) % 4];
    const state = states[(i * 5 + 1) % 3];
    const serviceId = serviceIds[(i * 11 + 3) % serviceIds.length];
    return {
      id: `INC-${String(n).padStart(4, '0')}`,
      createdAt: `2026-01-${day}T${hour}:00:00Z`, severity, state,
      serviceId,
      title: `${severity} ${serviceId} operational event ${String(n).padStart(4, '0')}`,
      errorCode: `E${String((i * 13) % 97).padStart(3, '0')}`,
      region: i % 2 ? 'us-east-1' : 'us-west-2',
      affectedCustomers: (i * 37) % 10000,
      mitigationMinutes: (i * 17) % 240,
      tags: [`shard-${i % 8}`, i % 2 ? 'automated' : 'operator'],
      // Repeated, clearly synthetic diagnostic context ensures the large file
      // is useful for retrieval/filtering without changing ground truth fields.
      diagnostic: `Synthetic diagnostic ${n}: request queue depth ${(i * 19) % 800}; retry ratio ${((i * 3) % 100) / 100}; sampled trace trace-sim-${String((i * 23) % 10000).padStart(5, '0')}. No customer data. ` +
        `Observed component ${serviceId}; deploy batch deploy-sim-${String(i % 31).padStart(2, '0')}. ` .repeat(1)
    };
  });
  await writeFile(join(targetDir, 'incidents.json'), JSON.stringify({ generatedAt: '2026-01-15T00:00:00Z', incidents }, null, 2) + '\n');
  await writeFile(join(targetDir, 'config.json'), JSON.stringify({ generatedAt: '2026-01-15T00:00:00Z', incidentWindowStart: '2026-01-08T00:00:00Z', incidentWindowEnd: '2026-01-15T00:00:00Z', defaultRegion: 'us-east-1', pagingThreshold: { SEV1: 1, SEV2: 5 } }, null, 2) + '\n');
  await writeFile(join(targetDir, 'runbooks/inventory-recovery.md'), '# Inventory Ledger recovery\n\nApplies to service svc-inventory.\n\n1. Confirm elevated E039 errors in the ledger write queue.\n2. Pause the ledger-reconciler worker in the affected region.\n3. Drain pending writes in batches of 250 and verify the checkpoint advances.\n4. Resume one worker and observe for 10 minutes before restoring full concurrency.\n5. If lag exceeds 20 minutes, page Supply Platform and keep reconciliation paused.\n\nThe verification metric is inventory_commit_lag_seconds; recovery target is below 60 seconds.\n');

  await writeFile(join(targetDir, 'runbooks/catalog-recovery.md'), '# Catalog Indexer recovery\n\nApplies to service svc-catalog.\n\n1. Pause the catalog indexing scheduler.\n2. Rebuild the failed index partition.\n3. Verify catalog_index_age_seconds is below 120.\n');

  const entities = [
    { type: 'entity', name: 'Checkout API', entityType: 'service', observations: ['Service ID: svc-checkout', 'Owner team: Commerce Platform', 'Tier: 1'] },
    { type: 'entity', name: 'Pricing Engine', entityType: 'service', observations: ['Service ID: svc-pricing', 'Owner team: Revenue Systems', 'Tier: 1'] },
    { type: 'entity', name: 'Inventory Ledger', entityType: 'service', observations: ['Service ID: svc-inventory', 'Owner team: Supply Platform', 'Tier: 1'] },
    { type: 'entity', name: 'Notification Relay', entityType: 'service', observations: ['Service ID: svc-notify', 'Owner team: Messaging', 'Tier: 2'] },
    { type: 'entity', name: 'Identity Gateway', entityType: 'service', observations: ['Service ID: svc-auth', 'Owner team: Identity', 'Tier: 0'] },
    { type: 'entity', name: 'Catalog Indexer', entityType: 'service', observations: ['Service ID: svc-catalog', 'Owner team: Discovery', 'Tier: 2'] }
  ];
  const relations = [
    { type: 'relation', from: 'Checkout API', to: 'Pricing Engine', relationType: 'calls' },
    { type: 'relation', from: 'Checkout API', to: 'Inventory Ledger', relationType: 'reads_from' },
    { type: 'relation', from: 'Checkout API', to: 'Identity Gateway', relationType: 'authenticates_with' },
    { type: 'relation', from: 'Inventory Ledger', to: 'Catalog Indexer', relationType: 'depends_on' },
    { type: 'relation', from: 'Catalog Indexer', to: 'Notification Relay', relationType: 'publishes_to' },
    { type: 'relation', from: 'Pricing Engine', to: 'Notification Relay', relationType: 'publishes_to' }
  ];
  await writeFile(join(targetDir, 'memory.jsonl'), [...entities, ...relations].map(x => JSON.stringify(x)).join('\n') + '\n');
  return { services: services.services.length, incidents: incidents.length, incidentBytes: Buffer.byteLength(JSON.stringify({ generatedAt: '2026-01-15T00:00:00Z', incidents }, null, 2) + '\n') };
}
