# CloudVault: Distributed Self-Healing Cloud Storage

CloudVault is an educational distributed cloud storage system designed to demonstrate core concepts of cloud computing, such as file chunking, content-based deduplication, N-way replication, fault tolerance, and automatic self-healing recovery.

This repository is structured to evolve phase by phase, allowing students and developers to build, test, and understand each component incrementally.

---

## Project Structure

```
CloudVault/
├── docs/
│   └── phase-0-architecture.md   # Architectural design and core concepts
├── frontend/                     # Frontend dashboard (Vanilla HTML/CSS/JS)
├── backend/                      # Coordinator node (Express backend API + SQLite)
└── storage-node/                 # Storage node server (Express file receiver)
```

For a deep dive into the system design, read the [Phase- 0 Architecture Guide](file:///f:/data/Laasya/Antigravity-projects/CloudVault/docs/phase-0-architecture.md).

---

## Phase-by-Phase Roadmap

### 🏁 Phase 0: Architectural Design & Planning (Complete)
*   **Goal**: Lay out the concepts, component boundaries, communication APIs, workflows, and local testing configurations.
*   **Deliverables**: 
    *   Initial directory layout.
    *   Comprehensive [architecture documentation](file:///f:/data/Laasya/Antigravity-projects/CloudVault/docs/phase-0-architecture.md).
    *   This roadmap.

### 📦 Phase 1: Single Storage Node Core API (Complete)
*   **Goal**: Build a standalone storage node that can read, write, and delete raw data payloads.
*   - **Documentation**: Detailed guide in [Phase 1 Storage Node Documentation](file:///f:/data/Laasya/Antigravity-projects/CloudVault/docs/phase-1-storage-node.md).
*   - **Key Features**: HTTP REST API for file upload, download, and delete; Docker isolation; volume mount mapping.
*   - **Status**: Complete. See instructions below on how to run and test it.

---

## Running and Testing Phase 1

### Prerequisites
Make sure you have [Docker](https://www.docker.com/) installed on your machine.

### 1. Build and Run via Docker Compose
From the project root directory, navigate to the `storage-node` folder and start the service:
```bash
cd storage-node
docker compose up --build -d
```
This builds the Node Alpine container image, binds port `5001` on your machine, mounts the local `./data` folder to persist file uploads, and runs the service in the background.

Alternatively, check the health of the container by visiting:
[http://localhost:5001/health](http://localhost:5001/health)

### 2. Test Using Curl

*   **Upload a file**:
    ```bash
    # Create a dummy test file
    echo "Hello, CloudVault!" > test.txt
    
    # Upload the file
    curl -X POST -F "file=@test.txt" http://localhost:5001/files
    ```
    *Response format:*
    ```json
    {
      "id": "76ec49b3-469b-430c-ab23-f2277dcf8a8c",
      "filename": "test.txt",
      "mimeType": "text/plain",
      "size": 19,
      "uploadedAt": "2026-08-08T19:37:00.123Z"
    }
    ```

*   **Download the file**:
    Substitute `<FILE_ID>` with the `id` returned from the upload response:
    ```bash
    curl -o downloaded_test.txt http://localhost:5001/files/<FILE_ID>
    
    # Check the downloaded file content
    cat downloaded_test.txt
    ```

*   **Delete the file**:
    ```bash
    curl -X DELETE http://localhost:5001/files/<FILE_ID>
    ```

---

## Running and Testing Phase 2 (File Chunking)

Phase 2 adds file chunking directly inside the storage node. Chunks are stored as `chunk_[chunkId].bin` and mapped using a `[fileId].meta.json` manifest.

### 1. Configure a Small Chunk Size
To easily test chunking with a small file:
- Open [`storage-node/docker-compose.yml`](file:///f:/data/Laasya/Antigravity-projects/CloudVault/storage-node/docker-compose.yml).
- Set `CHUNK_SIZE` to a low number, e.g., `10240` (10 KB):
  ```yaml
  - CHUNK_SIZE=10240
  ```
- Restart the container:
  ```bash
  cd storage-node
  docker compose up --build -d
  ```

### 2. Test Using Curl

*   **Upload a file** that is larger than the chunk size (e.g., 25 KB):
    ```bash
    # Create a 25 KB dummy file
    fsutil file createnew test-large.txt 25600
    
    # Upload the file
    curl -X POST -F "file=@test-large.txt" http://localhost:5001/files
    ```
    *Response format (Note the `chunks` array containing 3 chunk IDs):*
    ```json
    {
      "id": "f6d83e20-994c-47bc-8a4e-cbf7366110f2",
      "filename": "test-large.txt",
      "mimeType": "text/plain",
      "size": 25600,
      "chunkSize": 10240,
      "chunks": [
        "c213b290-7d72-4d2a-8b89-1144078cbfe3",
        "fa1e4e11-4770-4e63-b1d9-e9327ea3e2f9",
        "d8d32d4b-e60d-4299-a9a7-951b2ef10123"
      ],
      "uploadedAt": "2026-08-08T19:39:00.123Z"
    }
    ```

*   **Verify Files on Disk**:
    Open the local [`storage-node/data`](file:///f:/data/Laasya/Antigravity-projects/CloudVault/storage-node/data) folder. You will find:
    - `f6d83e20-994c-47bc-8a4e-cbf7366110f2.meta.json` (The manifest file)
    - `chunk_c213b290-7d72-4d2a-8b89-1144078cbfe3.bin` (First 10 KB chunk)
    - `chunk_fa1e4e11-4770-4e63-b1d9-e9327ea3e2f9.bin` (Second 10 KB chunk)
    - `chunk_d8d32d4b-e60d-4299-a9a7-951b2ef10123.bin` (Remaining 5 KB chunk)

*   **Download the file**:
    ```bash
    curl -o downloaded_large.txt http://localhost:5001/files/<FILE_ID>
    ```
    *The storage node reads the manifest and sequentially streams the chunks. Check that the reconstructed file matches the original 25,600 bytes.*

*   **Delete the file**:
    ```bash
    curl -X DELETE http://localhost:5001/files/<FILE_ID>
    ```
    *This deletes the manifest and all three corresponding `chunk_*.bin` files.*

---

## Running and Testing Phase 3 (Relational Metadata & PostgreSQL)

Phase 3 introduces PostgreSQL database containers to store file and chunk metadata tables, linked to chunk files on disk via UUID records.

### 1. Launch Services
Start both the database container (`cloudvault-db`) and storage node container:
```bash
cd storage-node
docker compose up --build -d
```

Confirm both containers are running:
```bash
docker compose ps
```

### 2. Test File Operations

*   **Upload a file** (e.g. `test-large.txt` from Phase 2):
    ```bash
    curl -X POST -F "file=@test-large.txt" http://localhost:5001/files
    ```
    *Response format (Note that chunk records now include the calculated cryptographic SHA-256 hash):*
    ```json
    {
      "id": "7fae4860-264d-44ab-90a4-11e4f2f0a1c3",
      "filename": "test-large.txt",
      "mimeType": "text/plain",
      "size": 25600,
      "chunks": [
        {
          "id": "2e8cb901-2a6c-48be-81fa-22cd4be587cb",
          "hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          "size": 10240
        },
        ...
      ],
      "uploadedAt": "2026-08-08T19:53:00.123Z"
    }
    ```

*   **Inspect Database Tables**:
    Since metadata is stored inside PostgreSQL, you can run queries directly inside the database container to inspect the schemas and tables:
    ```bash
    # View all rows in the files table
    docker exec -it cloudvault-db psql -U cloudvault_user -d cloudvault_metadata -c "SELECT * FROM files;"
    
    # View all rows in the chunks table
    docker exec -it cloudvault-db psql -U cloudvault_user -d cloudvault_metadata -c "SELECT * FROM chunks;"
    
    # View chunk sequencing in the junction table
    docker exec -it cloudvault-db psql -U cloudvault_user -d cloudvault_metadata -c "SELECT * FROM file_chunks;"
    ```

*   **Download the file**:
    Verify the files can be reassembled from the database chunk map:
    ```bash
    curl -o downloaded_large.txt http://localhost:5001/files/<FILE_ID>
    ```

*   **Delete the file**:
    Ensure database records are cascade-deleted and chunk files are deleted on disk:
    ```bash
    curl -X DELETE http://localhost:5001/files/<FILE_ID>
    ```
    Re-run the SQL select statements inside `cloudvault-db` to verify that the files, chunks, and mapping entries have been deleted.

---

## Running and Testing Phase 4 (Content-Based Deduplication)

Phase 4 adds block-level content deduplication using SHA-256 hash queries. If a chunk with matching bytes is uploaded multiple times, only one physical copy is written, and database references are reused.

### 1. Launch Services
Ensure you have started the containers:
```bash
cd storage-node
docker compose up --build -d
```

### 2. Verify Deduplication Workflows

*   **Upload File A** (e.g. `test-large.txt` of 25 KB):
    ```bash
    curl -X POST -F "file=@test-large.txt" http://localhost:5001/files
    ```
    Take note of the returned `id` (e.g., `FILE_A_ID`) and the list of chunk IDs.

*   **Upload File B** (the exact same content, but a different filename):
    ```bash
    # Copy file to a new name
    copy test-large.txt test-duplicate.txt
    
    # Upload the duplicate
    curl -X POST -F "file=@test-duplicate.txt" http://localhost:5001/files
    ```
    Take note of the returned `id` (e.g., `FILE_B_ID`).
    *In the console logs of the `storage-node` container, you should see logs showing `[DEDUPLICATION] Reused existing chunk on disk...` for each chunk!*

*   **Inspect Database Verification**:
    Run a query to inspect how the junction table maps both files to the **same** chunk IDs:
    ```bash
    # Verify that both files are present in the files table
    docker exec -it cloudvault-db psql -U cloudvault_user -d cloudvault_metadata -c "SELECT * FROM files;"

    # Verify that only ONE set of chunks is present in the chunks table (no duplicate chunk records)
    docker exec -it cloudvault-db psql -U cloudvault_user -d cloudvault_metadata -c "SELECT * FROM chunks;"

    # View the file_chunks junction mapping (both file_id keys mapped to the same chunk_id keys)
    docker exec -it cloudvault-db psql -U cloudvault_user -d cloudvault_metadata -c "SELECT * FROM file_chunks;"
    ```

*   **Inspect Disk Storage**:
    Check the local [`storage-node/data`](file:///f:/data/Laasya/Antigravity-projects/CloudVault/storage-node/data) directory. You will see that only 3 chunk `.bin` files exist on disk, rather than 6.

*   **Delete File A**:
    ```bash
    curl -X DELETE http://localhost:5001/files/<FILE_A_ID>
    ```
    *Check disk storage and database tables. File A's metadata is deleted, but the 3 chunk files remain on disk because they are still referenced by File B.*

*   **Delete File B**:
    ```bash
    curl -X DELETE http://localhost:5001/files/<FILE_B_ID>
    ```
    *Check disk storage. The 3 chunk files are now deleted from disk because their reference count dropped to 0 (fully orphaned).*

---

## Running and Testing Phase 5 (Multi-Node Distributed Architecture)

Phase 5 splits the storage node architecture into a Backend Coordinator gateway (running on port `3000`) and three independent, isolated storage nodes (`node-a`, `node-b`, `node-c`) running on ports `5001`, `5002`, and `5003` respectively.

### 1. Launch the Cluster
From the **project root directory** (where the master `docker-compose.yml` resides), boot up the entire system:
```bash
docker compose up --build -d
```

This launches:
- `cloudvault-db` (PostgreSQL database for metadata)
- `cloudvault-coordinator` (Backend Gateway on port `3000`)
- `cloudvault-node-a` (Storage Node A on port `5001`)
- `cloudvault-node-b` (Storage Node B on port `5002`)
- `cloudvault-node-c` (Storage Node C on port `5003`)

Confirm all services are running:
```bash
docker compose ps
```

### 2. Verify Node Health and Discovery
Query the Coordinator to see the health registry of all storage worker nodes:
```bash
curl http://localhost:3000/api/nodes
```
*Response format (Notice the status and chunk counts of each node):*
```json
[
  {
    "id": "node-a",
    "status": "ONLINE",
    "url": "http://node-a:5001",
    "latencyMs": 5,
    "details": { "status": "OK", "storageDir": "/app/data", "chunkCount": 0 }
  },
  {
    "id": "node-b",
    "status": "ONLINE",
    "url": "http://node-b:5002",
    "latencyMs": 4,
    "details": { "status": "OK", "storageDir": "/app/data", "chunkCount": 0 }
  },
  {
    "id": "node-c",
    "status": "ONLINE",
    "url": "http://node-c:5003",
    "latencyMs": 4,
    "details": { "status": "OK", "storageDir": "/app/data", "chunkCount": 0 }
  }
]
```

### 3. Test Distributed Upload

*   **Upload a file** (requests are now sent to port `3000`, the Coordinator):
    ```bash
    curl -X POST -F "file=@test-large.txt" http://localhost:3000/api/upload
    ```
    *Response format (Note that chunk records now map to specific nodes):*
    ```json
    {
      "id": "f6d83e20-994c-47bc-8a4e-cbf7366110f2",
      "filename": "test-large.txt",
      "mimeType": "text/plain",
      "size": 25600,
      "chunks": [
        { "id": "uuid-1", "hash": "hash-1", "size": 10240, "nodeId": "node-a" },
        { "id": "uuid-2", "hash": "hash-2", "size": 10240, "nodeId": "node-b" },
        { "id": "uuid-3", "hash": "hash-3", "size": 5120,  "nodeId": "node-c" }
      ],
      "uploadedAt": "2026-08-08T19:56:00.123Z"
    }
    ```

*   **Verify Distributed Storage**:
    Check the database to verify the mapping of chunks to nodes:
    ```bash
    docker exec -it cloudvault-db psql -U cloudvault_user -d cloudvault_metadata -c "SELECT id, chunk_hash, node_id FROM chunks;"
    ```
    You will see that different chunk UUIDs have been stored on different `node_id` strings (`node-a`, `node-b`, `node-c`) based on round-robin routing.

*   **Verify Health Check counts**:
    Re-run the health ping:
    ```bash
    curl http://localhost:3000/api/nodes
    ```
    You will see the `chunkCount` incremented to `1` on each of the nodes!

*   **Download the File**:
    ```bash
    curl -o downloaded_distributed.txt http://localhost:3000/api/download/<FILE_ID>
    ```
    *The Coordinator reads the mappings, pings each respective node over the private network to fetch the chunks, reassembles them, and streams them back.*

*   **Delete the File**:
    ```bash
    curl -X DELETE http://localhost:3000/api/files/<FILE_ID>
    ```
    *Check the database and node folders. The database records are deleted, and orphaned chunks are deleted on the specific nodes.*

---

## Running and Testing Phase 6 (Replication and Fault Tolerance)

Phase 6 implements N-way replication (default $N=2$) and dynamic coordinator failover.

### 1. Launch Services
Ensure you have booted up the entire cluster:
```bash
docker compose up --build -d
```

### 2. Verify Upload Replication
Upload a file (requests sent to the Coordinator on port `3000`):
```bash
curl -X POST -F "file=@test-large.txt" http://localhost:3000/api/upload
```
*Note that the response logs now output multiple `nodeIds` for each chunk block!*

### 3. Check Database Locations
Run a query to inspect how the locations table maps each chunk ID to multiple nodes:
```bash
docker exec -it cloudvault-db psql -U cloudvault_user -d cloudvault_metadata -c "SELECT * FROM chunk_locations;"
```
*You will see each chunk hash replicated on exactly 2 distinct storage node names (e.g. `node-a` and `node-b`), preventing double-placements on the same node.*

### 4. Simulate Storage Node Failure
We have added test endpoints to toggle node failures without killing Docker containers.
Simulate a failure on `node-a`:
```bash
curl -X POST http://localhost:3000/api/nodes/node-a/simulate-failure
```

Query the nodes status registry to verify it is marked as `OFFLINE`:
```bash
curl http://localhost:3000/api/nodes
```

### 5. Verify Dynamic Failover Read
Download the file while `node-a` is failed:
```bash
curl -o downloaded_replicated.txt http://localhost:3000/api/download/<FILE_ID>
```
*The Coordinator will trace the chunk mappings, attempt to read from `node-a`, detect that it is marked offline in the registry, print a warning, fall back to `node-b` (which holds the second replica), retrieve the bytes, and successfully complete the file reassembly and download!*

Check the Coordinator's console logs to see the failover:
```bash
docker logs cloudvault-coordinator
# You will see logs: [Failover] Skipping offline replica on Node: node-a
# followed by: [Download] Fetching chunk [ID] from active replica Node: node-b
```

### 6. Recover the Node
Restore `node-a` to the healthy cluster:
```bash
curl -X POST http://localhost:3000/api/nodes/node-a/recover
```
Pinging `/api/nodes` again will show `node-a` has returned to `ONLINE` status.

---

## Running and Testing Phase 7 (Automatic Replica Recovery)

Phase 7 adds background self-healing. When a node goes offline, chunks with active replica counts $< 2$ are automatically replicated to other healthy nodes, updating PostgreSQL metadata.

### 1. Launch Services
Ensure you have booted up the entire cluster:
```bash
docker compose up --build -d
```

### 2. Verify Self-Healing

*   **Upload a test file** (e.g. `test-large.txt` of 25 KB):
    ```bash
    curl -X POST -F "file=@test-large.txt" http://localhost:3000/api/upload
    ```
    Assume the chunks are stored on `node-a` and `node-b` (replication factor 2).

*   **Simulate failure** of `node-a`:
    ```bash
    curl -X POST http://localhost:3000/api/nodes/node-a/simulate-failure
    ```
    *This marks `node-a` as OFFLINE. The replication count of the chunks stored on A drops to 1.*

*   **Observe Recovery Logs**:
    Wait 10 seconds. The background recovery thread will scan the database, detect under-replicated chunks, copy them from `node-b` (active replica) to `node-c` (healthy online node that does not have the chunk), and save the new mappings to PostgreSQL.
    Check the Coordinator logs to verify the self-healing process:
    ```bash
    docker logs cloudvault-coordinator
    ```
    *You should see output similar to:*
    ```text
    [RECOVERY] Recovering under-replicated chunk [chunk-id]: copying from node-b to node-c...
    [RECOVERY SUCCESS] Chunk [chunk-id] recovered successfully on Node: node-c
    ```

*   **Verify Database Mappings**:
    Inspect the database tables. You will see that `chunk_locations` has been updated: the chunks that were on `node-a` and `node-b` are now registered on `node-c` as well:
    ```bash
    docker exec -it cloudvault-db psql -U cloudvault_user -d cloudvault_metadata -c "SELECT * FROM chunk_locations;"
    ```

*   **Verify Health Registry Counts**:
    Query `/api/nodes` again:
    ```bash
    curl http://localhost:3000/api/nodes
    ```
    *You will see that `node-c`'s chunk count has incremented, showing it has successfully absorbed the recovered replicas.*

---

## Running and Testing Phase 8 (AWS EC2 Cloud Deployment)

Phase 8 moves CloudVault from a local machine simulation to AWS cloud servers running Docker containers on multiple isolated instances.

*   **Documentation**: Detailed step-by-step instructions are available in the [AWS EC2 Cloud Deployment Guide](file:///f:/data/Laasya/Antigravity-projects/CloudVault/docs/phase-8-cloud-deployment.md).
*   **Verification**: Ensure all instances are configured inside the same VPC, security groups are locked down, the Coordinator runs on port 3000, and storage nodes communicate via private IPs.
*   **Cost Control**: Shut down (Stop) the instances when they are not in use to avoid billing surprises.

---

## Running and Testing Phase 9 (Multi-User Access Control, Folders & Web Dashboard)

Phase 9 completes the CloudVault architecture with secure multi-tenant authentication, nested folder hierarchies, granular file and folder sharing permissions, and a state-of-the-art glassmorphic frontend dashboard.

* **Documentation**: Full details in the [Phase 9 Multi-User Access Control Guide](file:///f:/data/Laasya/Antigravity-projects/CloudVault/docs/phase-9-multi-user-access-control.md).

### 🔑 Key Features
1. **User Authentication & JWT Tokens**:
   - Register (`POST /api/auth/register`) & Login (`POST /api/auth/login`) with BCrypt password hashing.
   - 7-day JWT access tokens with unique `jti` identifiers.
   - Invalidation blacklist (`POST /api/auth/logout`) persisting revoked tokens to PostgreSQL.
2. **Folder Hierarchy & Organization**:
   - Nested folder structures (`GET /api/folders`, `POST /api/folders`).
   - Breadcrumb directory navigation & item movement (`PATCH /api/folders/:id/move`, `PATCH /api/files/:id/move`).
3. **Granular Access Control & Sharing**:
   - Role Hierarchy: `OWNER` (3) > `EDITOR` (2) > `VIEWER` (1).
   - Share files (`POST /api/shares/files`) or folders (`POST /api/shares/folders`) with registered users by email.
   - Backend fail-fast authorization checks (`403 Forbidden`) preventing unauthorized storage node access.
4. **Interactive Glassmorphic Frontend Dashboard**:
   - Served directly by the Coordinator gateway at `http://localhost:3000`.
   - Real-time health gauges for worker nodes (`node-a`, `node-b`, `node-c`).
   - Visual storage capacity monitoring, file upload drag-and-drop, and share modals.

---

## 🧪 Automated System Test Suite

CloudVault includes an end-to-end automated test suite verifying auth flow, permissions, folder structures, and distributed uploads.

### Running the Test Suite
Ensure all services are running via Docker Compose (`docker compose up --build -d`), then execute:

```bash
node backend/tests/system.test.js
```

**Test Coverage**:
- ✅ User Registration & Token Generation
- ✅ Duplicate Email Rejection (409 Conflict)
- ✅ User Login & Password Validation
- ✅ Unauthenticated Access Rejection (401 Unauthorized)
- ✅ File Upload & Distributed Chunk Allocation
- ✅ Folder Creation & Nesting
- ✅ Permission Enforcement (`OWNER`, `EDITOR`, `VIEWER`)
- ✅ Sharing Files & Folders by User Email
- ✅ Inter-user Access Denial Verification

