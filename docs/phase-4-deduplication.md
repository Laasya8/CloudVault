# Phase 4: Content-Based Deduplication Documentation
## CloudVault Intelligent Chunk-Level Space Optimization

In Phase 4, we introduce **Content-Based Chunk Deduplication** to CloudVault. By utilizing cryptographic SHA-256 hashing, the storage node automatically recognizes when identical data is uploaded and avoids storing duplicate physical files on disk, while maintaining a relational mapping so multiple files can securely point to the same physical chunks.

---

## 1. Core Cryptographic Concepts

### What Hashing Is
A **hash function** is a mathematical algorithm that takes an input of any size (e.g., a single character, a paragraph, or a 10 GB movie) and outputs a fixed-length string of characters. You can think of it as a **digital fingerprint**:
*   No matter how big the input is, the output is always the same length.
*   The same input will *always* generate the exact same hash output.
*   Even if you change a single comma or bit in a 1 GB file, the hash changes completely (known as the *avalanche effect*).

### Why SHA-256 Is Used
CloudVault uses **SHA-256** (Secure Hash Algorithm 256-bit), which is the industry standard for cryptographic indexing:
1.  **Uniformity**: It outputs a 256-bit value, represented as a 64-character hexadecimal string (e.g., `e3b0c44298fc1c14...`).
2.  **One-Way (Collision-Resistant)**: It is computationally impossible to reverse the hash to get the original data, and extremely difficult to find two different inputs that produce the same output.
3.  **Speed**: Modern CPUs can compute SHA-256 hashes extremely quickly on the fly.

### Does the System Read the File's Contents?
**Yes.** To determine if a file chunk is a duplicate, the system must inspect the actual binary bytes of the chunk. When a file is uploaded, the server reads the bytes of each chunk, feeds them to the SHA-256 algorithm, and generates the hash. Without reading the contents, content-addressable storage is impossible.

### Why Identical Content Produces the Same Hash
Hash algorithms are **deterministic**. They do not involve random numbers, timestamps, or metadata. The math behind the algorithm processes the binary bits of the data sequentially. If you feed the exact same sequence of ones and zeros, the mathematical formulas will compute the exact same resulting hexadecimal string every single time, regardless of when or where it is computed.

### Why Filenames Are Not Used for Deduplication
Filenames are untrustworthy and superficial pointers:
1.  **Same Content, Different Names**: If two students upload the same syllabus PDF named `syllabus.pdf` and `Syllabus_Fall_2026.pdf`, the contents are identical, but name-based deduplication would fail, creating duplicate storage.
2.  **Different Content, Same Name**: Two different students could upload an image named `photo.jpg` (one a picture of a cat, the other a picture of a dog). If we deduplicated by name, the second student would overwrite or get access to the first student's cat picture.
*   *Conclusion*: Hashing the content itself is the only secure way to identify duplicates.

---

## 2. Chunk-Level vs. Whole-File Deduplication

| Aspect | Whole-File Deduplication | Chunk-Level Deduplication (CloudVault) |
| :--- | :--- | :--- |
| **Granularity** | Evaluates the entire file as a single unit. | Splits files into chunks and evaluates each chunk. |
| **Edit Sensitivity** | Changing a single character in a 1 GB file changes the file hash, requiring the entire 1 GB to be stored again. | Changing a character only changes 1 chunk. The remaining 999 chunks are recognized as duplicates and reused. |
| **Cross-File Sharing** | Two files must be 100% identical to save space. | Two completely different files that share some blocks (like text documents or VM images) can reuse identical chunks. |
| **Complexity** | Low. Easy to implement in the database. | Medium. Requires managing a chunk sequence junction table. |

---

## 3. Advanced Relational Mechanics

### What a Hash Collision Means
A **hash collision** occurs if two completely different data chunks produce the exact same SHA-256 hash. 
*   **Probability**: The number of possible SHA-256 combinations is $2^{256}$ (roughly $1.15 \times 10^{77}$). This number is so large it exceeds the number of atoms in the observable universe.
*   **Safety**: In practice, the odds of a hash collision occurring by chance is lower than the odds of a meteor striking a server room at the exact second a hard drive fails. Therefore, we can safely treat the hash as a globally unique identifier for that specific content.

### Reference Counting & Safe Deletion
When a chunk is shared by multiple files, deleting one file must not delete the physical chunk file on disk. The system uses a clean relational query to determine when a chunk is safe to delete.

