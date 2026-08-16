const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Readable } = require('stream');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { signToken, authenticate, authorizeFile, authorizeFolder } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE, 10) || 1024 * 1024; // Default to 1MB
const REPLICATION_FACTOR = parseInt(process.env.REPLICATION_FACTOR, 10) || 2;

// Parse storage nodes config
const STORAGE_NODES = (process.env.STORAGE_NODES || '')
  .split(',')
  .filter(Boolean)
  .map(nodeStr => {
    const [id, url] = nodeStr.split('=');
    return { id: id.trim(), url: url.trim() };
  });

// In-memory node health registry
const nodeRegistry = {};
STORAGE_NODES.forEach(node => {
  nodeRegistry[node.id] = {
    id: node.id,
    url: node.url,
    status: 'UNKNOWN',
    simulatedFailure: false,
    latencyMs: 0,
    chunkCount: 0
  };
});

// Global round-robin counter — persists across file uploads for even distribution
let globalChunkRoundRobin = 0;

// Configure Multer
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());

// Enable CORS for all incoming client requests
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Resolve frontend directory path dynamically (works both inside Docker /app/frontend and local backend/../frontend)
const frontendPath = fs.existsSync(path.join(__dirname, 'frontend'))
  ? path.join(__dirname, 'frontend')
  : path.join(__dirname, '../frontend');

// Serve static assets from the frontend directory
app.use(express.static(frontendPath));

