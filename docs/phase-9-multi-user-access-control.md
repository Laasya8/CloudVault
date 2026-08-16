# Phase 9: Multi-User Access Control & Security Architecture

This document provides a comprehensive, educational deep dive into the design and implementation of **Multi-User Authentication, Authorization, Ownership, and Role-Based Sharing** in CloudVault. It is written for computer science students and engineers who want to understand *how* and *why* these security patterns are constructed in distributed cloud storage systems.

---

## 1. Why Authentication is Needed

In single-tenant cloud storage systems, all uploaded files belong to a global bucket accessible by anyone with network access to the API server. In a production cloud storage ecosystem, multiple independent individuals or organizations share the same physical infrastructure.

Authentication solves the fundamental problem of **Identity Verification**:
- It provides a cryptographic mechanism to answer: *"Who is attempting to access this system?"*
- It establishes a trustworthy identity context for every incoming HTTP request.
- Without authentication, user privacy cannot exist, audit trails are impossible, and malicious actors could modify or delete arbitrary user data simply by knowing or guessing random UUID file IDs.

---

## 2. Authentication vs. Authorization

A common mistake in system design is conflating identity with permission. CloudVault enforces a strict separation between Authentication and Authorization:

| Concept | Question Answered | Primary Mechanism | Example |
| :--- | :--- | :--- | :--- |
| **Authentication** (*AuthN*) | *"Who are you?"* | Password Verification, JWT Signature Validation | Verifying that a Bearer token belongs to `alice@example.com` (User ID `usr_123`). |
| **Authorization** (*AuthZ*) | *"Are you allowed to perform this operation?"* | Database Permission Resolution, Role Hierarchy Checks | Checking if `usr_123` has `EDITOR` or `OWNER` rights before allowing `DELETE /api/files/file_abc`. |

**Golden Rule**: Authentication MUST always precede Authorization. A system must verify *who* the user is before evaluating *what* they are permitted to do.

---

## 3. Why Passwords Must Be Hashed

Storing passwords in plaintext (or using reversible two-way encryption) is a critical security vulnerability. If a database is leaked via SQL injection, stolen backup files, or compromised credentials, plaintext passwords expose every user across all websites where they reuse passwords.

### Modern Password Hashing with Bcrypt
CloudVault uses **`bcrypt`** (with a work factor / cost factor of 12):
1. **One-Way Cryptographic Hash**: It is mathematically infeasible to reverse a bcrypt hash back into the original plaintext password.
2. **Salt Generation**: Bcrypt automatically generates a unique 128-bit random salt for every user. This prevents **Rainbow Table attacks** (precomputed hash tables) and ensures two users with identical passwords (`"Password123"`) have completely different stored hash strings.
3. **Adaptive Work Factor (Key Stretching)**: Cost factor 12 enforces $2^{12} = 4,096$ iterations of the hashing algorithm per password verification. This deliberate CPU slowdown renders brute-force GPU cracking attacks computationally infeasible.

---

## 4. Why JSON Web Tokens (JWT) Are Used

In modern web applications, stateful session management (storing session IDs in server memory or Redis) introduces horizontal scaling bottlenecks. CloudVault adopts **JSON Web Tokens (JWT)** for stateless, scalable authentication.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        JWT TOKEN STRUCTURE                             │
├──────────────────┬─────────────────────────────────┬───────────────────┤
│    HEADER        │            PAYLOAD              │     SIGNATURE     │
│  {"alg":"HS256"} │ {"sub":"usr_123","email":"..."} │ HMACSHA256(...,   │
│                  │                                 │   JWT_SECRET)     │
└──────────────────┴─────────────────────────────────┴───────────────────┘
```

### Key Advantages of JWTs:
- **Stateless Verification**: The coordinator server verifies the authenticity of incoming requests by validating the cryptographic signature using `JWT_SECRET`. It does NOT need to query Redis or the DB on every single HTTP request to check if a session exists.
- **Microservice Ready**: Storage nodes or microservices can independently verify JWT tokens without querying a central auth server.
- **Server-Side Token Revocation**: CloudVault tracks revoked tokens on logout via an `invalidated_tokens` table. During authentication, if a token's `jti` (JWT ID) exists in `invalidated_tokens`, the request is instantly rejected with `401 Unauthorized`.

---

## 5. How a Request is Authenticated

Every protected endpoint in CloudVault is guarded by the `authenticate` Express middleware in [auth.js](file:///f:/data/Laasya/Antigravity-projects/CloudVault/backend/auth.js):

```
Client Request
  │
  ├─ HTTP Header: "Authorization: Bearer <token>"
  ▼
