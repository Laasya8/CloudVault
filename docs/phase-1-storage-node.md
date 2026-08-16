# Phase 1: Storage Node Service Documentation
## CloudVault Single Node File Storage

In Phase 1, we implement the foundational storage component of CloudVault: a standalone, containerized **Storage Node**. This document explains its inner workings, technology selection, API specifications, and current design limitations.

---

## 1. Core Architectural Explanations

### What a Storage Node Means
In a distributed storage system, a **Storage Node** is a physical or virtual machine responsible for storing raw file data on disk and serving it back over the network. 
In this phase, the storage node behaves as a standalone file repository. It has no awareness of a database, other nodes, or file chunking. It receives a file, saves it to its local directory under a unique identifier, and provides endpoints to fetch or delete it.

### How an HTTP Request Reaches the Storage Node
When a client sends a file upload request, it travels through several layers:

```
[Client / Curl]
       │
       ▼ (Sends HTTP request to localhost:5001)
┌───────────────────────────────────────────────┐
│              Docker Host Machine              │
│  Port Forwarding: 5001 (Host) -> 5001 (Cont.) │
└──────┬────────────────────────────────────────┘
       │
       ▼ (Passes into container network namespace)
┌───────────────────────────────────────────────┐
│            Docker Node.js Container           │
│  Exposed Port: 5001                           │
└──────┬────────────────────────────────────────┘
       │
       ▼ (Passes to internal Express server)
┌───────────────────────────────────────────────┐
│            Express HTTP Server (0.0.0.0:5001) │
│  app.post('/files', upload.single('file'))    │
└───────────────────────────────────────────────┘
```

1.  **Client Request**: The client connects to `http://localhost:5001`.
2.  **Port Mapping**: Docker forwards TCP packets from the host machine's port `5001` to port `5001` inside the running container.
3.  **Express Router**: The Express server listening inside the container on all network interfaces (`0.0.0.0:5001`) receives the request and routes it to the upload handler based on the HTTP method (`POST`) and route path (`/files`).

### How Uploaded Bytes Are Written to Disk
1.  **Multipart Parsing**: The request contains a file encoded in `multipart/form-data`. The `multer` middleware intercepts this, reads the incoming network stream, and buffers the file payload into memory.
2.  **UUID Generation**: We invoke the native `crypto.randomUUID()` method to generate a unique, 36-character string (e.g., `123e4567-e89b-12d3-a456-426614174000`).
3.  **Disk Write (Binary Payload)**: The server writes the raw buffered bytes from memory to the filesystem as `[uuid].bin` inside the dedicated `./data` folder.
4.  **Disk Write (Metadata JSON)**: The server constructs a metadata object containing the original filename, mime-type, and size. It saves this object as `[uuid].meta.json` inside the `./data` folder.

### How Downloading Works
1.  **Request Verification**: The server receives a `GET /files/:id` request. It validates the `:id` parameter against a UUID regex to protect against **directory traversal attacks** (e.g., trying to read `../../etc/passwd`).
2.  **Lookup**: It checks if `[id].bin` and `[id].meta.json` exist in the data folder.
3.  **Metadata Injection**: It reads the `meta.json` file. It sets crucial HTTP headers:
    *   `Content-Type`: Set to the file's original mime-type (e.g., `image/png`) so the browser knows how to render it.
    *   `Content-Disposition`: Set to `attachment; filename="original_name.ext"` so that browsers download the file with its original name instead of the random UUID.
    *   `Content-Length`: Set to the size of the binary payload.
4.  **Streaming**: It creates a read stream (`fs.createReadStream`) pointing to `[id].bin` and pipes the data directly into the HTTP response. Streaming is efficient because it transfers the file in small chunks, keeping memory usage constant regardless of file size.

### How Docker Isolates the Storage Node
Docker packages the Node.js application, its runtime, and standard packages into a single container:
*   **Filesystem Isolation**: The containerized node has its own virtual filesystem. It cannot access files on the host computer unless explicitly permitted.
*   **Port Isolation**: The node runs on port `5001` inside the container. It is invisible to the host network unless port binding (`5001:5001`) is configured.
*   **Volume Persistence**: By default, data written inside a container is lost when the container is deleted. To make our file uploads permanent, we mount a folder on our host machine (`./data` on host) to `/app/data` inside the container. This bridges the isolated environment with the host storage.

---