// Serve index.html at root route
app.get('/', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// Log API actions
app.use((req, res, next) => {
  console.log(`[Coordinator Gateway] ${req.method} ${req.url}`);
  next();
});

/**
 * Health check worker - runs every 5 seconds to scan nodes and detect failures
 */
const scanNodesHealth = async () => {
  for (const node of STORAGE_NODES) {
    const registry = nodeRegistry[node.id];
    
    // If failure is simulated, bypass actual check and force OFFLINE status
    if (registry.simulatedFailure) {
      registry.status = 'OFFLINE';
      registry.latencyMs = 0;
      continue;
    }

    try {
      const start = Date.now();
      const res = await fetch(`${node.url}/health`, { signal: AbortSignal.timeout(1500) });
      const latency = Date.now() - start;

      if (res.ok) {
        const details = await res.json();
        registry.status = 'ONLINE';
        registry.latencyMs = latency;
        registry.chunkCount = details.chunkCount || 0;
      } else {
        registry.status = 'UNHEALTHY';
        registry.latencyMs = latency;
      }
    } catch (err) {
      registry.status = 'OFFLINE';
      registry.latencyMs = 0;
    }
  }
};


/**
 * Helper to retrieve list of online, active storage nodes
 */
const getActiveNodes = () => {
  return STORAGE_NODES.filter(node => {
    const reg = nodeRegistry[node.id];
    return reg.status === 'ONLINE' && !reg.simulatedFailure;
  });
};

// ─── Auth Routes (public — no middleware) ────────────────────────────────────

/**
 * POST /api/auth/register
 * Register a new user, return JWT.
 */
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email address.' });
    }

    const existing = await db.getUserByEmail(email.toLowerCase());
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await db.createUser({ name: name.trim(), email: email.toLowerCase(), passwordHash });
    const { token } = signToken(user);

    console.log(`[Auth] New user registered: ${user.email}`);
    res.status(201).json({
      token,
      user: { userId: user.user_id, name: user.name, email: user.email }
    });
  } catch (err) {
    console.error('[Auth] Register error:', err.message);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

/**
 * POST /api/auth/login
 * Login with email/password, return JWT.
 */
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = await db.getUserByEmail(email.toLowerCase());
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const { token } = signToken(user);
    console.log(`[Auth] User logged in: ${user.email}`);
    res.json({
      token,
      user: { userId: user.user_id, name: user.name, email: user.email }
    });
  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

/**
 * POST /api/auth/logout
 * Blacklist the current token's jti so it cannot be reused.
 */
app.post('/api/auth/logout', authenticate, async (req, res) => {
  try {
    const expiresAt = new Date(req.user.tokenExp * 1000);
    await db.invalidateToken(req.user.jti, expiresAt);
    console.log(`[Auth] User logged out: ${req.user.email}`);
    res.json({ message: 'Logged out successfully.' });
  } catch (err) {
    console.error('[Auth] Logout error:', err.message);
    res.status(500).json({ error: 'Logout failed.' });
  }
});

/**
 * GET /api/auth/me & GET /api/users/me
 * Returns the currently authenticated user's profile.
 */
const getMeHandler = async (req, res) => {
  try {
    const user = await db.getUserById(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json({ userId: user.user_id, name: user.name, email: user.email, createdAt: user.created_at });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user profile.' });
  }
};

app.get('/api/auth/me', authenticate, getMeHandler);
app.get('/api/users/me', authenticate, getMeHandler);

// ─── Protected Routes ─────────────────────────────────────────────────────────

/**
 * 1. Upload File (with Distributed Replication & Deduplication)
 * POST /api/upload
 * Requires EDITOR permission on target folder (or OWNER)
 */
app.post('/api/upload', authenticate, authorizeFolder('EDITOR'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded. Specify file field as "file".' });
    }

    // Optional folder assignment
    let folderId = req.body.folderId || req.query.folderId || null;
    if (folderId === 'root' || folderId === '') folderId = null;

    if (folderId) {
      const perm = await db.getFolderPermission(folderId, req.user.userId);
      if (perm !== 'OWNER' && perm !== 'EDITOR') {
        return res.status(403).json({ error: 'Access denied. You need EDITOR or OWNER permission on the target folder.' });
      }
    }

    const activeNodes = getActiveNodes();
    if (activeNodes.length < REPLICATION_FACTOR) {
      return res.status(503).json({
        error: `Insufficient healthy storage nodes. Needed: ${REPLICATION_FACTOR}, Online: ${activeNodes.length}.`
      });
    }

    const fileId = crypto.randomUUID();
    const buffer = req.file.buffer;
    const totalSize = buffer.length;
    const chunks = [];
    let reusedChunksCount = 0;

    // Slice file into chunks
    let offset = 0;
    while (offset < totalSize) {
      const chunkBuffer = buffer.subarray(offset, offset + CHUNK_SIZE);
      const chunkHash = crypto.createHash('sha256').update(chunkBuffer).digest('hex');

      // Check if chunk already exists in database (deduplication check)
      const existingChunk = await db.getChunkIdByHash(chunkHash);
      let chunkId;
      let targetNodeIds = [];

      if (existingChunk) {
        reusedChunksCount++;
        // Reuse existing chunk and its stored locations
        chunkId = existingChunk.id;
        targetNodeIds = existingChunk.nodeIds;
        console.log(`[Deduplication] Chunk ${chunkHash.substring(0, 8)} already exists on: [${targetNodeIds.join(', ')}]. Reusing.`);
      } else {
        // New chunk - Select distinct healthy nodes for replicas using a round-robin selector
        chunkId = crypto.randomUUID();
        
        for (let i = 0; i < REPLICATION_FACTOR; i++) {
          const node = activeNodes[(globalChunkRoundRobin + i) % activeNodes.length];
          targetNodeIds.push(node.id);
        }

        console.log(`[Upload] Chunk #${globalChunkRoundRobin} (Hash: ${chunkHash.substring(0, 8)}) -> Replicating to nodes: [${targetNodeIds.join(', ')}]`);

        // Upload chunk payload to all assigned replica nodes
        for (const nodeId of targetNodeIds) {
          const nodeInfo = STORAGE_NODES.find(n => n.id === nodeId);
          
          const formData = new FormData();
          const fileBlob = new Blob([chunkBuffer], { type: 'application/octet-stream' });
          formData.append('file', fileBlob, `chunk_${chunkId}.bin`);

          try {
            const uploadRes = await fetch(`${nodeInfo.url}/chunks/${chunkId}`, {
              method: 'POST',
              body: formData
            });

            if (!uploadRes.ok) {
              throw new Error(`Node ${nodeId} upload failed with status ${uploadRes.status}`);
            }
          } catch (nodeErr) {
            console.error(`Failed replica upload of chunk ${chunkId} to node ${nodeId}:`, nodeErr);
            return res.status(500).json({ error: `Upload aborted due to replica node failure on ${nodeId}.` });
          }
        }
      }

      chunks.push({
        id: chunkId,
        hash: chunkHash,
        size: chunkBuffer.length,
        nodeIds: targetNodeIds
      });

      offset += CHUNK_SIZE;
      globalChunkRoundRobin++; // Advance global counter so next chunk (even from a different file) starts on next node
    }

    // Save manifest metadata
    const metadata = {
      id: fileId,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      size: totalSize,
      chunks: chunks,
      uploadedAt: new Date().toISOString(),
      reusedChunksCount: reusedChunksCount,
      userId: req.user.userId,   // scope file to authenticated user
      folderId: folderId
    };

    await db.saveFileMetadata(metadata);
    res.status(201).json(metadata);
  } catch (error) {
    console.error('Error during file upload coordinator:', error);
    res.status(500).json({ error: 'Failed to process and replicate file chunks.' });
  }
});

