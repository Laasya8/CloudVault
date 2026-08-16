# Phase 2: File Chunking Architecture Documentation
## CloudVault Local File Chunking & Reconstruction

In Phase 2, we introduce **File Chunking** to the CloudVault storage node. Files are no longer stored as monolithic entities; instead, they are split into smaller, independent blocks (chunks) on disk and reassembled dynamically on download.

---

## 1. Core Concepts of Chunking

### Why Cloud Storage Systems Divide Files
Modern cloud systems (like Google Drive, Dropbox, or AWS S3) slice files into small blocks rather than storing them whole. This is done for several reasons:

1.  **Unlimited File Sizes**: A single server or disk might only have 20 GB of free space. If a user uploads a 50 GB file, a monolithic system fails. By chunking it, we can scatter chunks across 5 different 10 GB storage nodes, successfully storing the file.
2.  **Horizontal Scalability**: Chunks of a single file can be distributed across many different computers. When downloading, the client can fetch different chunks from different servers in parallel, utilizing full network capacity.
3.  **Resiliency & Lower Rebuilding Overhead**: If a node containing a 10 GB file crashes, the system must replicate all 10 GB to a new machine to restore safety. If the file is split into 100 chunks of 100 MB, and one node containing 1 chunk crashes, the system only needs to copy that single 100 MB chunk.
4.  **Content-Based Deduplication**: Deduplication on whole files is rare (two files are rarely 100% identical). However, different documents or videos often share identical blocks of data. Chunking enables block-level deduplication, saving massive storage space.

### What Chunking Is
**Chunking** is the process of splitting a continuous byte stream or file into separate, smaller packets of data called **chunks**. These chunks are stored independently as individual files and given their own identifiers.

```
Original File: [=================== 2.5 MB ===================]
                                 │
                                 ▼ (Chunk Size: 1.0 MB)
Split into:
  - Chunk 1:   [====== 1.0 MB ======] (chunk_uuid1.bin)
  - Chunk 2:   [====== 1.0 MB ======] (chunk_uuid2.bin)
  - Chunk 3:   [=== 0.5 MB ===]       (chunk_uuid3.bin)
```

---

## 2. Technical Implementation in CloudVault

### How Chunks are Generated
When a file is received via `POST /files`, it is parsed by `multer` into a single Node.js memory buffer:
1.  **Buffer Slicing**: Using JavaScript's efficient buffer operation `buffer.subarray(offset, offset + CHUNK_SIZE)`, we extract slice views of the buffer without copying the underlying memory.
2.  **Configurable Chunk Size**: The slice size is determined by the `CHUNK_SIZE` environment variable (defaults to 1,048,576 bytes / 1 MB).
3.  **Writing to Disk**: Each slice is written directly to the data folder using standard synchronous write commands (`fs.writeFileSync`) as `chunk_[chunkId].bin`.

### How Chunks are Identified
In this phase, chunks are identified using randomly generated **UUID v4 strings** (`crypto.randomUUID()`). 
*   *Note: In future phases, these identifiers will change to SHA-256 content hashes to support deduplication.*

### How the Manifest Works
Because the chunks are stored as independent raw bytes on disk, they lose their association with the original file. To solve this, the server generates a **Manifest JSON file** named `[fileId].meta.json`. 

The manifest is the "map" that tells the system how to stitch the chunks back together. It contains:
```json
{
  "id": "76ec49b3-469b-430c-ab23-f2277dcf8a8c",
  "filename": "lecture-recording.mp4",
  "mimeType": "video/mp4",
  "size": 2621440,
  "chunkSize": 1048576,
  "chunks": [
    "503c9ee6-f56f-47bd-b203-9bb6708f1b62",
    "9cc7e43b-4809-4670-bbcf-7ab3f2be611e",
    "2e8cb901-2a6c-48be-81fa-22cd4be587cb"
  ],
  "uploadedAt": "2026-08-08T19:39:00.123Z"
}
```