┌────────────────────────────────────────────────────────┐
│ Express `authenticate` Middleware                       │
├────────────────────────────────────────────────────────┤
│ 1. Extract Bearer token from header.                   │
│ 2. Verify signature & expiration using JWT_SECRET.     │
│ 3. Extract payload (`userId`, `email`, `jti`, `exp`).  │
│ 4. Check if `jti` is listed in `invalidated_tokens`.  │
│ 5. Attach user object to request (`req.user = ...`).   │
└──────────────────────────┬─────────────────────────────┘
                           │ Valid Token
                           ▼
                  Next Middleware / Handler
```

If the token is missing, expired, signed with an invalid secret, or revoked, `authenticate` halts execution and returns `401 Unauthorized`.

---

## 6. How Authorization is Checked

Once authentication establishes `req.user.userId`, authorization is enforced via higher-order middleware functions: `authorizeFile(minRole)` and `authorizeFolder(minRole)`.

### Role Rank Hierarchy
CloudVault defines explicit role ranks:
$$\text{OWNER (3)} > \text{EDITOR (2)} > \text{VIEWER (1)}$$

```javascript
// Example authorization middleware evaluation:
const authorizeFile = (minRole) => async (req, res, next) => {
  const fileId = req.params.id;
  const userId = req.user.userId;
  
  // 1. Resolve user's actual permission role for this file (Ownership / Direct Share / Inherited Folder Share)
  const userPermission = await db.getFilePermission(fileId, userId);
  
  // 2. Map roles to numeric ranks
  const roleRanks = { VIEWER: 1, EDITOR: 2, OWNER: 3 };
  
  // 3. Reject if permission is insufficient
  if (!userPermission || roleRanks[userPermission] < roleRanks[minRole]) {
    return res.status(403).json({ error: `Access denied. Operation requires ${minRole} permission.` });
  }
  
  next(); // Authorization granted!
};
```

---

## 7. User / File / Folder Relationships

CloudVault organizes user data into a hierarchical graph with ownership and sharing relations:

```
                  ┌──────────────┐
                  │  Users Table │
                  └──────┬───────┘
                         │ 1
                         │
                         │ owns (N)
             ┌───────────┴───────────┐
             ▼                       ▼
      ┌──────────────┐        ┌──────────────┐
      │  Folders DB  │        │   Files DB   │
      └──────┬───────┘        └──────┬───────┘
             │ 1                     │ 1
             │ parent_id             │ folder_id
             ▼ (N)                   ▼ (N)
      ┌──────────────┐        ┌──────────────┐
      │ Sub-Folders  │        │ Nested Files │
      └──────────────┘        └──────────────┘
```

---

## 8. Database Schema Changes

To support multi-tenancy, ownership, and role-based sharing, the PostgreSQL schema was updated with 5 core tables in [db.js](file:///f:/data/Laasya/Antigravity-projects/CloudVault/backend/db.js):

### ER Diagram (Simplified)
```
  ┌──────────────┐          ┌──────────────────────┐
  │    users     │          │  invalidated_tokens  │
  ├──────────────┤          ├──────────────────────┤
  │ user_id (PK) │          │ jti (PK)             │
  │ name         │          │ expires_at           │
  │ email        │          └──────────────────────┘
  │ password_hash│
  └──────┬───────┘
         │
         ├──────────────────────────────┐
         │ 1                            │ 1
         ▼ (N)                          ▼ (N)
  ┌──────────────┐               ┌──────────────┐
  │   folders    │               │    files     │
  ├──────────────┤               ├──────────────┤
  │ id (PK)      │               │ id (PK)      │
  │ name         │               │ filename     │
  │ parent_id(FK)│               │ user_id (FK) │
  │ owner_id (FK)│               │ folder_id(FK)│
  └──────┬───────┘               └──────┬───────┘
         │ 1                            │ 1
         ▼ (N)                          ▼ (N)
  ┌──────────────────┐           ┌──────────────────┐
  │  folder_shares   │           │   file_shares    │
  ├──────────────────┤           ├──────────────────┤
  │ share_id (PK)    │           │ share_id (PK)    │
  │ folder_id (FK)   │           │ file_id (FK)     │
  │ shared_with_id   │           │ shared_with_id   │
  │ permission       │           │ permission       │
  └──────────────────┘           └──────────────────┘
