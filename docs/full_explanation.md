# CloudVault: Distributed Self-Healing Storage Explained

Welcome to **CloudVault**! If you are looking at this project for the first time, this guide will help you understand what CloudVault is, the core distributed system problems it solves, how it is designed, and how its components work together.

---

## 1. What is CloudVault?

CloudVault is a simplified, educational **distributed cloud storage system** (similar to a mini Google Drive or Dropbox). 

Instead of saving your files on a single computer's hard drive, CloudVault splits files into smaller pieces (chunks), copies them for safety (replication), and spreads them across multiple independent storage servers (nodes) over a network. 

If one of those storage servers crashes or loses power, CloudVault automatically detects the failure and retrieves your file from another server holding a backup copy, ensuring **high availability** and **data durability**.

---

## 2. Core Concepts Explained Simply

CloudVault demonstrates five fundamental concepts of modern distributed systems:

```
[ Your File: 2.5 MB ]
       │
       ▼ (1. File Chunking)
 ┌───────────┬───────────┬───────────┐
 │  Chunk 1  │  Chunk 2  │  Chunk 3  │   <-- 1 MB Max Chunk Size
 │   (1 MB)  │   (1 MB)  │  (0.5 MB) │
 └─────┬─────┴─────┬─────┴─────┬─────┘
       │           │           │
       ▼           ▼           ▼ (2. Deduplication check: Hashes SHA-256)
   [Unique?]   [Unique?]   [Unique?]
       │           │           │
       ▼           ▼           ▼ (3. N-Way Replication: N = 2)
  Store 2x on: Store 2x on: Store 2x on:
   Node A & B   Node B & C   Node A & C
```

### 1. File Chunking (Slicing)
When you upload a file, CloudVault does not store it as one giant file. Instead, it slices the file into smaller blocks called **chunks** (capped at a maximum size of 1 MB). 
*   *Why?* Slicing files allows pieces of a single file to be stored on different servers, balance storage space across the cluster, and stream parts of the file in parallel for faster transfers.

### 2. Content-Based Deduplication (Space Saving)
Before saving a chunk to disk, the system calculates a cryptographic fingerprint of its content using the **SHA-256 hash algorithm**. If a chunk with the exact same fingerprint already exists in the system (e.g., if you upload the same file twice, or if different files share identical data blocks), CloudVault **does not write another copy to the disk**. Instead, it maps both files to the existing chunk.
*   *Why?* It saves significant hard drive space, reduces network congestion, and cuts hardware costs.

### 3. N-Way Replication (Data Redundancy)
To prevent data loss, every unique chunk is duplicated and stored on **$N$ distinct storage nodes** (by default, $N=2$). 
*   *Why?* If $N=2$, a chunk can survive the crash of any single storage server without causing file corruption or data loss.

### 4. Fault Tolerance & Dynamic Failover (Auto-Routing)
The main controller pings the storage nodes every 5 seconds to track their health. If a node goes offline, it is marked as `OFFLINE`. When you download a file, if the coordinator goes to fetch a chunk from a node that is offline, it **dynamically skips it** and pulls the backup copy from the second replica node.
*   *Why?* It guarantees that files remain downloadable even when parts of the infrastructure fail.

### 5. Self-Healing & Automatic Recovery (Background Restoration)
If a storage node crashes permanently, the replica count of the chunks it was hosting drops from 2 to 1. A background worker periodically scans the database, detects these under-replicated chunks, copies them from the surviving replica, and stores them on a healthy, online node to restore the replication factor of 2.
*   *Why?* It automates cluster maintenance and keeps the data safe without human intervention.

---

## 3. The Component Architecture

CloudVault is structured as a cluster of 5 Docker containers running on a virtual private network:

