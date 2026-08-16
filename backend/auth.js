const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'cloudvault-dev-secret-change-in-production';
const ACCESS_TOKEN_TTL = '7d';
const ACCESS_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days in seconds

/**
 * Signs a JWT access token for a user.
 * Includes a unique `jti` so the token can be blacklisted on logout.
 */
const signToken = (user) => {
  const jti = crypto.randomUUID();
  const token = jwt.sign(
    {
      jti,
      sub: user.user_id,
      name: user.name,
      email: user.email,
    },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
  return { token, jti };
};

/**
 * Verifies a JWT and returns the decoded payload.
 * Throws if invalid or expired.
 */
const verifyToken = (token) => {
  return jwt.verify(token, JWT_SECRET);
};

/**
 * Express middleware: authenticate incoming requests.
 * Extracts Bearer token, verifies it, checks blacklist, attaches req.user.
 */
const authenticate = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required. Please log in.' });
  }

  const token = authHeader.slice(7);

  let payload;
  try {
    payload = verifyToken(token);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token. Please log in again.' });
  }

  // Check if this token has been blacklisted (logged out)
  try {
    const blacklisted = await db.isTokenBlacklisted(payload.jti);
    if (blacklisted) {
      return res.status(401).json({ error: 'Token has been revoked. Please log in again.' });
    }
  } catch (err) {
    console.error('[Auth] Blacklist check failed:', err.message);
    return res.status(500).json({ error: 'Authentication service error.' });
  }

  // Attach user context to request
  req.user = {
    userId: payload.sub,
    name: payload.name,
    email: payload.email,
    jti: payload.jti,
    tokenExp: payload.exp,
  };

  next();
};

/**
 * Role Hierarchy Rank
 * OWNER (3) > EDITOR (2) > VIEWER (1)
 */
const ROLE_RANKS = {
  OWNER: 3,
  EDITOR: 2,
  VIEWER: 1,
};

const hasMinRole = (actualRole, minRole) => {
  if (!actualRole) return false;
  const actualRank = ROLE_RANKS[actualRole] || 0;
  const minRank = ROLE_RANKS[minRole] || 0;
  return actualRank >= minRank;
};

/**
 * Authorization Middleware: Enforce File Permissions on backend.
 * Checks that req.user has at least `minRole` ('VIEWER', 'EDITOR', or 'OWNER') for target file.
 * Fails fast with 403 BEFORE any backend operations or storage-node requests occur.
 */
const authorizeFile = (minRole = 'VIEWER') => async (req, res, next) => {
  const fileId = req.params.id || req.params.fileId;
  if (!fileId) {
    return res.status(400).json({ error: 'File ID parameter missing.' });
  }

  try {
    const fileMeta = await db.getFileMetadata(fileId);
    if (!fileMeta) {
      return res.status(404).json({ error: 'File not found.' });
    }

    const actualPerm = await db.getFilePermission(fileId, req.user.userId);
    if (!actualPerm || !hasMinRole(actualPerm, minRole)) {
      console.warn(`[Authorization Denied] User ${req.user.email} attempted action on File ${fileId} requiring ${minRole}, but has ${actualPerm || 'NONE'}`);
      return res.status(403).json({
        error: `Access denied. Operation requires ${minRole} permission on this file.`
      });
    }

    req.filePerm = actualPerm;
    req.fileMetadata = fileMeta;
    next();
  } catch (err) {
    console.error('[Authorization Error]', err.message);
    res.status(500).json({ error: 'Authorization check failed.' });
  }
};

/**
 * Authorization Middleware: Enforce Folder Permissions on backend.
 * Checks that req.user has at least `minRole` ('VIEWER', 'EDITOR', or 'OWNER') for target folder.
 * Fails fast with 403 BEFORE any backend operations occur.
 */
const authorizeFolder = (minRole = 'VIEWER') => async (req, res, next) => {
  let folderId = req.params.id || req.params.folderId || req.body.folderId || req.query.folderId;
  if (folderId === 'root' || folderId === '') folderId = null;

  if (!folderId) {
    // Root level folder operations
    return next();
  }

  try {
    const folder = await db.getFolderById(folderId);
    if (!folder) {
      return res.status(404).json({ error: 'Target folder not found.' });
    }

    const actualPerm = await db.getFolderPermission(folderId, req.user.userId);
    if (!actualPerm || !hasMinRole(actualPerm, minRole)) {
      console.warn(`[Authorization Denied] User ${req.user.email} attempted action on Folder ${folderId} requiring ${minRole}, but has ${actualPerm || 'NONE'}`);
      return res.status(403).json({
        error: `Access denied. Operation requires ${minRole} permission on this folder.`
      });
    }

    req.folderPerm = actualPerm;
    req.folderInfo = folder;
    next();
  } catch (err) {
    console.error('[Authorization Error]', err.message);
    res.status(500).json({ error: 'Folder authorization check failed.' });
  }
};

module.exports = {
  signToken,
  verifyToken,
  authenticate,
  authorizeFile,
  authorizeFolder,
  hasMinRole,
  ACCESS_TOKEN_TTL_SECONDS
};