```

---

## 9. Ownership Model

- Every uploaded file is permanently stamped with `user_id = req.user.userId`.
- Every created folder is permanently stamped with `owner_id = req.user.userId`.
- The item creator is automatically granted the **`OWNER`** role.
- Only the `OWNER` can delete the file, rename the file, manage share permissions, or revoke access.

---

## 10. Viewer vs. Editor vs. Owner

CloudVault enforces clear operational boundaries for each role:

| Capability | VIEWER | EDITOR | OWNER |
| :--- | :---: | :---: | :---: |
| **Download / Read Chunks** | ✅ | ✅ | ✅ |
| **Inspect JSON Metadata** | ✅ | ✅ | ✅ |
| **Upload File into Shared Folder** | ❌ | ✅ | ✅ |
| **Upload New File Version** | ❌ | ✅ | ✅ |
| **Rename File / Folder** | ❌ | ❌ | ✅ |
| **Delete File / Folder** | ❌ | ❌ | ✅ |
| **Share / Grant Access to Others** | ❌ | ❌ | ✅ |
| **Revoke Share Access** | ❌ | ❌ | ✅ |

---

## 11. File Sharing Workflow

When User A shares `report.pdf` with User B as `VIEWER`:

```
User A (Owner)                           Coordinator Server                      User B (Recipient)
  │                                             │                                       │
  ├── 1. Enters email "bob@example.com"        │                                       │
  │      & selects role "VIEWER"                │                                       │
  │                                             │                                       │
  ├── 2. POST /api/files/:id/shares ───────────►│                                       │
  │      (Bearer Token A)                       ├── Check: Is User A OWNER? ✅          │
  │                                             ├── Lookup Bob's user_id in DB ✅       │
  │                                             ├── Insert row into `file_shares`       │
  │◄── 3. 201 Created ──────────────────────────┤                                       │
  │                                             │                                       │
  │                                             │◄── 4. GET /api/shared ────────────────┤
  │                                             │      (Bearer Token B)                 │
  │                                             ├─ Returns shared items list ──────────►│
  │                                             │                                       │
  │                                             │◄── 5. GET /api/download/:id ──────────┤
  │                                             │      (Bearer Token B)                 │
  │                                             ├── Check: Does Bob have VIEWER? ✅     │
  │                                             ├── Stream chunks from Storage Nodes ──►│
```

---

## 12. Folder Sharing & Permission Inheritance

Creating permission records for millions of individual files inside a shared directory causes database explosion and permission drift. CloudVault solves this using **Inherited Folder Permissions**.

### Recursive Permission Resolution Algorithm
When User B requests permission for file $F$, `getFilePermission(F, B)` evaluates permissions in this priority order:

1. **Direct Ownership**: If `file.user_id === B`, return `'OWNER'`.
2. **Direct File Share**: Query `file_shares` for `(F, B)`. If found, return role (`'EDITOR'` or `'VIEWER'`).
3. **Inherited Folder Permission**: If file $F$ is in folder $D$, call `getFolderPermission(D, B)`:
   - If folder $D$ is owned by $B$, return `'OWNER'`.
   - Query `folder_shares` for $(D, B)$. If found, return role.
   - Otherwise, walk up parent tree ($D.\text{parent\_id} \to D_{\text{parent}}$) recursively until root is reached.
4. **Access Denied**: If no matching share or ownership is found across the directory tree, return `null`.

```
Root Storage (Private)
  └── Projects/ [Shared with Bob as EDITOR]
        └── Budget.xlsx [No explicit share row needed! Inherits EDITOR from Projects/]
```

---

## 13. Why Authorization Belongs in the Backend

A fundamental rule of secure web development is: **Never trust the client.**

- Frontend UI logic (e.g. hiding a "Delete" button in `index.js`) is purely for User Experience (UX), NOT security.
- An attacker can bypass the UI using `curl`, Postman, or browser DevTools and issue raw HTTP requests (`DELETE /api/files/123`).
- Therefore, the backend coordinator MUST evaluate authorization rules (`authorizeFile`, `authorizeFolder`) before initiating database modifications, file metadata lookups, or storage node HTTP calls.

---

## 14. Why Storage Nodes Do Not Handle User Permissions

In CloudVault's architecture, storage nodes store raw binary `.bin` chunks identified strictly by their SHA-256 hash (e.g. `chunk_e3b0c44298fc1c14...bin`).

### Reasons for Keeping Storage Nodes Permission-Unaware:
1. **Decoupled Responsibilities**: Storage nodes handle physical I/O disk writes, chunk retrieval, and disk storage. They do not care about users, files, folders, or permissions.
2. **Content Deduplication**: If Alice and Bob upload identical 50MB video files, the system stores **only one copy** of the physical chunk across storage nodes. If storage nodes enforced file ownership, deduplication would break or leak cross-tenant user identity.
3. **Stateless Scalability**: Storage nodes do not need access to PostgreSQL user tables or JWT secrets. They can be scaled horizontally across different data centers without syncing permission states.

---

## 15. Complete Request Flow (End-to-End Architecture)

Below is the complete request flow when User B downloads a shared file:

```
[ Client Browser ]
        │
        │ 1. GET /api/files/:id/download (Authorization: Bearer <JWT_B>)
        ▼