## 2. Technology Selection Rationale

| Technology | Role | Why It Was Chosen |
| :--- | :--- | :--- |
| **Node.js** | Runtime Environment | Built-in non-blocking asynchronous event loop, ideal for streaming heavy files and managing concurrent uploads. |
| **Express** | HTTP Framework | Simplifies route declaration, handles middleware logic smoothly, and has minimal boilerplate. |
| **Multer** | Multipart Form Parser | The industry standard Node.js middleware for handling file uploads. Takes care of stream boundary parsing. |
| **Crypto UUID** | ID Generator | Native Node.js module (zero-dependency). Generates secure UUID v4 strings to prevent naming collisions. |
| **Docker** | Containerization | Standardizes environment, dependencies, and port configuration. Eliminates installation friction on different operating systems (Windows/macOS/Linux). |

---

## 3. API Specification & Example Flows

### 1. Upload File
Uploads a raw file payload to the storage node.

*   **Endpoint**: `POST /files`
*   **Content-Type**: `multipart/form-data`
*   **Request Field**: `file` (Binary payload)
*   **Example Request (curl)**:
    ```bash
    curl -X POST -F "file=@/path/to/my-photo.jpg" http://localhost:5001/files
    ```
*   **Example Response (`201 Created`)**:
    ```json
    {
      "id": "76ec49b3-469b-430c-ab23-f2277dcf8a8c",
      "filename": "my-photo.jpg",
      "mimeType": "image/jpeg",
      "size": 182745,
      "uploadedAt": "2026-08-08T19:37:00.123Z"
    }
    ```

### 2. Download File
Retrieves the original file bytes with original filename headers.

*   **Endpoint**: `GET /files/:id`
*   **Example Request (curl)**:
    ```bash
    curl -o downloaded-photo.jpg http://localhost:5001/files/76ec49b3-469b-430c-ab23-f2277dcf8a8c
    ```
*   **Headers Returned**:
    ```http
    Content-Type: image/jpeg
    Content-Disposition: attachment; filename="my-photo.jpg"
    Content-Length: 182745
    ```

### 3. Delete File
Deletes both the binary payload and metadata from the disk.

*   **Endpoint**: `DELETE /files/:id`
*   **Example Request (curl)**:
    ```bash
    curl -X DELETE http://localhost:5001/files/76ec49b3-469b-430c-ab23-f2277dcf8a8c
    ```
*   **Example Response (`200 OK`)**:
    ```json
    {
      "message": "File deleted successfully"
    }
    ```

### 4. Health Check
*   **Endpoint**: `GET /health`
*   **Example Response (`200 OK`)**:
    ```json
    {
      "status": "OK",
      "storageDir": "/app/data"
    }
    ```

---

## 4. Important Design Decisions

1.  **Separation of Binary Payload & Metadata**: Instead of prefixing filenames, files are written as `[uuid].bin` alongside a `[uuid].meta.json` file. This prevents complex parsing of filename strings and allows the storage node to act as a structured key-value store, separating the binary data stream from details like original filenames and upload timestamps.
2.  **Validation of ID Parameter**: The endpoint routes validate the file ID using the regular expression `/^[a-f0-9-]{36}$/i`. This acts as a security filter, ensuring malicious users cannot pass directory traversal paths (e.g., `../../etc/...`) to execute file operations outside the dedicated data folder.
3.  **Memory Storage Middleware**: In this basic version, `multer.memoryStorage()` was chosen over `diskStorage` to keep the code simpler. Instead of handling disk renames or temporary directories, multer reads the upload stream directly into a memory buffer, which is immediately written out using `fs.writeFileSync`.

---

## 5. Limitations of This Phase

*   **Memory Overhead**: Because we buffer uploads in memory (`multer.memoryStorage()`), uploading massive files (e.g., multiple gigabytes) could cause the storage node server to crash due to out-of-memory errors. In later phases (or production systems), files must be streamed directly to disk chunk-by-chunk rather than loading them entirely into memory.
*   **Single Point of Failure**: All files are stored on this single node. If the node's hard drive crashes, data is permanently lost. There is no redundancy.
*   **No File Chunking**: Large files are stored as a single monolithic block. This makes it impossible to distribute pieces of files across multiple storage nodes or execute parallel downloads.
*   **No Deduplication**: Storing duplicate files uploads multiple identical copies, consuming unnecessary disk space.