/**
 * Resumable Upload Init
 * POST /api/files/upload/init
 */
app.post('/api/files/upload/init', authenticate, authorizeFolder('EDITOR'), async (req, res) => {
  try {
    const { filename, size, mimeType, folderId } = req.body;
    if (!filename || !size) {
      return res.status(400).json({ error: 'Filename and size are required to initialize upload.' });
    }

    const uploadId = crypto.randomUUID();
    res.status(200).json({
      uploadId,
      filename,
      size: parseInt(size, 10),
      mimeType: mimeType || 'application/octet-stream',
      chunkSize: CHUNK_SIZE,
      replicationFactor: REPLICATION_FACTOR,
      status: 'INITIALIZED'
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to initialize resumable upload.' });
  }
});

/**
 * Resumable Upload Commit
 * POST /api/files/upload/commit
 */
app.post('/api/files/upload/commit', authenticate, authorizeFolder('EDITOR'), async (req, res) => {
  try {
    const { uploadId, filename, size, mimeType, chunks, folderId } = req.body;
    if (!uploadId || !filename || !chunks) {
      return res.status(400).json({ error: 'uploadId, filename, and chunks array are required.' });
    }

    const fileId = uploadId;
    let fId = folderId || null;
    if (fId === 'root' || fId === '') fId = null;

    const metadata = {
      id: fileId,
      filename: filename,
      mimeType: mimeType || 'application/octet-stream',
      size: parseInt(size, 10) || 0,
      chunks: chunks,
      uploadedAt: new Date().toISOString(),
      userId: req.user.userId,
      folderId: fId
    };

    await db.saveFileMetadata(metadata);
    res.status(201).json(metadata);
  } catch (err) {
    console.error('[Upload Commit] Error:', err.message);
    res.status(500).json({ error: 'Failed to commit file upload manifest.' });
  }
});

/**
 * 2. Download File (Distributed Reassembly with Fault Tolerance Failover)
 * GET /api/download/:id
 * Requires VIEWER, EDITOR, or OWNER permission on file. Checks authorization BEFORE hitting storage nodes!
 */
const downloadFileHandler = async (req, res) => {
  try {
    const fileId = req.params.id;
    const metadata = req.fileMetadata; // Injected by authorizeFile middleware after authorization check passed

    // Pre-flight check: Ensure all chunks have at least one online replica before sending download headers
    for (const chunk of metadata.chunks) {
      const hasOnlineReplica = chunk.nodeIds.some(nodeId => {
        const registry = nodeRegistry[nodeId];
        return registry && registry.status === 'ONLINE' && !registry.simulatedFailure;
      });
      
      if (!hasOnlineReplica) {
        return res.status(503).json({ 
          error: `Cannot download file. Chunk ${chunk.id.substring(0, 8)}... is fully offline (no active replicas online).` 
        });
      }
    }

    // Set headers and disable caching
    res.setHeader('Content-Type', metadata.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(metadata.filename)}"`);
    res.setHeader('Content-Length', metadata.size);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');

    // Fetch chunks, failing over dynamically if replica nodes are down
    for (const chunk of metadata.chunks) {
      let chunkStream = null;

      // Try reading chunk from active replicas in order
      for (const nodeId of chunk.nodeIds) {
        const registry = nodeRegistry[nodeId];
        
        // Check health check registry before making call
        if (!registry || registry.status !== 'ONLINE' || registry.simulatedFailure) {
          console.warn(`[Failover] Skipping offline replica on Node: ${nodeId}`);
          continue;
        }

        const nodeUrl = registry.url;
        console.log(`[Download] Fetching chunk ${chunk.id} from active replica Node: ${nodeId}`);

        try {
          const chunkFetchRes = await fetch(`${nodeUrl}/chunks/${chunk.id}`, {
            signal: AbortSignal.timeout(2000)
          });

          if (chunkFetchRes.ok) {
            chunkStream = Readable.fromWeb(chunkFetchRes.body);
            break; // Found working chunk! Exit replica loop.
          }
          console.warn(`[Failover] Node ${nodeId} returned status ${chunkFetchRes.status} for chunk ${chunk.id}`);
        } catch (fetchErr) {
          console.warn(`[Failover] Connection failed to replica Node ${nodeId} for chunk ${chunk.id}:`, fetchErr.message);
        }
      }

      // If no replica answered, abort download
      if (!chunkStream) {
        console.error(`[CRITICAL] All replica nodes for chunk ${chunk.id} are offline!`);
        return res.status(500).end(); // connection aborted
      }

      // Pipe chunk data to client
      await new Promise((resolve, reject) => {
        chunkStream.on('error', reject);
        chunkStream.on('end', resolve);
        chunkStream.pipe(res, { end: false });
      });
    }
    res.end();
  } catch (error) {
    console.error('Error during file download coordinator:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to retrieve file chunks.' });
    } else {
      res.end();
    }
  }
};