[ Coordinator Gateway (server.js) ]
        │
        │ 2. Authenticate: Verify JWT signature & check `invalidated_tokens`
        ▼
[ Authorization Layer (auth.js) ]
        │
        │ 3. Authorize: Query DB `getFilePermission(fileId, userB)` -> VIEWER (Granted)
        ▼
[ Metadata Service & Chunk Mapping (db.js) ]
        │
        │ 4. Read Manifest: Fetch file chunks & node replica mapping from PostgreSQL
        ▼
[ Distributed Storage Manager (server.js) ]
        │
        │ 5. Health Check: Query nodeRegistry (Select active replica Node A / Node B)
        │ 6. HTTP GET /chunks/:chunkId
        ▼
┌────────────────────────────────────────────────────────┐
│ Storage Node A          │ Storage Node B (Replica)     │
│ (Reads chunk_1.bin)     │ (Failsafe backup)            │
└─────────────────────────┴──────────────────────────────┘
        │
        │ 7. Stream raw binary chunk back to Coordinator
        ▼
[ Coordinator Gateway ]
        │
        │ 8. Reassemble & stream file back to Client Browser
        ▼
[ Client Browser ] (File Downloaded ✅)
```

---

## 16. Security Considerations

1. **Bcrypt Work Factor**: Set to 12 rounds to balance CPU security and server throughput.
2. **JWT Revocation**: Logout queries PostgreSQL `invalidated_tokens` to instantly invalidate tokens before their natural expiry.
3. **Storage Node Isolation**: Storage node ports (`5001-5003`) are NOT bound to host network interfaces in `docker-compose.yml`, preventing bypass attacks.
4. **Metadata Sanitization**: Internal container URLs (`http://node-a:5001`) and host file directory paths (`/app/data`) are stripped from public API JSON responses.

---

## 17. Design Decisions & Alternatives Considered

| Design Decision | Chosen Approach | Alternative Considered | Why Chosen Approach Was Selected |
| :--- | :--- | :--- | :--- |
| **Token Management** | Stateless JWT with revocation table | Server-side Redis Sessions | Eliminates Redis infrastructure complexity while maintaining stateless horizontal scalability. |
| **Permission Storage** | Inherited Folder Permissions | Individual Permission Rows per File | Prevents database row explosion and eliminates permission sync issues when moving folders. |
| **Storage Node Access** | Private Coordinator Proxying | Direct Client S3 Presigned URLs | Prevents storage nodes from needing user permission awareness and preserves content deduplication. |

---

## 18. Limitations of Current Implementation

While robust, the current Phase 9 implementation has known boundaries designed for academic simplicity:
1. **Single Secret Key**: Uses a single environment variable `JWT_SECRET`. Production systems should use asymmetric public/private key pairs (RS256) with key rotation.
2. **Single Database Instance**: PostgreSQL runs on a single container node. Production deployments use PostgreSQL primary-replica clusters or distributed Spanner/CockroachDB databases.
3. **No Granular File-Level Lock**: Simultaneous uploads to the exact same file by two `EDITOR` users follow a last-write-wins policy.

---

## 19. Integration with Existing Distributed Storage Architecture

Phase 9 seamlessly integrates with CloudVault's existing core features without rewriting or breaking lower layers:

- **Chunking Engine**: Large files continue to be sliced into 1MB binary chunks regardless of file owner.
- **Content Deduplication**: SHA-256 chunk deduplication operates across all users. Storage chunks are reused globally while metadata tables strictly control which users have access to the file manifests referencing those chunks.
- **$N=2$ Replication & Recovery**: Automatic node failure detection and replica recovery run independently in the background. If a storage node goes offline, authorized users can still download their files via active secondary replicas seamlessly.
