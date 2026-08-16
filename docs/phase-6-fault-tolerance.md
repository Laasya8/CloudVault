# Phase 6: Replication and Fault Tolerance Documentation
## CloudVault Redundancy, Health Monitoring & Dynamic Failover

In Phase 6, we introduce **Configurable N-Way Replication** (default replication factor $N=2$) and **Dynamic Failover Recovery** to CloudVault. The system is now capable of distributing duplicate chunk copies across independent storage workers, monitoring node health, and redirecting download streams to active replicas if a storage worker crashes.

---

## 1. Key Fault Tolerance Terminology

### Replication & Replication Factor
*   **Replication**: The practice of storing copies of the same data chunk on multiple independent storage servers (nodes) over a network.
*   **Replication Factor ($N$)**: The total number of copies of each chunk stored across the cluster. If $N=2$ (the default), every chunk has one primary copy and one duplicate replica.

### Why Replication Improves Availability
Availability is the measure of a system's uptime and its ability to serve files on request.
If we store a file on a single storage node, and that node has a **5% probability of crashing** at any given moment, our file has a **5% probability of being unavailable** (95% availability).

If we replicate the chunk to 2 independent nodes (assuming their failures are independent):
*   Both nodes must crash at the same time for our data to be unavailable.
*   The probability of simultaneous failure is $5\% \times 5\% = 0.25\%$.
*   Our availability increases from **95%** to **99.75%**! Adding a third node ($N=3$) reduces failure probability to $0.0125\%$ (99.9875% availability).

### Failure Scenarios (Transient vs. Permanent)
*   **Transient Failure**: A temporary outage where a storage server becomes unreachable due to network congestion, a system reboot, or container restart. The server comes back online later with all its stored file chunks intact.
*   **Permanent Failure**: A destructive crash where a storage node's disk fails, its virtual volume is deleted, or the physical computer breaks. The data chunks stored on that machine are permanently lost.

---

## 2. System Mechanics

### Health Checks & Status Registry
The Coordinator gateway maintains a background health worker thread that pings each storage worker:
1.  **Periodic Polling**: Every 5 seconds, the Coordinator sends an HTTP GET request to each storage node's `/health` endpoint.
2.  **State Tracking**: Based on the response, the node's state is updated in an in-memory health registry to `ONLINE`, `UNHEALTHY` (returns an HTTP error code), or `OFFLINE` (request timeouts or network unreachable).
3.  **Simulated Failures**: To facilitate demonstrations, the Coordinator exposes endpoints `/api/nodes/:id/simulate-failure` and `/api/nodes/:id/recover`. Activating simulated failure forces the node status to `OFFLINE` in the registry, allowing users to test failover behavior without shutting down Docker containers.

### How the System Chooses a Replica (Failover)
When a user requests a file download (`GET /api/download/:id`):
1.  The Coordinator queries PostgreSQL to retrieve the file metadata and the list of ordered chunk IDs, along with the array of host node IDs mapped to each chunk.
2.  For each chunk, the Coordinator loops through its registered node IDs.
3.  It checks the health registry for each node in sequence:
    *   **If the node is ONLINE**: The Coordinator opens a connection, fetches the chunk bytes, and pipes them to the client.
    *   **If the node is OFFLINE / SIMULATED FAILED**: The Coordinator skips it, logs a warning, and attempts to fetch from the next replica node in the array.
4.  If all replica nodes for a given chunk are offline, the Coordinator aborts the connection and returns a 500 error.

### Replication vs. Deduplication
Replication and Deduplication might seem contradictory because one increases redundancy while the other decreases it. However, they work in tandem in CloudVault:

*   **Deduplication** (Space Optimization): Slices the incoming file and evaluates unique chunks. If a chunk already exists in the system, we do not store another copy, saving space.
*   **Replication** (Data Safety): Once a chunk is determined to be *unique*, we duplicate it $N$ times across different nodes.
*   *Coexistence*: We only replicate **unique** chunks. If a duplicate chunk is uploaded, we map the file to the existing chunk and reuse its existing replicas, avoiding any redundant file writes while maintaining the safety of both files.

---

## 3. Upload, Failure & Read Workflow

The diagram below outlines the sequence of events during a file upload, node failure simulation, and subsequent successful read:

```
[Client]             [Coordinator Gateway]             [Node A]         [Node B]          [PostgreSQL]
   │                           │                           │                │                  │
   ├─────── 1. UPLOAD ────────>│                           │                │                  │
   │   POST /api/upload        ├────────── 2. Slice & Hash ────────────────────────────────────┤
   │                           │                           │                │                  │
   │                           ├─────── 3. Write Replica 1 ───────> [Store] │                  │
   │                           │   POST /chunks/chunk-123  │                │                  │
   │                           │                           │                │                  │
   │                           ├────────────────────── 4. Write Replica 2 ────────> [Store]  │
   │                           │                       POST /chunks/chunk-123                  │
   │                           │                                            │                  │
   │                           ├──────────────── 5. Record Location Mapping ──────────────────>│
   │                           │                  File & Chunk 123 -> Node A & B               │
   │                           │                                                               │
   │   <─── 201 Created ───────┤                                                               │
   │                           │                                                               │
   │                           │                                                               │
   │                     [Node A Fails]                                                        │
   │                 (Simulate-Failure API)                                                    │
   │                           │                                                               │
   │                           ✕ (Pings Fail - Registry marks Node A as OFFLINE)               │
   │                           │                                                               │
   │                           │                                                               │
   ├───── 6. DOWNLOAD ────────>│                                                               │
   │   GET /api/download/:id   ├─────────────── 7. Query Location Map ────────────────────────>│
   │                           │                 Returns: Chunk 123 is on Node A & B           │
   │                           │                                                               │
   │                           ├─ 8. Check health registry ───┐                                │
   │                           │  Sees Node A is OFFLINE      │                                │
   │                           │  Sees Node B is ONLINE <─────┘                                │
   │                           │                                                               │
   │                           ├────────────── 9. Read surviving replica ─────────> [Read]      │
   │                           │           GET /chunks/chunk-123            │                  │
   │                           │                                            │                  │
   │                           │<───────────── 10. Return chunk bytes ──────┴──────────────────┤
   │                           │                                                               │
   │   <─── Stream file ───────┤                                                               │
```

---

## 4. Current Limitations & Future Scope

### Why Automatic Re-Replication is Not Yet Implemented
If a node goes offline, the replication factor of its chunks drops from 2 to 1. In a production system, a background self-healing worker would immediately copy those chunks to other active nodes to restore the replication factor of 2.
We have omitted this in Phase 6 due to two major challenges:
1.  **Transient Outage Storms**: If a storage node temporarily reboots for 30 seconds, immediately copying gigabytes of data to other nodes creates a massive, unnecessary network storm. Production systems require complex consensus and backoff grace periods.
2.  **Rebalancing Overhead**: If a node is permanently dead, copying data requires coordinating space balances across surviving nodes. This will be implemented under the Phase 7 Self-Healing roadmap.