app.get('/api/download/:id', authenticate, authorizeFile('VIEWER'), downloadFileHandler);
app.get('/api/files/:id/download', authenticate, authorizeFile('VIEWER'), downloadFileHandler);

/**
 * 3. Delete File (Distributed Cleanup across Replicas)
 * DELETE /api/files/:id
 * Requires OWNER permission on file. Checks authorization BEFORE deleting chunks!
 */
app.delete('/api/files/:id', authenticate, authorizeFile('OWNER'), async (req, res) => {
  try {
    const fileId = req.params.id;

    const orphanedChunks = await db.deleteFileMetadata(fileId);
    if (!orphanedChunks) {
      return res.status(404).json({ error: 'File not found.' });
    }

    // Call DELETE API on all hosting replicas for orphaned chunks
    const deletionPromises = [];
    orphanedChunks.forEach(chunk => {
      chunk.nodeIds.forEach(nodeId => {
        const node = STORAGE_NODES.find(n => n.id === nodeId);
        if (!node) return;

        console.log(`[Delete] Pruning orphaned chunk ${chunk.id} from Node: ${node.id}`);

        deletionPromises.push(
          fetch(`${node.url}/chunks/${chunk.id}`, { method: 'DELETE' })
            .then(delRes => {
              if (delRes.ok || delRes.status === 404) {
                // Immediately decrement in-memory count so UI reflects deletion instantly
                if (nodeRegistry[nodeId]) {
                  nodeRegistry[nodeId].chunkCount = Math.max(0, (nodeRegistry[nodeId].chunkCount || 1) - 1);
                }
              }
            })
            .catch(err => console.error(`Failed to delete chunk ${chunk.id} on node ${node.id}:`, err.message))
        );
      });
    });

    await Promise.all(deletionPromises);
    res.status(200).json({ message: 'File and all unreferenced replicas deleted successfully.' });
  } catch (error) {
    console.error('Error during file deletion coordinator:', error);
    res.status(500).json({ error: 'Failed to delete file.' });
  }
});

/**
 * 4. List Files
 * GET /api/files (?folderId=...)
 */
app.get('/api/files', authenticate, async (req, res) => {
  try {
    const folderId = req.query.folderId; // undefined = all files, 'root' or null = root files, UUID = specific folder
    const files = await db.listFiles(req.user.userId, folderId);
    const filesWithChunks = await Promise.all(
      files.map(async (file) => {
        const fullMeta = await db.getFileMetadata(file.id);
        return fullMeta;
      })
    );
    res.status(200).json(filesWithChunks);
  } catch (error) {
    res.status(500).json({ error: 'Failed to list files.' });
  }
});