```
                  ┌───────────────────────┐
                  │  Web Browser Client   │
                  └───────────┬───────────┘
                              │ HTTP (Port 3000)
                              ▼
┌───────────────────────────────────────────────────────────┐
│                    COORDINATOR GATEWAY                    │
│      [backend/server.js] (Express API & Static Host)      │
│                                                           │
│  - Serves visual HTML Dashboard                           │
│  - Handles file chunking & deduplication logic            │
│  - Orchestrates background health checking & recovery    │
└──────────────┬──────────────┬──────────────┬──────────────┘
               │              │              │
    PostgreSQL │ (5432)       │              │ HTTP REST API (Ports 5001-5003)
               ▼              ▼              ▼
 ┌───────────────────┐  ┌──────────┐   ┌──────────┐   ┌──────────┐
 │ METADATA DATABASE │  │  NODE A  │   │  NODE B  │   │  NODE C  │
 │  [postgres:15]    │  │ (Port    │   │ (Port    │   │ (Port    │
 │                   │  │  5001)   │   │  5002)   │   │  5003)   │
 └───────────────────┘  └──────────┘   └──────────┘   └──────────┘
                         [storage-node/server.js] (Worker Nodes)
```

1.  **Frontend Dashboard ([frontend/](file:///f:/data/Laasya/Antigravity-projects/CloudVault/frontend/)):**
    A Single-Page App (SPA) built with modern CSS glassmorphism. It allows users to drag-and-drop file uploads, monitor storage capacity, view file chunk mappings, trigger simulated node crashes, and inspect raw JSON manifests.
2.  **Coordinator Gateway ([backend/](file:///f:/data/Laasya/Antigravity-projects/CloudVault/backend/)):**
    The "brain" of the system. It handles file slice processing, checks database metadata, sends chunks to workers, streams reconstructed files back on download, and runs the background health checking and self-healing loop.
3.  **Metadata Database (`cloudvault-db`):**
    A PostgreSQL database that keeps track of the file catalog, chunk hashes, and the node registry showing where replicas are stored.
4.  **Storage Nodes A, B, & C ([storage-node/](file:///f:/data/Laasya/Antigravity-projects/CloudVault/storage-node/)):**
    Worker servers listening on ports 5001, 5002, and 5003. They are dead-simple storage systems: they receive raw binary chunks, write them to disk inside Docker volumes, stream them back when requested, and delete them on command.

---

## 4. Step-by-Step Workflows

### How File Upload Works
1.  You drop a file `notes.txt` (1.5 MB) on the dashboard.
2.  The browser sends the file to the Coordinator (`POST /api/upload`).
3.  The Coordinator slices the file into:
    *   **Chunk 1** (1.0 MB, Hash: `abc123...`)
    *   **Chunk 2** (0.5 MB, Hash: `xyz789...`)
4.  For **Chunk 1**:
    *   Coordinator asks PostgreSQL: *Does hash `abc123...` exist?*
    *   **If Yes**: Reuse it! Skip sending bytes.
    *   **If No**: Pick 2 healthy nodes (e.g., Node A and B) and send the chunk data to them via HTTP (`POST /chunks/chunk-id`).
5.  For **Chunk 2**: Repeat the same check.
6.  Once all chunks are stored, the Coordinator writes the file metadata and mapping records into PostgreSQL and returns a success response to the dashboard.

### How File Download Works
1.  You click **Download** on the dashboard.
2.  The browser requests the file from the Coordinator (`GET /api/download/file-id`).
3.  The Coordinator queries PostgreSQL: *Get all chunks for this file and their locations.*
4.  For each chunk:
    *   Coordinator checks the health registry for the mapped nodes.
    *   If **Node A** is `ONLINE`, Coordinator fetches the chunk bytes from it.
    *   If **Node A** is `OFFLINE`, Coordinator logs a failover warning and fetches from **Node B** (the replica) instead.
5.  The Coordinator streams the chunk bytes to the client in order, assembling the file on-the-fly.

---

## 5. How to Run and Explore the Project

1.  Make sure **Docker Desktop** is running on your machine.
2.  Open your terminal in the root directory of the project and start the cluster:
    ```bash
    docker compose up -d
    ```
3.  Open your web browser and go to:
    👉 **[http://localhost:3000/](http://localhost:3000/)**
4.  **Explore the Dashboard**:
    *   Upload a file and check the chunk badges.
    *   Click the **Inspect JSON** `{}` button to view the file's raw manifest.
    *   Simulate a node crash, download your file, and check how the system performs dynamic failover under the hood.
