const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://cloudvault_user:cloudvault_password@localhost:5432/cloudvault_metadata';

const pool = new Pool({
  connectionString: DATABASE_URL,
});

// Helper for query execution
const query = (text, params) => pool.query(text, params);

/**
 * Robust connection setup with retries to handle container startup lag
 */
const initializeDatabase = async (retries = 5, delay = 3000) => {
  for (let i = 0; i < retries; i++) {
    try {
      const client = await pool.connect();
      client.release();
      console.log('Coordinator Database connected successfully.');
      await runMigrations();
      return;
    } catch (err) {
      console.log(`Coordinator DB connection failed (Attempt ${i + 1}/${retries}). Retrying in ${delay}ms...`);
      if (i === retries - 1) throw err;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

/**
 * Runs DDL statements to ensure schema tables exist.
 * Re-configures the chunks table to drop node_id, moving locations to chunk_locations table.
 */
const runMigrations = async () => {
  try {
    // 1. Create base tables
    await query(`
      CREATE TABLE IF NOT EXISTS files (
        id UUID PRIMARY KEY,
        filename VARCHAR(255) NOT NULL,
        size BIGINT NOT NULL,
        mime_type VARCHAR(100),
        uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id UUID PRIMARY KEY,
        chunk_hash VARCHAR(64) UNIQUE NOT NULL,
        size INT NOT NULL
      );
    `);

    // 2. Safely migrate/alter chunks if node_id column exists from prior phases
    await query(`
      ALTER TABLE chunks DROP COLUMN IF EXISTS node_id;
    `);

    // 3. Create chunk locations junction table
    await query(`
      CREATE TABLE IF NOT EXISTS chunk_locations (
        chunk_id UUID REFERENCES chunks(id) ON DELETE CASCADE,
        node_id VARCHAR(50) NOT NULL,
        PRIMARY KEY (chunk_id, node_id)
      );

      CREATE TABLE IF NOT EXISTS file_chunks (
        file_id UUID REFERENCES files(id) ON DELETE CASCADE,
        chunk_id UUID REFERENCES chunks(id) ON DELETE CASCADE,
        sequence_number INT NOT NULL,
        PRIMARY KEY (file_id, sequence_number)
      );
    `);

    // 4. Phase 6: Users & Auth tables
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS invalidated_tokens (
        jti UUID PRIMARY KEY,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL
      );
    `);

    // 5. Add user_id FK to files (nullable — legacy files stay visible only to owner)
    await query(`
      ALTER TABLE files ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(user_id) ON DELETE SET NULL;
    `);

    // 6. Folders table & file folder_id FK
    await query(`
      CREATE TABLE IF NOT EXISTS folders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(255) NOT NULL,
        parent_id UUID REFERENCES folders(id) ON DELETE CASCADE,
        owner_id UUID REFERENCES users(user_id) ON DELETE CASCADE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE files ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES folders(id) ON DELETE SET NULL;
    `);

    // 7. Shares & Permissions tables
    await query(`
      CREATE TABLE IF NOT EXISTS file_shares (
        share_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        file_id UUID REFERENCES files(id) ON DELETE CASCADE NOT NULL,
        shared_with_user_id UUID REFERENCES users(user_id) ON DELETE CASCADE NOT NULL,
        permission VARCHAR(20) NOT NULL CHECK (permission IN ('EDITOR', 'VIEWER')),
        created_by UUID REFERENCES users(user_id) ON DELETE CASCADE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(file_id, shared_with_user_id)
      );

      CREATE TABLE IF NOT EXISTS folder_shares (
        share_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        folder_id UUID REFERENCES folders(id) ON DELETE CASCADE NOT NULL,
        shared_with_user_id UUID REFERENCES users(user_id) ON DELETE CASCADE NOT NULL,
        permission VARCHAR(20) NOT NULL CHECK (permission IN ('EDITOR', 'VIEWER')),
        created_by UUID REFERENCES users(user_id) ON DELETE CASCADE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(folder_id, shared_with_user_id)
      );
    `);

    console.log('Database schema migrations applied successfully.');
  } catch (error) {
    console.error('Error running database migrations:', error);
    throw error;
  }
};

/**
 * Checks if a chunk hash already exists in the database.
 * Returns the chunk details (UUID and associated node locations) if it exists, otherwise null.
 */
const getChunkIdByHash = async (hash) => {
  const selectQuery = 'SELECT id FROM chunks WHERE chunk_hash = $1';
  const result = await query(selectQuery, [hash]);
  if (result.rows.length > 0) {
    const chunkId = result.rows[0].id;
    
    // Fetch registered locations
    const locRes = await query('SELECT node_id FROM chunk_locations WHERE chunk_id = $1', [chunkId]);
    return {
      id: chunkId,
      nodeIds: locRes.rows.map(row => row.node_id)
    };
  }
  return null;
};

/**
 * Creates records for a file and its associated chunks inside a transaction.
 * Reuses existing chunk IDs and locations for duplicate hashes.
 */
const saveFileMetadata = async (fileMetadata) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Insert into files table
    const fileInsertText = `
      INSERT INTO files (id, filename, size, mime_type, uploaded_at, user_id, folder_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;
    const fileInsertParams = [
      fileMetadata.id,
      fileMetadata.filename,
      fileMetadata.size,
      fileMetadata.mimeType,
      fileMetadata.uploadedAt,
      fileMetadata.userId || null,
      fileMetadata.folderId || null
    ];
    await client.query(fileInsertText, fileInsertParams);

    // 2. Process chunks
    for (let idx = 0; idx < fileMetadata.chunks.length; idx++) {
      const chunk = fileMetadata.chunks[idx];

      // Check if this chunk hash already exists
      const checkRes = await client.query('SELECT id FROM chunks WHERE chunk_hash = $1', [chunk.hash]);
      let chunkId;

      if (checkRes.rows.length > 0) {
        // Chunk exists - reuse database row
        chunkId = checkRes.rows[0].id;
      } else {
        // Chunk is new - insert row
        chunkId = chunk.id;
        const chunkInsertText = `
          INSERT INTO chunks (id, chunk_hash, size)
          VALUES ($1, $2, $3)
        `;
        await client.query(chunkInsertText, [chunkId, chunk.hash, chunk.size]);
      }

      // Always ensure location mapping exists for the chunk replicas
      if (Array.isArray(chunk.nodeIds)) {
        for (const nodeId of chunk.nodeIds) {
          const locInsertText = `
            INSERT INTO chunk_locations (chunk_id, node_id)
            VALUES ($1, $2)
            ON CONFLICT (chunk_id, node_id) DO NOTHING
          `;
          await client.query(locInsertText, [chunkId, nodeId]);
        }
      }

      // 3. Insert relationship mapping
      const mappingInsertText = `
        INSERT INTO file_chunks (file_id, chunk_id, sequence_number)
        VALUES ($1, $2, $3)
      `;
      await client.query(mappingInsertText, [fileMetadata.id, chunkId, idx]);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Transaction rollback due to error:', error);
    throw error;
  } finally {
    client.release();
  }
};

/**
 * Retrieves the complete file metadata and list of chunk IDs and node locations in order
 */
/**
 * Retrieves the complete file metadata and list of chunk IDs and node locations in order
 */
const getFileMetadata = async (fileId) => {
  const fileQuery = 'SELECT * FROM files WHERE id = $1';
  const fileResult = await query(fileQuery, [fileId]);

  if (fileResult.rows.length === 0) {
    return null;
  }

  const fileInfo = fileResult.rows[0];

  // Retrieve matching chunks with aggregated array of host node IDs (LEFT JOIN so missing locations don't drop chunks)
  const chunksQuery = `
    SELECT c.id, c.chunk_hash, c.size, 
           COALESCE(array_agg(cl.node_id) FILTER (WHERE cl.node_id IS NOT NULL), '{}') as node_ids
    FROM chunks c
    JOIN file_chunks fc ON c.id = fc.chunk_id
    LEFT JOIN chunk_locations cl ON c.id = cl.chunk_id
    WHERE fc.file_id = $1
    GROUP BY c.id, fc.sequence_number
    ORDER BY fc.sequence_number ASC
  `;
  const chunksResult = await query(chunksQuery, [fileId]);

  return {
    id: fileInfo.id,
    filename: fileInfo.filename,
    mimeType: fileInfo.mime_type,
    size: parseInt(fileInfo.size, 10),
    uploadedAt: fileInfo.uploaded_at,
    userId: fileInfo.user_id,
    folderId: fileInfo.folder_id,
    chunks: chunksResult.rows.map(row => ({
      id: row.id,
      hash: row.chunk_hash,
      size: row.size,
      nodeIds: row.node_ids || []
    }))
  };
};

/**
 * Deletes file metadata and returns chunk details (ID & node locations) 
 * that are no longer referenced by ANY file so they can be deleted from disk on nodes.
 */
const deleteFileMetadata = async (fileId) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Verify file exists in files table first
    const fileCheck = await client.query('SELECT id FROM files WHERE id = $1', [fileId]);
    if (fileCheck.rows.length === 0) {
      await client.query('COMMIT');
      return null; // File truly does not exist
    }

    // 2. Get all chunks currently associated with this file along with their node locations (LEFT JOIN)
    const getChunksQuery = `
      SELECT fc.chunk_id, COALESCE(array_agg(cl.node_id) FILTER (WHERE cl.node_id IS NOT NULL), '{}') as node_ids
      FROM file_chunks fc
      LEFT JOIN chunk_locations cl ON fc.chunk_id = cl.chunk_id
      WHERE fc.file_id = $1
      GROUP BY fc.chunk_id
    `;
    const chunksRes = await client.query(getChunksQuery, [fileId]);
    const fileChunks = chunksRes.rows.map(row => ({ id: row.chunk_id, nodeIds: row.node_ids || [] }));

    // 3. Delete the file record (automatically cascades to delete file_chunks and share mapping rows)
    await client.query('DELETE FROM files WHERE id = $1', [fileId]);

    // 4. Determine which chunks are now orphaned (not referenced in file_chunks junction table anymore)
    const orphanedChunks = [];
    for (const chunk of fileChunks) {
      const refCheckRes = await client.query('SELECT 1 FROM file_chunks WHERE chunk_id = $1 LIMIT 1', [chunk.id]);
      if (refCheckRes.rows.length === 0) {
        orphanedChunks.push(chunk);
      }
    }

    // 5. Delete orphaned chunk records from database (cascades to chunk_locations table)
    if (orphanedChunks.length > 0) {
      const orphanedIds = orphanedChunks.map(c => c.id);
      const placeholders = orphanedIds.map((_, i) => `$${i + 1}`).join(',');
      await client.query(`DELETE FROM chunks WHERE id IN (${placeholders})`, orphanedIds);
    }

    await client.query('COMMIT');
    return orphanedChunks; // Return list of { id, nodeIds } to trigger HTTP DELETE calls
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Delete transaction rollback:', error);
    throw error;
  } finally {
    client.release();
  }
};

/**
 * Lists files belonging to a specific user (optionally filtered by folderId)
 */
const listFiles = async (userId, folderId = undefined) => {
  let listQuery = 'SELECT id, filename, size, mime_type as "mimeType", uploaded_at as "uploadedAt", user_id as "userId", folder_id as "folderId" FROM files WHERE 1=1';
  const params = [];

  if (userId) {
    params.push(userId);
    listQuery += ` AND user_id = $${params.length}`;
  }

  if (folderId !== undefined) {
    if (folderId === null || folderId === 'root') {
      listQuery += ` AND folder_id IS NULL`;
    } else {
      params.push(folderId);
      listQuery += ` AND folder_id = $${params.length}`;
    }
  }

  listQuery += ' ORDER BY uploaded_at DESC';
  const result = await query(listQuery, params);
  return result.rows;
};

/**
 * Retrieves all registered chunk IDs and their host node locations
 */
const getAllChunkLocations = async () => {
  // Only return chunks that belong to an active file to avoid processing orphaned locations
  const selectQuery = `
    SELECT cl.chunk_id as "chunkId", array_agg(cl.node_id) as "nodeIds"
    FROM chunk_locations cl
    INNER JOIN chunks c ON c.id = cl.chunk_id
    INNER JOIN file_chunks fc ON fc.chunk_id = c.id
    INNER JOIN files f ON f.id = fc.file_id
    GROUP BY cl.chunk_id
  `;
  const result = await query(selectQuery);
  return result.rows;
};

/**
 * Inserts a new chunk replica location mapping
 */
const addChunkLocation = async (chunkId, nodeId) => {
  const insertText = `
    INSERT INTO chunk_locations (chunk_id, node_id)
    VALUES ($1, $2)
    ON CONFLICT (chunk_id, node_id) DO NOTHING
  `;
  await query(insertText, [chunkId, nodeId]);
};

/**
 * Deletes a chunk replica location mapping
 */
const deleteChunkLocation = async (chunkId, nodeId) => {
  const deleteText = `
    DELETE FROM chunk_locations 
    WHERE chunk_id = $1 AND node_id = $2
  `;
  await query(deleteText, [chunkId, nodeId]);
};

// ─── User helpers ────────────────────────────────────────────────────────────

/**
 * Creates a new user record.
 */
const createUser = async ({ name, email, passwordHash }) => {
  const result = await query(
    `INSERT INTO users (name, email, password_hash)
     VALUES ($1, $2, $3)
     RETURNING user_id, name, email, created_at`,
    [name, email, passwordHash]
  );
  return result.rows[0];
};

/**
 * Finds a user by email. Returns null if not found.
 */
const getUserByEmail = async (email) => {
  const result = await query('SELECT * FROM users WHERE email = $1', [email]);
  return result.rows[0] || null;
};

/**
 * Finds a user by user_id. Returns null if not found.
 */
const getUserById = async (userId) => {
  const result = await query(
    'SELECT user_id, name, email, created_at FROM users WHERE user_id = $1',
    [userId]
  );
  return result.rows[0] || null;
};

// ─── Token blacklist helpers ──────────────────────────────────────────────────

/**
 * Adds a JWT's jti to the blacklist so it cannot be reused after logout.
 */
const invalidateToken = async (jti, expiresAt) => {
  await query(
    `INSERT INTO invalidated_tokens (jti, expires_at) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [jti, expiresAt]
  );
};

/**
 * Returns true if the given jti has been invalidated (logged out).
 */
const isTokenBlacklisted = async (jti) => {
  const result = await query(
    'SELECT 1 FROM invalidated_tokens WHERE jti = $1 AND expires_at > NOW()',
    [jti]
  );
  return result.rows.length > 0;
};

/**
 * Removes expired tokens from the blacklist to keep the table lean.
 */
const cleanExpiredTokens = async () => {
  await query('DELETE FROM invalidated_tokens WHERE expires_at <= NOW()');
};

// ─── Folder helpers ──────────────────────────────────────────────────────────

/**
 * Creates a new folder record.
 */
const createFolder = async ({ name, parentId, ownerId }) => {
  const result = await query(
    `INSERT INTO folders (name, parent_id, owner_id)
     VALUES ($1, $2, $3)
     RETURNING id, name, parent_id as "parentId", owner_id as "ownerId", created_at as "createdAt"`,
    [name, parentId || null, ownerId]
  );
  return result.rows[0];
};

/**
 * Retrieves a folder by ID. Returns null if not found.
 */
const getFolderById = async (folderId) => {
  const result = await query(
    `SELECT id, name, parent_id as "parentId", owner_id as "ownerId", created_at as "createdAt"
     FROM folders WHERE id = $1`,
    [folderId]
  );
  return result.rows[0] || null;
};

/**
 * Lists folders owned by a specific user (optionally under parentId).
 */
const listFolders = async (ownerId, parentId = undefined) => {
  let q = `SELECT id, name, parent_id as "parentId", owner_id as "ownerId", created_at as "createdAt"
           FROM folders WHERE owner_id = $1`;
  const params = [ownerId];

  if (parentId !== undefined) {
    if (parentId === null || parentId === 'root') {
      q += ` AND parent_id IS NULL`;
    } else {
      params.push(parentId);
      q += ` AND parent_id = $${params.length}`;
    }
  }

  q += ' ORDER BY name ASC';
  const result = await query(q, params);
  return result.rows;
};

/**
 * Deletes a folder owned by ownerId. Returns deleted folder or null.
 */
const deleteFolder = async (folderId, ownerId) => {
  const folder = await getFolderById(folderId);
  if (!folder || folder.ownerId !== ownerId) return null;

  // First fetch files in folder and orphaned chunks to clean storage nodes
  const filesInFolder = await query('SELECT id FROM files WHERE folder_id = $1', [folderId]);
  for (const row of filesInFolder.rows) {
    await deleteFileMetadata(row.id);
  }

  const result = await query(
    `DELETE FROM folders WHERE id = $1 AND owner_id = $2 RETURNING id`,
    [folderId, ownerId]
  );
  return result.rows[0] || null;
};

// ─── Sharing & Permissions ───────────────────────────────────────────────────

/**
 * Resolves a user's permission for a folder.
 * Returns 'OWNER', 'EDITOR', 'VIEWER', or null.
 * Traverses parent folders recursively to support permission inheritance.
 */
const getFolderPermission = async (folderId, userId) => {
  if (!folderId || !userId) return null;

  let currentId = folderId;
  let highestPermission = null;

  const rank = { 'OWNER': 3, 'EDITOR': 2, 'VIEWER': 1 };

  while (currentId) {
    const fRes = await query(
      `SELECT id, name, parent_id as "parentId", owner_id as "ownerId" FROM folders WHERE id = $1`,
      [currentId]
    );
    if (fRes.rows.length === 0) break;
    const folder = fRes.rows[0];

    // If owner, return OWNER immediately
    if (folder.ownerId === userId) return 'OWNER';

    // Check folder_shares for this level
    const sRes = await query(
      `SELECT permission FROM folder_shares WHERE folder_id = $1 AND shared_with_user_id = $2`,
      [currentId, userId]
    );
    if (sRes.rows.length > 0) {
      const perm = sRes.rows[0].permission;
      if (!highestPermission || rank[perm] > rank[highestPermission]) {
        highestPermission = perm;
      }
    }

    currentId = folder.parentId;
  }

  return highestPermission;
};

/**
 * Resolves a user's permission for a file.
 * Returns 'OWNER', 'EDITOR', 'VIEWER', or null.
 * Checks direct ownership, direct file share, and inherited folder shares.
 */
const getFilePermission = async (fileId, userId) => {
  if (!fileId || !userId) return null;

  const fRes = await query(`SELECT user_id, folder_id FROM files WHERE id = $1`, [fileId]);
  if (fRes.rows.length === 0) return null;
  const file = fRes.rows[0];

  // 1. Direct Owner check
  if (file.user_id === userId) return 'OWNER';

  let highestPermission = null;
  const rank = { 'OWNER': 3, 'EDITOR': 2, 'VIEWER': 1 };

  // 2. Direct File Share check
  const sRes = await query(
    `SELECT permission FROM file_shares WHERE file_id = $1 AND shared_with_user_id = $2`,
    [fileId, userId]
  );
  if (sRes.rows.length > 0) {
    highestPermission = sRes.rows[0].permission;
  }

  // 3. Inherited Folder Share check (if file is inside a folder)
  if (file.folder_id) {
    const folderPerm = await getFolderPermission(file.folder_id, userId);
    if (folderPerm) {
      if (!highestPermission || rank[folderPerm] > rank[highestPermission]) {
        highestPermission = folderPerm;
      }
    }
  }

  return highestPermission;
};

/**
 * Shares a file with another user
 */
const shareFile = async ({ fileId, sharedWithUserId, permission, createdBy }) => {
  const result = await query(
    `INSERT INTO file_shares (file_id, shared_with_user_id, permission, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (file_id, shared_with_user_id) DO UPDATE SET permission = EXCLUDED.permission
     RETURNING share_id as "shareId", file_id as "fileId", shared_with_user_id as "sharedWithUserId", permission, created_at as "createdAt"`,
    [fileId, sharedWithUserId, permission, createdBy]
  );
  return result.rows[0];
};

/**
 * Unshares a file
 */
const unshareFile = async (fileId, sharedWithUserId) => {
  await query(`DELETE FROM file_shares WHERE file_id = $1 AND shared_with_user_id = $2`, [fileId, sharedWithUserId]);
};

/**
 * Gets all share records for a file (including user details)
 */
const getFileShares = async (fileId) => {
  const result = await query(
    `SELECT fs.share_id as "shareId", fs.file_id as "fileId", fs.shared_with_user_id as "sharedWithUserId",
            fs.permission, fs.created_at as "createdAt", u.name as "userName", u.email as "userEmail"
     FROM file_shares fs
     JOIN users u ON u.user_id = fs.shared_with_user_id
     WHERE fs.file_id = $1`,
    [fileId]
  );
  return result.rows;
};

/**
 * Shares a folder with another user
 */
const shareFolder = async ({ folderId, sharedWithUserId, permission, createdBy }) => {
  const result = await query(
    `INSERT INTO folder_shares (folder_id, shared_with_user_id, permission, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (folder_id, shared_with_user_id) DO UPDATE SET permission = EXCLUDED.permission
     RETURNING share_id as "shareId", folder_id as "folderId", shared_with_user_id as "sharedWithUserId", permission, created_at as "createdAt"`,
    [folderId, sharedWithUserId, permission, createdBy]
  );
  return result.rows[0];
};

/**
 * Unshares a folder
 */
const unshareFolder = async (folderId, sharedWithUserId) => {
  await query(`DELETE FROM folder_shares WHERE folder_id = $1 AND shared_with_user_id = $2`, [folderId, sharedWithUserId]);
};

/**
 * Gets all share records for a folder
 */
const getFolderShares = async (folderId) => {
  const result = await query(
    `SELECT fs.share_id as "shareId", fs.folder_id as "folderId", fs.shared_with_user_id as "sharedWithUserId",
            fs.permission, fs.created_at as "createdAt", u.name as "userName", u.email as "userEmail"
     FROM folder_shares fs
     JOIN users u ON u.user_id = fs.shared_with_user_id
     WHERE fs.folder_id = $1`,
    [folderId]
  );
  return result.rows;
};

/**
 * Lists items (files and folders) shared with a specific user
 */
const listSharedWithMe = async (userId) => {
  // Shared Files directly
  const sharedFilesRes = await query(
    `SELECT f.id, f.filename, f.size, f.mime_type as "mimeType", f.uploaded_at as "uploadedAt",
            f.user_id as "userId", fs.permission, u.name as "ownerName"
     FROM files f
     JOIN file_shares fs ON f.id = fs.file_id
     JOIN users u ON u.user_id = f.user_id
     WHERE fs.shared_with_user_id = $1`,
    [userId]
  );

  // Shared Folders directly
  const sharedFoldersRes = await query(
    `SELECT fd.id, fd.name, fd.parent_id as "parentId", fd.owner_id as "ownerId",
            fs.permission, u.name as "ownerName"
     FROM folders fd
     JOIN folder_shares fs ON fd.id = fs.folder_id
     JOIN users u ON u.user_id = fd.owner_id
     WHERE fs.shared_with_user_id = $1`,
    [userId]
  );

  return {
    files: sharedFilesRes.rows,
    folders: sharedFoldersRes.rows
  };
};

/**
 * Renames a file
 */
const renameFile = async (fileId, newName) => {
  const result = await query(
    `UPDATE files SET filename = $1 WHERE id = $2 RETURNING id, filename`,
    [newName, fileId]
  );
  return result.rows[0];
};

module.exports = {
  initializeDatabase,
  getChunkIdByHash,
  saveFileMetadata,
  getFileMetadata,
  deleteFileMetadata,
  listFiles,
  getAllChunkLocations,
  addChunkLocation,
  deleteChunkLocation,
  // Auth
  createUser,
  getUserByEmail,
  getUserById,
  invalidateToken,
  isTokenBlacklisted,
  cleanExpiredTokens,
  // Folders
  createFolder,
  getFolderById,
  listFolders,
  deleteFolder,
  // Sharing & Permissions
  getFolderPermission,
  getFilePermission,
  shareFile,
  unshareFile,
  getFileShares,
  shareFolder,
  unshareFolder,
  getFolderShares,
  listSharedWithMe,
  renameFile,
};