// ─── Folder Endpoints ─────────────────────────────────────────────────────────

/**
 * Create Folder
 * POST /api/folders
 */
app.post('/api/folders', authenticate, async (req, res) => {
  try {
    const { name, parentId } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Folder name is required.' });
    }

    let pId = parentId || null;
    if (pId === 'root' || pId === '') pId = null;

    if (pId) {
      const parent = await db.getFolderById(pId);
      if (!parent || parent.ownerId !== req.user.userId) {
        return res.status(403).json({ error: 'Parent folder does not exist or access denied.' });
      }
    }

    const folder = await db.createFolder({
      name: name.trim(),
      parentId: pId,
      ownerId: req.user.userId
    });

    console.log(`[Folder] User ${req.user.email} created folder "${folder.name}" (${folder.id})`);
    res.status(201).json(folder);
  } catch (err) {
    console.error('[Folder] Create error:', err.message);
    res.status(500).json({ error: 'Failed to create folder.' });
  }
});

/**
 * List Folders
 * GET /api/folders (?parentId=...)
 */
app.get('/api/folders', authenticate, async (req, res) => {
  try {
    const parentId = req.query.parentId; // undefined = all folders, 'root' or null = root level folders
    const folders = await db.listFolders(req.user.userId, parentId);
    res.json(folders);
  } catch (err) {
    console.error('[Folder] List error:', err.message);
    res.status(500).json({ error: 'Failed to list folders.' });
  }
});

/**
 * Get Specific Folder & Contents
 * GET /api/folders/:id
 */
app.get('/api/folders/:id', authenticate, authorizeFolder('VIEWER'), async (req, res) => {
  try {
    const folderId = req.params.id;
    const folder = await db.getFolderById(folderId);
    if (!folder) return res.status(404).json({ error: 'Folder not found.' });

    const subfolders = await db.listFolders(req.user.userId, folderId);
    const files = await db.listFiles(req.user.userId, folderId);

    res.json({
      folder,
      subfolders,
      files
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch folder contents.' });
  }
});

// ─── Sharing & Rename Endpoints ───────────────────────────────────────────────

/**
 * Rename File (OWNER only)
 * PATCH /api/files/:id/rename
 */
app.patch('/api/files/:id/rename', authenticate, authorizeFile('OWNER'), async (req, res) => {
  try {
    const fileId = req.params.id;
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'New file name is required.' });

    const updated = await db.renameFile(fileId, name.trim());
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to rename file.' });
  }
});

/**
 * Share File (OWNER only)
 * POST /api/files/:id/share & POST /api/files/:id/shares
 */
const shareFileHandler = async (req, res) => {
  try {
    const fileId = req.params.id;
    const { email, permission } = req.body; // permission = 'EDITOR' | 'VIEWER'

    if (!email || !permission) return res.status(400).json({ error: 'Email and permission are required.' });
    if (!['EDITOR', 'VIEWER'].includes(permission.toUpperCase())) {
      return res.status(400).json({ error: 'Permission must be EDITOR or VIEWER.' });
    }

    const targetUser = await db.getUserByEmail(email.trim().toLowerCase());
    if (!targetUser) return res.status(404).json({ error: 'Target user not found.' });

    if (targetUser.user_id === req.user.userId) {
      return res.status(400).json({ error: 'You are already the owner of this file.' });
    }

    const shareRecord = await db.shareFile({
      fileId,
      sharedWithUserId: targetUser.user_id,
      permission: permission.toUpperCase(),
      createdBy: req.user.userId
    });

    res.status(201).json({ message: `File shared with ${targetUser.email} as ${permission.toUpperCase()}`, share: shareRecord });
  } catch (err) {
    console.error('File share error:', err);
    res.status(500).json({ error: 'Failed to share file.' });
  }
};

app.post('/api/files/:id/share', authenticate, authorizeFile('OWNER'), shareFileHandler);
app.post('/api/files/:id/shares', authenticate, authorizeFile('OWNER'), shareFileHandler);

/**
 * Unshare File (OWNER only)
 * DELETE /api/files/:id/share/:userId & DELETE /api/files/:id/shares/:shareId
 */