### How Reconstruction Works
When a user calls `GET /files/:id`:
1.  The server reads the metadata manifest file `[id].meta.json`.
2.  It sets the headers for the download (`Content-Type`, `Content-Disposition`, `Content-Length`).
3.  It loops through the `chunks` array sequentially.
4.  For each chunk ID, it creates a readable file stream (`fs.createReadStream`) and pipes it into the HTTP response object `res`.
5.  By passing `{ end: false }` to the pipe operation, we prevent the response from closing when a single chunk stream finishes.
6.  Once the last chunk stream is fully written, the server calls `res.end()` to complete the transfer.

This streaming reassembly ensures that the client receives the file as a continuous, unified byte stream, just as if it were a single file on the server.

---

## 3. Configuration and Example

### Configurable Chunk Size
The chunk size is fully configurable via the `CHUNK_SIZE` environment variable (expressed in bytes).
*   **Why is this configurable?**
    Different application domains require different chunk sizes. Storing text databases benefits from smaller chunks (e.g., 64 KB) to optimize search and deduplication. High-definition video hosting systems prefer larger chunks (e.g., 4 MB or 8 MB) to reduce database indexing overhead and speed up sequential disk operations.
*   **Testing Convenience**:
    For local testing, students can set `CHUNK_SIZE` to a low value (e.g., `10240` bytes / 10 KB) inside `docker-compose.yml`. This allows chunking to be easily demonstrated using very small files.

### Step-by-Step Example

Suppose we set `CHUNK_SIZE=10240` (10 KB) and upload a file named `sample.txt` which is **25,000 bytes** (~24.4 KB).

1.  **Slicing**:
    *   **Chunk 1**: Bytes 0 to 10,240 (10 KB). Written to `chunk_a1b2.bin`.
    *   **Chunk 2**: Bytes 10,240 to 20,480 (10 KB). Written to `chunk_c3d4.bin`.
    *   **Chunk 3**: Bytes 20,480 to 25,000 (4.4 KB). Written to `chunk_e5f6.bin`.
2.  **Manifest Creation**:
    A metadata file `f6d83e20-....meta.json` is saved containing:
    `chunks: ["a1b2", "c3d4", "e5f6"]`
3.  **On Disk Verification**:
    In the `./data` directory, the student will see four files:
    *   `f6d83e20-....meta.json` (metadata manifest)
    *   `chunk_a1b2.bin`
    *   `chunk_c3d4.bin`
    *   `chunk_e5f6.bin`

---

## 4. Architectural Analysis

### Advantages
*   **Zero Infrastructure Overhead**: We implement the entire chunking logic inside the Node.js code itself, using standard files. There is no need for external database servers or complex chunk storage software.
*   **Smooth API Compatibility**: The external client does not know chunking is happening. To the user, they still call `POST /files` and `GET /files/:id`, making the system backward-compatible and simple to integrate.
*   **Ready for Distribution**: Because files are stored in independent chunk blocks, we can easily modify the system in later phases to write different chunks to different physical servers.

### Limitations & Trade-offs
*   **File Read Amplification**: To download a file, the server must open, read, and close multiple separate files on disk. This causes higher CPU and disk I/O overhead compared to streaming a single monolithic file.
*   **Orphaned Chunks**: If a program crash happens halfway through an upload, some chunk files might be written, but the final `.meta.json` manifest is never created. These chunk files become "orphaned" (wasted space).
*   **Memory Buffering Limit**: Our current Express server receives the file in memory buffer first before slicing. This means we cannot upload files larger than the container's available RAM. In production, chunking should be performed directly on incoming streams.

---

## 5. Technology Stack Decisions

For Phase 2, we deliberately avoided introducing external tools (like databases, key-value stores, or object storage software):
*   **Educational Clarity**: Hand-coding the chunking logic using plain JavaScript buffer slicing helps students understand the actual mechanics of file fragmentation.
*   **Zero Setup Friction**: By writing chunk metadata straight to JSON files in the same directory, the system remains a self-contained service that can be run with a single command (`docker compose up`), keeping it clean and developer-friendly.
