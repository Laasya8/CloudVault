# Phase 5: Multi-Node Distributed Architecture Documentation
## CloudVault Multi-Node Node Orchestration & Gateway Routing

In Phase 5, we transition CloudVault from a single monolithic file server into a true **Multi-Node Distributed Storage System**. We split the system into a **Backend Coordinator** (which manages metadata queries and chunk mapping) and **three isolated Storage Nodes** (`node-a`, `node-b`, `node-c`) executing as independent Docker containers.

---

## 1. Core Architectural Explanations

### What a Node Means
In distributed systems, a **Node** is a single, self-contained unit of computation and storage connected to a network. It runs its own operating system process, has its own isolated memory, and manages its own storage interface. 
In CloudVault Phase 5, we have two types of nodes:
1.  **Coordinator Node (Backend)**: The "brain" or gateway. It handles user traffic, processes file slicing, queries PostgreSQL, decides which storage nodes receive which chunks, and acts as the API Gateway.
2.  **Storage Node (Worker)**: The "muscle." These nodes (`node-a`, `node-b`, `node-c`) are lightweight HTTP servers that simply receive raw chunks, write them to disk, and stream them back on request. They do not know about the database or other nodes.

### Why Each Node Is Isolated
In cloud architecture, **Failure Isolation** is a fundamental design goal.
If a single physical hard drive or machine crashes, it should not bring down the entire storage network. By running each storage node in its own container, we achieve virtual isolation:
*   If `node-a` crashes or runs out of memory, `node-b` and `node-c` continue to operate normally.
*   This structure prepares us for future phases where we can replicate chunks across different nodes so that data remains accessible even if one node goes offline.

### How Docker Compose Creates the Nodes
Docker Compose acts as our local container orchestrator:
1.  **Instruction Reading**: It parses the master [`docker-compose.yml`](file:///f:/data/Laasya/Antigravity-projects/CloudVault/docker-compose.yml) in the project root.
2.  **Image Compilation**: It builds two separate container images:
    *   A coordinator image using the code in [`backend/`](file:///f:/data/Laasya/Antigravity-projects/CloudVault/backend).
    *   A worker node image using the code in [`storage-node/`](file:///f:/data/Laasya/Antigravity-projects/CloudVault/storage-node).
3.  **Instantiation**: It starts one coordinator container (`cloudvault-coordinator`), one PostgreSQL container (`cloudvault-db`), and three storage worker containers (`cloudvault-node-a`, `cloudvault-node-b`, `cloudvault-node-c`).

### How Containers Communicate
When Docker Compose launches, it automatically sets up a **virtual private bridge network** (e.g., `cloudvault_default`). 
*   **Internal DNS**: Docker runs an embedded DNS server. Every container service is automatically given a domain name matching its service name in the docker-compose file (`db`, `node-a`, `node-b`, `node-c`).
*   **Networking**: The coordinator container can connect directly to `http://node-a:5001` or `postgres://db:5432` over this virtual network. These ports do not need to be exposed to the public internet; they communicate securely within Docker's isolated network namespace.

### Why Persistent Volumes Are Necessary
Containers are **ephemeral** by design. If a container is stopped and deleted (e.g., during code updates or system restarts), all files written inside its virtual filesystem are lost.
To prevent data loss, we configure **Docker Volumes** (`node-a-data`, `node-b-data`, `node-c-data`). Volumes mount a directory from the host machine into the container's `/app/data` path. This ensures that even if a storage node container is destroyed and recreated, the uploaded file chunks remain safe on the host disk.

### How the Backend Discovers Nodes
The coordinator discovers the cluster layout using **Configuration Injection**:
1.  **Environment Variables**: The list of available nodes is passed into the coordinator using the `STORAGE_NODES` environment variable inside `docker-compose.yml`:
    `STORAGE_NODES=node-a=http://node-a:5001,node-b=http://node-b:5002,node-c=http://node-c:5003`
2.  **Boot Registry Ping**: On startup, the coordinator parses this string, registers the URLs, and fires an initial HTTP GET request to each storage node's `/health` endpoint to log their online status.
3.  **Active Query API**: The coordinator exposes a `/api/nodes` route where clients can view a real-time health dashboard of all registered nodes (online/offline status, latency, chunk count).

---

## 2. Comparison with Single-Node Architecture

In previous phases, the storage node was a monolithic coordinator and storage medium:
```
[Client] ──> [Monolithic Storage Node] ──> [PostgreSQL + Local File Storage]
```

In Phase 5, the architecture is fully decoupled:
```
                  ┌──────────────────────┐
                  │      PostgreSQL      │
                  └──────────▲───────────┘
                             │ (SQL metadata queries)
[Client] ──HTTP──> [Backend Coordinator]
                             │ (Chunk routing HTTP streams)
            ┌────────────────┼────────────────┐
            ▼                ▼                ▼
       [Node A]         [Node B]         [Node C]
     (Port 5001)      (Port 5002)      (Port 5003)
     [Volume A]       [Volume B]       [Volume C]
```

*   **Dumb Workers**: Storage nodes no longer talk to PostgreSQL. They are completely stateless regarding file databases; they only know how to save and serve local files by ID.
*   **Decoupled Metadata**: The Coordinator holds the PostgreSQL database mapping. Chunks are distributed to nodes using a simple **Round-Robin** strategy (Chunk 0 -> Node A, Chunk 1 -> Node B, Chunk 2 -> Node C...). The Database tracks which node holds which chunk using the `node_id` column.

---

## 3. Resemblance to Distributed Cloud Storage

This model mirrors the design of standard industrial distributed filesystems, such as the **Google File System (GFS)** and the **Hadoop Distributed File System (HDFS)**:
*   **Master Node / NameNode**: In HDFS/GFS, a master node manages the file namespace, directory tree, database mappings, and routes clients to chunkservers. In CloudVault, this is the **Backend Coordinator**.
*   **ChunkServers / DataNodes**: In HDFS/GFS, worker machines store raw chunks on their local drives and report their state. In CloudVault, these are our **Storage Nodes**.
*   **Client Communication**: Clients read/write metadata from the Coordinator, but data chunks stream directly between the coordinator and the storage workers, preventing the coordinator database from becoming a bottleneck.

---

## 4. Physical Limitations of Local Simulation

While Docker Compose simulates a distributed network, it has several limitations compared to a true physical deployment:

1.  **Single Point of Failure (Host)**: All containers share the same physical CPU, RAM, and hard drive. If the host computer crashes, loses power, or experiences disk failure, the entire "distributed" system dies instantly.
2.  **Resource Contention**: The containers compete with each other for CPU cycles and disk I/O. Under heavy loads, writing chunks concurrently to A, B, and C can bottleneck the host hard drive.
3.  **Simulated Networking (0ms Latency)**: Communication between containers uses internal memory bridges, resulting in near-instantaneous transfers (0-1ms latency). In a true distributed system, nodes are scattered across different geographical regions (data centers), where network latency, packet loss, and WAN limits introduce major synchronization and timeout challenges.
4.  **No Physical Partitions**: We cannot test real network partition scenarios (the "CAP theorem" partitions) where half of the storage nodes become unreachable from the other half while both sets remain running.