const unshareFileHandler = async (req, res) => {
  try {
    const fileId = req.params.id;
    const targetUserId = req.params.userId || req.params.shareId;
    await db.unshareFile(fileId, targetUserId);
    res.json({ message: 'File share revoked successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unshare file.' });
  }
};

app.delete('/api/files/:id/share/:userId', authenticate, authorizeFile('OWNER'), unshareFileHandler);
app.delete('/api/files/:id/shares/:shareId', authenticate, authorizeFile('OWNER'), unshareFileHandler);

/**
 * Get File Shares (OWNER only)
 * GET /api/files/:id/shares
 */
app.get('/api/files/:id/shares', authenticate, authorizeFile('OWNER'), async (req, res) => {
  try {
    const fileId = req.params.id;
    const shares = await db.getFileShares(fileId);
    res.json(shares);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch shares.' });
  }
});

/**
 * Get Single File Metadata (VIEWER, EDITOR, or OWNER)
 * GET /api/files/:id
 */
app.get('/api/files/:id', authenticate, authorizeFile('VIEWER'), async (req, res) => {
  res.json(req.fileMetadata);
});

/**
 * Share Folder (OWNER only)
 * POST /api/folders/:id/share & POST /api/folders/:id/shares
 */
const shareFolderHandler = async (req, res) => {
  try {
    const folderId = req.params.id;
    const { email, permission } = req.body;

    if (!email || !permission) return res.status(400).json({ error: 'Email and permission are required.' });
    if (!['EDITOR', 'VIEWER'].includes(permission.toUpperCase())) {
      return res.status(400).json({ error: 'Permission must be EDITOR or VIEWER.' });
    }

    const targetUser = await db.getUserByEmail(email.trim().toLowerCase());
    if (!targetUser) return res.status(404).json({ error: 'Target user not found.' });

    if (targetUser.user_id === req.user.userId) {
      return res.status(400).json({ error: 'You are already the owner of this folder.' });
    }

    const shareRecord = await db.shareFolder({
      folderId,
      sharedWithUserId: targetUser.user_id,
      permission: permission.toUpperCase(),
      createdBy: req.user.userId
    });

    res.status(201).json({ message: `Folder shared with ${targetUser.email} as ${permission.toUpperCase()}`, share: shareRecord });
  } catch (err) {
    console.error('Folder share error:', err);
    res.status(500).json({ error: 'Failed to share folder.' });
  }
};

app.post('/api/folders/:id/share', authenticate, authorizeFolder('OWNER'), shareFolderHandler);
app.post('/api/folders/:id/shares', authenticate, authorizeFolder('OWNER'), shareFolderHandler);

/**
 * Unshare Folder (OWNER only)
 * DELETE /api/folders/:id/share/:userId & DELETE /api/folders/:id/shares/:shareId
 */
const unshareFolderHandler = async (req, res) => {
  try {
    const folderId = req.params.id;
    const targetUserId = req.params.userId || req.params.shareId;
    await db.unshareFolder(folderId, targetUserId);
    res.json({ message: 'Folder share revoked successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unshare folder.' });
  }
};

app.delete('/api/folders/:id/share/:userId', authenticate, authorizeFolder('OWNER'), unshareFolderHandler);
app.delete('/api/folders/:id/shares/:shareId', authenticate, authorizeFolder('OWNER'), unshareFolderHandler);

/**
 * Get Folder Shares (OWNER only)
 * GET /api/folders/:id/shares
 */
app.get('/api/folders/:id/shares', authenticate, authorizeFolder('OWNER'), async (req, res) => {
  try {
    const folderId = req.params.id;
    const shares = await db.getFolderShares(folderId);
    res.json(shares);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch folder shares.' });
  }
});

/**
 * List Shared With Me Items
 * GET /api/shared
 */
app.get('/api/shared', authenticate, async (req, res) => {
  try {
    const shared = await db.listSharedWithMe(req.user.userId);
    res.json(shared);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch shared items.' });
  }
});

/**
 * 5. Health Registry Status
 * GET /api/nodes
 */
app.get('/api/nodes', authenticate, (req, res) => {
  const sanitizedNodes = Object.values(nodeRegistry).map(node => ({
    id: node.id,
    status: node.status,
    simulatedFailure: node.simulatedFailure,
    latencyMs: node.latencyMs,
    chunkCount: node.chunkCount
  }));
  res.json(sanitizedNodes);
});

