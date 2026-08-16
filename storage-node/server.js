const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5001;
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, 'data');

// Ensure storage directory exists
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

// Memory storage for incoming raw chunks
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());

// Log API actions
app.use((req, res, next) => {
  console.log(`[Storage Node] ${req.method} ${req.url}`);
  next();
});

/**
 * 1. Store Chunk
 * POST /chunks/:id
 */
app.post('/chunks/:id', upload.single('file'), (req, res) => {
  try {
    const chunkId = req.params.id;

    // Validate ID to protect against directory traversal
    if (!/^[a-f0-9-]{36}$/i.test(chunkId) && !/^[a-f0-9]{64}$/i.test(chunkId)) {
      return res.status(400).json({ error: 'Invalid chunk ID format' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No chunk file payload provided.' });
    }

    const chunkPath = path.join(STORAGE_DIR, `chunk_${chunkId}.bin`);
    fs.writeFileSync(chunkPath, req.file.buffer);

    console.log(`Stored chunk: chunk_${chunkId}.bin (${req.file.size} bytes)`);
    res.status(201).json({ id: chunkId, size: req.file.size });
  } catch (error) {
    console.error('Error storing chunk:', error);
    res.status(500).json({ error: 'Failed to write chunk to disk.' });
  }
});

/**
 * 2. Retrieve Chunk
 * GET /chunks/:id
 */
app.get('/chunks/:id', (req, res) => {
  try {
    const chunkId = req.params.id;

    if (!/^[a-f0-9-]{36}$/i.test(chunkId) && !/^[a-f0-9]{64}$/i.test(chunkId)) {
      return res.status(400).json({ error: 'Invalid chunk ID format' });
    }

    const chunkPath = path.join(STORAGE_DIR, `chunk_${chunkId}.bin`);

    if (!fs.existsSync(chunkPath)) {
      return res.status(404).json({ error: 'Chunk not found.' });
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', fs.statSync(chunkPath).size);

    const stream = fs.createReadStream(chunkPath);
    stream.pipe(res);
  } catch (error) {
    console.error('Error retrieving chunk:', error);
    res.status(500).json({ error: 'Failed to stream chunk.' });
  }
});

/**
 * 3. Delete Chunk
 * DELETE /chunks/:id
 */
app.delete('/chunks/:id', (req, res) => {
  try {
    const chunkId = req.params.id;

    if (!/^[a-f0-9-]{36}$/i.test(chunkId) && !/^[a-f0-9]{64}$/i.test(chunkId)) {
      return res.status(400).json({ error: 'Invalid chunk ID format' });
    }

    const chunkPath = path.join(STORAGE_DIR, `chunk_${chunkId}.bin`);

    if (!fs.existsSync(chunkPath)) {
      return res.status(404).json({ error: 'Chunk not found.' });
    }

    fs.unlinkSync(chunkPath);
    console.log(`Deleted chunk: chunk_${chunkId}.bin`);
    res.status(200).json({ message: 'Chunk deleted successfully' });
  } catch (error) {
    console.error('Error deleting chunk:', error);
    res.status(500).json({ error: 'Failed to delete chunk.' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  try {
    const files = fs.readdirSync(STORAGE_DIR);
    const chunkCount = files.filter(f => f.startsWith('chunk_') && f.endsWith('.bin')).length;
    res.status(200).json({
      status: 'OK',
      storageDir: STORAGE_DIR,
      chunkCount: chunkCount
    });
  } catch (error) {
    res.status(500).json({ status: 'ERROR', message: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CloudVault Storage Node listening on port ${PORT}`);
  console.log(`Storage data directory: ${STORAGE_DIR}`);
});
