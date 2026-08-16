# Phase 7: Automatic Replica Recovery Documentation
## CloudVault Active Self-Healing, Re-Replication & Cluster Rebalancing

In Phase 7, we introduce **Automatic Replica Recovery (Re-Replication)** to CloudVault. The system transitions from a passive fault-tolerant system to an active **self-healing** distributed system. If a storage node goes offline, the Coordinator automatically detects under-replicated chunks, copies them from surviving active replicas, writes them to healthy nodes, and updates PostgreSQL metadata, restoring the system's safety margin without administrator intervention.

---

## 1. Core Architectural Explanations

### What Re-Replication Means & Why It Is Necessary
*   **Re-Replication**: The process of detecting when the active copy count of a data block falls below the configured threshold ($N$) and automatically duplicating the data from a surviving replica to a new host node.
*   **Why It Is Critical**:
    In a cluster with a replication factor $N=2$, storing a file chunk on Node A and Node B protects against a single node crash. However, if Node A crashes, only one copy remains (on Node B). The system is now in a **vulnerable state**: if Node B crashes before Node A is fixed, the data is lost permanently.
    Re-replication active healing automatically detects this state and replicates the chunk from Node B to Node C. This restores the replication factor of 2, restoring the safety margin and ensuring the system can survive another subsequent failure.

### How the System Identifies Under-Replicated Chunks
The Coordinator runs a background self-healing worker loop every 10 seconds:
1.  **Read Database Registry**: The worker calls `db.getAllChunkLocations()`, retrieving all chunk IDs and their registered node mappings.
2.  **Filter by Registry Health**: For each chunk, the worker checks the list of mapped nodes against the Coordinator's active in-memory health registry:
    ```javascript
    const onlineHosts = chunk.nodeIds.filter(nodeId => nodeRegistry[nodeId].status === 'ONLINE');
    ```
3.  **Evaluate Threshold**: If `onlineHosts.length < REPLICATION_FACTOR`, the chunk is flagged as under-replicated and queued for recovery.

### How a Recovery Target Is Selected
To maintain data isolation, the system must not place two copies of the same chunk on the same physical storage node. The selection algorithm filters destination nodes:
1.  **Online Check**: Destination must be currently `ONLINE` in the health status registry.
2.  **Deduplicate Placement**: Destination must **not** already host the chunk. The Coordinator compares candidate nodes against the chunk's registered location array:
    ```javascript
    const eligibleDestinations = STORAGE_NODES.filter(node => 
      nodeRegistry[node.id].status === 'ONLINE' && !chunk.nodeIds.includes(node.id)
    );
    ```
3.  **Assignment**: The Coordinator picks the first $K$ eligible nodes (where $K$ is the number of copies needed to restore $N=2$) as targets.

### How Metadata Is Updated
Once a chunk has been copied over HTTP from the source node to the target node:
1.  The Coordinator calls `db.addChunkLocation(chunkId, targetNodeId)`.
2.  It executes an SQL statement with an `ON CONFLICT DO NOTHING` constraint:
    ```sql
    INSERT INTO chunk_locations (chunk_id, node_id) VALUES ($1, $2)
    ON CONFLICT (chunk_id, node_id) DO NOTHING;
    ```
3.  This links the new node location to the chunk, making it discoverable for future downloads.

---

## 2. Failure Scenarios During Recovery

Self-healing systems must handle failures during the recovery process itself:

| Failure Scenario | Impact | System Response |
| :--- | :--- | :--- |
| **Source Node Fails During Read** | Chunk cannot be fetched. | The Coordinator aborts the current copy operation, logs an error, and leaves the database unchanged. The chunk remains under-replicated. It will be scanned again in the next cycle, and if another replica node is online, it will try to copy from that node instead. |
| **Destination Node Fails During Write** | Chunk copy fails. | The Coordinator catches the network error, does not write the location record to PostgreSQL, and logs a warning. The recovery worker will attempt to find a different target node in the next cycle. |
| **Coordinator Crashes Mid-Copy** | Process terminates. | Because the database record is only written *after* the chunk is successfully saved on the destination node, no partial or broken metadata pointers are committed to PostgreSQL. When the Coordinator reboots, the background scanner resumes and re-initiates the copy. |

---

## 3. Storage Analysis: Space & Bandwidth

### Bandwidth Trade-off
Active re-replication is expensive. Copying 1 TB of chunks uses substantial network bandwidth and disk I/O. If a server rack containing 10 TB of files goes offline, the network will be saturated with recovery traffic, potentially slowing down client uploads and downloads.

### Over-Replication
In this phase, we do not delete chunk copies if a failed node comes back online.
For example, if Node A goes offline, a chunk is copied to Node C. If Node A boots back up 1 minute later, the chunk now exists on A, B, and C (replication count = 3 instead of 2).
*   **Why we keep it**: Over-replication is safe. It uses slightly more disk space but ensures high availability.
*   *Future Scope*: A background garbage-collection thread can be added to identify chunks with active replication $> N$ and prune the extra copies from the least-active nodes to reclaim disk space.

---

## 4. Architectural Analysis & Future Scope

### Current Limitations
1.  **No Throttling**: The recovery loop copies under-replicated chunks as fast as possible. In production, this must be rate-limited (throttled) to prevent cluster network congestion.
2.  **No Transient Grace Period**: If a node goes down for a 10-second reboot, our system immediately starts copying chunks to other nodes. In production systems (like Ceph or HDFS), a node is given a grace period (e.g., 5 to 10 minutes) before the cluster declares it permanently dead and starts copying data, avoiding unnecessary copying.
3.  **Static Target Selection**: The system slices target selection using basic filtering. A production system balances targets based on available disk space and current node CPU load.