/**
 * 6. Simulate Node Failure (Demo endpoint)
 * POST /api/nodes/:id/simulate-failure
 */
app.post('/api/nodes/:id/simulate-failure', authenticate, (req, res) => {
  const nodeId = req.params.id;
  if (!nodeRegistry[nodeId]) {
    return res.status(404).json({ error: 'Node not found.' });
  }
  
  nodeRegistry[nodeId].simulatedFailure = true;
  nodeRegistry[nodeId].status = 'OFFLINE';
  nodeRegistry[nodeId].latencyMs = 0;
  
  console.log(`[DEMO] Simulated failure activated for Node: ${nodeId}`);
  
  // Trigger aggressive recovery check immediately
  runReplicaRecovery().catch(err => console.error('Aggressive recovery check failed:', err.message));

  res.json({ message: `Simulated failure activated for node ${nodeId}`, node: nodeRegistry[nodeId] });
});

/**
 * 7. Recover Node (Demo endpoint)
 * POST /api/nodes/:id/recover
 */
app.post('/api/nodes/:id/recover', authenticate, async (req, res) => {
  const nodeId = req.params.id;
  if (!nodeRegistry[nodeId]) {
    return res.status(404).json({ error: 'Node not found.' });
  }
  
  nodeRegistry[nodeId].simulatedFailure = false;
  
  // Instantly scan health to refresh status
  await scanNodesHealth();
  
  console.log(`[DEMO] Recovered Node from simulated failure: ${nodeId}`);
  
  // Trigger aggressive recovery check immediately to fill in any missing replicas onto this node
  runReplicaRecovery().catch(err => console.error('Aggressive recovery check failed:', err.message));

  res.json({ message: `Node ${nodeId} recovered. Current status: ${nodeRegistry[nodeId].status}`, node: nodeRegistry[nodeId] });
});

/**
 * Background Recovery Task - scans the database for chunks whose replica count has
 * dropped below REPLICATION_FACTOR and copies them to other healthy nodes.
 */
