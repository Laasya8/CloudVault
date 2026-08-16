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
      console.log('Database connected successfully.');
      await runMigrations();
      return;
    } catch (err) {
      console.log(`Database connection failed (Attempt ${i + 1}/${retries}). Retrying in ${delay}ms...`);
      if (i === retries - 1) throw err;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

/**
 * Runs DDL statements to ensure schema tables exist
 */
const runMigrations = async () => {
  const schemaSQL = `
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

    CREATE TABLE IF NOT EXISTS file_chunks (
      file_id UUID REFERENCES files(id) ON DELETE CASCADE,
      chunk_id UUID REFERENCES chunks(id) ON DELETE CASCADE,
      sequence_number INT NOT NULL,
      PRIMARY KEY (file_id, sequence_number)
    );
  `;
  try {
    await query(schemaSQL);
    console.log('Database schema migrations applied successfully.');
  } catch (error) {
    console.error('Error running database migrations:', error);
    throw error;
  }
};

/**
 * Checks if a chunk hash already exists in the database.
 * Returns the chunk's UUID if it exists, otherwise null.
 */
const getChunkIdByHash = async (hash) => {
  const selectQuery = 'SELECT id FROM chunks WHERE chunk_hash = $1';
  const result = await query(selectQuery, [hash]);
  return result.rows.length > 0 ? result.rows[0].id : null;
};

/**
 * Creates records for a file and its associated chunks inside a transaction.
 * Reuses existing chunk IDs for chunks that match in hash (deduplication).
 */
const saveFileMetadata = async (fileMetadata) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Insert into files table
    const fileInsertText = `
      INSERT INTO files (id, filename, size, mime_type, uploaded_at)
      VALUES ($1, $2, $3, $4, $5)
    `;
    const fileInsertParams = [
      fileMetadata.id,
      fileMetadata.filename,
      fileMetadata.mimeType,
      fileMetadata.size,
      fileMetadata.uploadedAt
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
 * Retrieves the complete file metadata and list of chunk IDs in order
 */
const getFileMetadata = async (fileId) => {
  const fileQuery = 'SELECT * FROM files WHERE id = $1';
  const fileResult = await query(fileQuery, [fileId]);

  if (fileResult.rows.length === 0) {
    return null;
  }

  const fileInfo = fileResult.rows[0];

  // Retrieve matching chunks ordered by their sequence number
  const chunksQuery = `
    SELECT c.id, c.chunk_hash, c.size
    FROM chunks c
    JOIN file_chunks fc ON c.id = fc.chunk_id
    WHERE fc.file_id = $1
    ORDER BY fc.sequence_number ASC
  `;
  const chunksResult = await query(chunksQuery, [fileId]);

  return {
    id: fileInfo.id,
    filename: fileInfo.filename,
    mimeType: fileInfo.mime_type,
    size: parseInt(fileInfo.size, 10),
    uploadedAt: fileInfo.uploaded_at,
    chunks: chunksResult.rows.map(row => ({
      id: row.id,
      hash: row.chunk_hash,
      size: row.size
    }))
  };
};

/**
 * Deletes file metadata and returns chunk IDs that are no longer referenced by ANY file.
 * Orphaned chunk database records are cleaned up.
 */
const deleteFileMetadata = async (fileId) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Get all chunks currently associated with this file
    const getChunksQuery = `
      SELECT chunk_id FROM file_chunks WHERE file_id = $1
    `;
    const chunksRes = await client.query(getChunksQuery, [fileId]);
    const fileChunkIds = chunksRes.rows.map(row => row.chunk_id);

    if (fileChunkIds.length === 0) {
      await client.query('COMMIT');
      return null; // File not found or has no chunks
    }

    // 2. Delete the file record (automatically cascades to delete file_chunks mapping rows)
    await client.query('DELETE FROM files WHERE id = $1', [fileId]);

    // 3. Determine which chunks are now orphaned (not referenced in file_chunks junction table anymore)
    const orphanedChunkIds = [];
    for (const chunkId of fileChunkIds) {
      const refCheckRes = await client.query('SELECT 1 FROM file_chunks WHERE chunk_id = $1 LIMIT 1', [chunkId]);
      if (refCheckRes.rows.length === 0) {
        orphanedChunkIds.push(chunkId);
      }
    }

    // 4. Delete orphaned chunk records from database
    if (orphanedChunkIds.length > 0) {
      const placeholders = orphanedChunkIds.map((_, i) => `$${i + 1}`).join(',');
      await client.query(`DELETE FROM chunks WHERE id IN (${placeholders})`, orphanedChunkIds);
    }

    await client.query('COMMIT');
    return orphanedChunkIds; // Only delete these physical files from disk
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Delete transaction rollback:', error);
    throw error;
  } finally {
    client.release();
  }
};

module.exports = {
  initializeDatabase,
  getChunkIdByHash,
  saveFileMetadata,
  getFileMetadata,
  deleteFileMetadata,
};