Instead of storing an explicit `ref_count` integer column in the database (which can easily drift or go out of sync if a transaction fails), CloudVault calculates references dynamically using the junction table:

```
                  ┌─────────────────┐
                  │    files table  │
                  └─┬─────────────┬─┘
                    │             │
                    ▼             ▼
             [File A (Delete)]  [File B (Keep)]
                    │             │
                    └─┬─────────┬─┘
                      ▼         ▼
                ┌─────────────────────┐
                │  file_chunks table  │  <-- Junction mapping table
                └──────────┬──────────┘
                           │
                           ▼ (Cascading delete removes File A mappings)
                    [  Chunk 1  ]
                           │
                           ▼ (Check remaining links)
                Still referenced by File B?
                - YES: Keep chunk in DB & on disk.
                - NO: Delete chunk from DB & disk (Orphaned).
```

**Safe Deletion Algorithm in PostgreSQL:**
1.  **Retrieve IDs**: Fetch all chunk IDs belonging to the file before deleting it.
2.  **Cascade Delete File**: Execute `DELETE FROM files WHERE id = $1`. The database automaticamente removes matching rows from the `file_chunks` junction table.
3.  **Check Surviving Mappings**: For each chunk ID, search the `file_chunks` table:
    ```sql
    SELECT 1 FROM file_chunks WHERE chunk_id = $1 LIMIT 1;
    ```
4.  **Prune Orphans**: If no rows are returned, it means no other files reference this chunk. The server deletes the record from the `chunks` table and deletes the corresponding `chunk_[id].bin` from disk. If a row is returned, the chunk remains intact.

---

## 4. Operational Walkthrough & Example

### Walkthrough Scenario
Consider two files uploaded to CloudVault (Chunk Size = 10 KB):
*   `document-v1.txt` (Size = 25 KB): Consists of Chunk A (10 KB), Chunk B (10 KB), and Chunk C (5 KB).
*   `document-v2.txt` (Size = 25 KB): You edit the last paragraph. The first 20 KB are identical. Consists of Chunk A (10 KB), Chunk B (10 KB), and Chunk D (5 KB - edited).

```
   On Disk (storage-node/data/):
   ├── chunk_UUID_A.bin (10 KB) ── Used by File 1 & 2
   ├── chunk_UUID_B.bin (10 KB) ── Used by File 1 & 2
   ├── chunk_UUID_C.bin (5 KB)  ── Used only by File 1
   └── chunk_UUID_D.bin (5 KB)  ── Used only by File 2

   PostgreSQL State (Junction Table):
   ┌─────────┬──────────────┬───────────────┐
   │ file_id │   chunk_id   │ sequence_num  │
   ├─────────┼──────────────┼───────────────┤
   │ File 1  │ chunk_UUID_A │      0        │
   │ File 1  │ chunk_UUID_B │      1        │
   │ File 1  │ chunk_UUID_C │      2        │
   │ File 2  │ chunk_UUID_A │      0        │
   │ File 2  │ chunk_UUID_B │      1        │
   │ File 2  │ chunk_UUID_D │      2        │
   └─────────┴──────────────┴───────────────┘
```

*   **Total Space Saved**: Without deduplication, storing both files takes 50 KB. With chunk deduplication, we only store Chunk A, B, C, and D, which takes **30 KB** (a **40% storage saving**).
*   **Deletion Behavior**: If the user deletes `document-v1.txt` (File 1):
    1.  File 1 mapping rows are deleted from `file_chunks`.
    2.  `chunk_UUID_A` and `chunk_UUID_B` still have active links to File 2. They are **not** deleted.
    3.  `chunk_UUID_C` has 0 references left. The database deletes its metadata record and the server deletes `chunk_UUID_C.bin` from disk.

---

## 5. Distributed Storage Benefits

In a massive, distributed environment (like cloud data centers), chunk-level deduplication is critical:
1.  **Bandwidth Conservation (Client-Side Deduplication)**: If the client calculates hashes locally and queries the server *before* uploading, and the server says "I already have Chunk A," the client does not need to send those bytes over the network, saving massive upload bandwidth.
2.  **Optimized Replication**: In a system where chunks are replicated (e.g. 2 copies on different nodes), we only need to replicate unique chunks, reducing network overhead between data centers.
3.  **Storage Efficiency**: Avoids paying for duplicate drives, reducing power, cooling, and hardware expenses.