const runReplicaRecovery = async () => {
  try {
    const chunks = await db.getAllChunkLocations();
    
    for (const chunk of chunks) {
      // Split registered nodes into online and offline
      const onlineHosts = chunk.nodeIds.filter(nodeId => {
        const reg = nodeRegistry[nodeId];
        return reg && reg.status === 'ONLINE' && !reg.simulatedFailure;
      });
      const offlineHosts = chunk.nodeIds.filter(nodeId => !onlineHosts.includes(nodeId));

      // All replicas offline — data loss, nothing we can do
      if (onlineHosts.length === 0) {
        console.error(`[RECOVERY ERROR] Chunk ${chunk.chunkId} is fully offline!`);
        continue;
      }

      // UNDER-REPLICATION: fewer online copies than required
      if (onlineHosts.length < REPLICATION_FACTOR) {
        const copiesNeeded = REPLICATION_FACTOR - onlineHosts.length;

        // Eligible destinations: online nodes that do NOT currently hold this chunk at all (check ALL registered nodeIds, not just onlineHosts)
        const eligibleDestinations = STORAGE_NODES.filter(node => {
          const reg = nodeRegistry[node.id];
          const isOnline = reg && reg.status === 'ONLINE' && !reg.simulatedFailure;
          const alreadyHasIt = chunk.nodeIds.includes(node.id); // check ALL registered locations, not just online ones
          return isOnline && !alreadyHasIt;
        });

        if (eligibleDestinations.length === 0) {
          console.warn(`[RECOVERY WARNING] Chunk ${chunk.chunkId} is under-replicated (${onlineHosts.length}/${REPLICATION_FACTOR}), but no eligible nodes available.`);
          continue;
        }

        const targetNodes = eligibleDestinations.slice(0, copiesNeeded);
        const sourceNode = STORAGE_NODES.find(n => n.id === onlineHosts[0]);

        for (const targetNode of targetNodes) {
          console.log(`[RECOVERY] Copying chunk ${chunk.chunkId} from ${sourceNode.id} to ${targetNode.id}...`);
          try {
            const readRes = await fetch(`${sourceNode.url}/chunks/${chunk.chunkId}`, { signal: AbortSignal.timeout(3000) });
            if (!readRes.ok) throw new Error(`Read failed: ${readRes.status}`);
            const chunkBuffer = Buffer.from(await readRes.arrayBuffer());

            const formData = new FormData();
            formData.append('file', new Blob([chunkBuffer], { type: 'application/octet-stream' }), `chunk_${chunk.chunkId}.bin`);
            const uploadRes = await fetch(`${targetNode.url}/chunks/${chunk.chunkId}`, { method: 'POST', body: formData, signal: AbortSignal.timeout(3000) });
            if (!uploadRes.ok) throw new Error(`Write failed: ${uploadRes.status}`);

            await db.addChunkLocation(chunk.chunkId, targetNode.id);
            onlineHosts.push(targetNode.id);
            // Update in-memory count immediately
            if (nodeRegistry[targetNode.id]) nodeRegistry[targetNode.id].chunkCount++;
            console.log(`[RECOVERY SUCCESS] Chunk ${chunk.chunkId} now on Node: ${targetNode.id}`);
          } catch (err) {
            console.error(`[RECOVERY FAILED] Chunk ${chunk.chunkId} to ${targetNode.id}:`, err.message);
          }
        }

      // OVER-REPLICATION: more online copies than needed — prune surplus
      } else if (onlineHosts.length > REPLICATION_FACTOR) {
        // Always remove from the offline nodes' old locations first, then surplus online
        const toRemove = [...offlineHosts, ...onlineHosts.slice(REPLICATION_FACTOR)];

        for (const nodeId of toRemove) {
          const targetNode = STORAGE_NODES.find(n => n.id === nodeId);
          if (!targetNode) continue;
          const isOnline = nodeRegistry[nodeId]?.status === 'ONLINE' && !nodeRegistry[nodeId]?.simulatedFailure;

          console.log(`[PRUNING] Removing surplus replica of chunk ${chunk.chunkId} from Node: ${nodeId}`);
          try {
            if (isOnline) {
              // Only send HTTP DELETE if node is actually online
              const deleteRes = await fetch(`${targetNode.url}/chunks/${chunk.chunkId}`, { method: 'DELETE', signal: AbortSignal.timeout(3000) });
              if (!deleteRes.ok && deleteRes.status !== 404) throw new Error(`Delete returned ${deleteRes.status}`);
            }
            await db.deleteChunkLocation(chunk.chunkId, nodeId);
            // Update in-memory count immediately
            if (nodeRegistry[nodeId]) nodeRegistry[nodeId].chunkCount = Math.max(0, (nodeRegistry[nodeId].chunkCount || 1) - 1);
            console.log(`[PRUNING SUCCESS] Surplus replica removed from Node: ${nodeId}`);
          } catch (err) {
            console.error(`[PRUNING FAILED] Chunk ${chunk.chunkId} from ${nodeId}:`, err.message);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error during replica recovery cycle:', error.message);
  }
};

// Fallback JSON 404 handler for unknown API routes
app.use('/api', (req, res) => {
  res.status(404).json({ error: `API endpoint ${req.method} ${req.originalUrl} not found` });
});

// Initialize database
db.initializeDatabase()
  .then(() => {
    // scanAndRecover defined here so runReplicaRecovery is in scope
    const scanAndRecover = async () => {
      await scanNodesHealth();
      await runReplicaRecovery();
    };

    // Run immediately then every 5 seconds
    const runCycle = () => scanAndRecover().catch(err => console.error('[SCAN ERROR]', err.message, err.stack));
    runCycle();
    setInterval(runCycle, 5000);

    // Clean expired blacklisted tokens every hour
    setInterval(() => {
      db.cleanExpiredTokens().catch(err => console.error('[Auth] Token cleanup failed:', err.message));
    }, 60 * 60 * 1000);

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`CloudVault Coordinator running on port ${PORT}`);
      console.log(`Configured Replication Factor (N): ${REPLICATION_FACTOR}`);
    });
  })
  .catch(err => {
    console.error('Failed to start Coordinator. Database unavailable.', err);
    process.exit(1);
  });
