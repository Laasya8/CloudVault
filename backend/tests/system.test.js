const reqFetch = globalThis.fetch || ((...args) => import('node-fetch').then(({default: f}) => f(...args)));
const fetch = reqFetch;


const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTests() {
  console.log('===============================================================');
  console.log('     CLOUDVAULT AUTOMATED COMPREHENSIVE BACKEND TEST SUITE     ');
  console.log('===============================================================');

  const ts = Date.now();
  const emailA = `alice.suite${ts}@example.com`;
  const emailB = `bob.suite${ts}@example.com`;
  const password = 'Password123!';

  let tokenA = null;
  let tokenB = null;
  let userA = null;
  let userB = null;
  let fileA = null;
  let folderA = null;

  // TEST 1: User Registration
  console.log('\n[TEST 1] User Registration...');
  const regResA = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Alice Test Suite', email: emailA, password })
  });
  assert(regResA.status === 201, `Expected status 201 for registration, got ${regResA.status}`);
  const regDataA = await regResA.json();
  assert(regDataA.token, 'Registration must return a token');
  assert(regDataA.user && regDataA.user.email === emailA, 'Registration must return user profile without password_hash');
  assert(!regDataA.user.password_hash, 'Password hash must NOT be exposed in registration payload');
  tokenA = regDataA.token;
  userA = regDataA.user;
  console.log('  ✅ TEST 1 PASSED: User A registered successfully.');

  // TEST 2: Duplicate Email Registration Rejection
  console.log('\n[TEST 2] Duplicate Email Registration Rejection...');
  const dupRes = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Alice Impostor', email: emailA, password })
  });
  assert(dupRes.status === 409, `Expected status 409 for duplicate email, got ${dupRes.status}`);
  console.log('  ✅ TEST 2 PASSED: Duplicate email registration rejected with 409 Conflict.');

  // TEST 3: Login
  console.log('\n[TEST 3] User Login...');
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: emailA, password })
  });
  assert(loginRes.status === 200, `Expected status 200 for valid login, got ${loginRes.status}`);
  const loginData = await loginRes.json();
  assert(loginData.token, 'Login must return token');
  console.log('  ✅ TEST 3 PASSED: User logged in successfully and received JWT.');

  // TEST 4: Invalid Password Rejection
  console.log('\n[TEST 4] Invalid Password Rejection...');
  const invalidPassRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: emailA, password: 'WrongPassword999!' })
  });
  assert(invalidPassRes.status === 401, `Expected status 401 for invalid password, got ${invalidPassRes.status}`);
  console.log('  ✅ TEST 4 PASSED: Login with wrong password rejected with 401 Unauthorized.');

  // TEST 5: Unauthenticated Access Rejection
  console.log('\n[TEST 5] Unauthenticated Access Rejection...');
  const unauthRes = await fetch(`${BASE}/api/files`);
  assert(unauthRes.status === 401, `Expected status 401 for unauthenticated request, got ${unauthRes.status}`);
  console.log('  ✅ TEST 5 PASSED: Request without Authorization header rejected with 401 Unauthorized.');

  // Register User B for permission tests
  const regResB = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Bob Test Suite', email: emailB, password })
  });
  const regDataB = await regResB.json();
  tokenB = regDataB.token;
  userB = regDataB.user;

  // TEST 6: User A Uploading File
  console.log('\n[TEST 6] User A Uploading a File...');
  const boundary6 = '----TestBoundary' + Date.now();
  const fileContent6 = 'User A confidential document content - test suite ' + ts;
  const body6 = [
    `--${boundary6}`,
    'Content-Disposition: form-data; name="file"; filename="userA_secret.txt"',
    'Content-Type: text/plain',
    '',
    fileContent6,
    `--${boundary6}--`,
    ''
  ].join('\r\n');

  const upResA = await fetch(`${BASE}/api/upload`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${tokenA}`, 'Content-Type': `multipart/form-data; boundary=${boundary6}` },
    body: body6
  });
  assert(upResA.status === 201, `Expected status 201 for file upload, got ${upResA.status}`);
  fileA = await upResA.json();
  assert(fileA.id && fileA.userId === userA.userId, 'File metadata must be assigned to User A');
  console.log('  ✅ TEST 6 PASSED: User A uploaded file successfully (ID:', fileA.id, ').');

  // TEST 7: User B Being Unable to Access User A's Private File
  console.log('\n[TEST 7] User B Unable to Access User A\'s Private File...');
  const bAccessDl = await fetch(`${BASE}/api/download/${fileA.id}`, {
    headers: { 'Authorization': `Bearer ${tokenB}` }
  });
  assert(bAccessDl.status === 403, `Expected status 403 for unauthorized access, got ${bAccessDl.status}`);
  console.log('  ✅ TEST 7 PASSED: User B access attempt on User A\'s private file rejected with 403 Forbidden.');

  // TEST 8: User A Sharing a File with User B as Viewer
  console.log('\n[TEST 8] User A Sharing File with User B as Viewer...');
  const shareViewerRes = await fetch(`${BASE}/api/files/${fileA.id}/shares`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: emailB, permission: 'VIEWER' })
  });
  assert(shareViewerRes.status === 201, `Expected status 201 for sharing file, got ${shareViewerRes.status}`);
  console.log('  ✅ TEST 8 PASSED: User A shared file with User B as VIEWER.');

  // TEST 9: User B Successfully Downloading the Shared File
  console.log('\n[TEST 9] User B Successfully Downloading the Shared File...');
  const bDlShared = await fetch(`${BASE}/api/download/${fileA.id}`, {
    headers: { 'Authorization': `Bearer ${tokenB}` }
  });
  assert(bDlShared.status === 200, `Expected status 200 for VIEWER download, got ${bDlShared.status}`);
  const downloadedText = await bDlShared.text();
  assert(downloadedText === fileContent6, 'Downloaded content must match uploaded file content');
  console.log('  ✅ TEST 9 PASSED: User B downloaded shared file successfully and content matches 100%.');

  // TEST 10: User B Being Unable to Modify it as Viewer
  console.log('\n[TEST 10] User B Unable to Modify File as Viewer...');
  const bRenameAttempt = await fetch(`${BASE}/api/files/${fileA.id}/rename`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'hacked_by_viewer.txt' })
  });
  assert(bRenameAttempt.status === 403, `Expected status 403 for VIEWER rename attempt, got ${bRenameAttempt.status}`);

  const bDeleteAttempt = await fetch(`${BASE}/api/files/${fileA.id}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${tokenB}` }
  });
  assert(bDeleteAttempt.status === 403, `Expected status 403 for VIEWER delete attempt, got ${bDeleteAttempt.status}`);
  console.log('  ✅ TEST 10 PASSED: User B (VIEWER) modification and deletion attempts rejected with 403 Forbidden.');

  // TEST 11: User A Sharing a Folder with User B as Editor
  console.log('\n[TEST 11] User A Sharing Folder as Editor...');
  const createFolderRes = await fetch(`${BASE}/api/folders`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Team Project Folder' })
  });
  folderA = await createFolderRes.json();

  const shareEditorRes = await fetch(`${BASE}/api/folders/${folderA.id}/shares`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: emailB, permission: 'EDITOR' })
  });
  assert(shareEditorRes.status === 201, `Expected status 201 for folder share, got ${shareEditorRes.status}`);
  console.log('  ✅ TEST 11 PASSED: User A shared folder with User B as EDITOR.');

  // TEST 12: Editor Modifying / Uploading a New Version into Shared Folder
  console.log('\n[TEST 12] Editor Uploading New File into Shared Folder...');
  const boundary12 = '----EditorBoundary' + Date.now();
  const body12 = [
    `--${boundary12}`,
    'Content-Disposition: form-data; name="file"; filename="editor_addition.txt"',
    'Content-Type: text/plain',
    '',
    'File uploaded by EDITOR user B',
    `--${boundary12}`,
    'Content-Disposition: form-data; name="folderId"',
    '',
    folderA.id,
    `--${boundary12}--`,
    ''
  ].join('\r\n');

  const editorUpRes = await fetch(`${BASE}/api/upload`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${tokenB}`, 'Content-Type': `multipart/form-data; boundary=${boundary12}` },
    body: body12
  });
  assert(editorUpRes.status === 201, `Expected status 201 for EDITOR upload, got ${editorUpRes.status}`);
  const editorFile = await editorUpRes.json();
  assert(editorFile.folderId === folderA.id, 'File must be stored in the shared folder');
  console.log('  ✅ TEST 12 PASSED: User B (EDITOR) uploaded file into shared folder successfully.');

  // TEST 13: Owner Revoking Access
  console.log('\n[TEST 13] Owner Revoking Access...');
  const revokeRes = await fetch(`${BASE}/api/files/${fileA.id}/shares/${userB.userId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${tokenA}` }
  });
  assert(revokeRes.status === 200, `Expected status 200 for share revocation, got ${revokeRes.status}`);
  console.log('  ✅ TEST 13 PASSED: Owner (User A) revoked User B\'s file share access.');

  // TEST 14: User B Losing Access After Revocation
  console.log('\n[TEST 14] User B Losing Access After Revocation...');
  const postRevokeDl = await fetch(`${BASE}/api/download/${fileA.id}`, {
    headers: { 'Authorization': `Bearer ${tokenB}` }
  });
  assert(postRevokeDl.status === 403, `Expected status 403 after revocation, got ${postRevokeDl.status}`);
  console.log('  ✅ TEST 14 PASSED: User B download attempt after revocation rejected with 403 Forbidden.');

  // TEST 15: Unauthorized Direct API Access Being Rejected
  console.log('\n[TEST 15] Unauthorized Direct API Access Being Rejected...');
  const fakeTokenRes = await fetch(`${BASE}/api/files`, {
    headers: { 'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fakeToken.Signature' }
  });
  assert(fakeTokenRes.status === 401, `Expected status 401 for fake JWT token, got ${fakeTokenRes.status}`);
  console.log('  ✅ TEST 15 PASSED: Unauthorized request with invalid JWT signature rejected with 401.');

  // TEST 16: Existing Chunk / Deduplication / Replication Functionality Continuing to Work
  console.log('\n[TEST 16] Deduplication & Replication System Integrity Check...');
  const boundary16 = '----DedupBoundary' + Date.now();
  // Upload file with EXACT same content as TEST 6
  const body16 = [
    `--${boundary16}`,
    'Content-Disposition: form-data; name="file"; filename="duplicate_content_copy.txt"',
    'Content-Type: text/plain',
    '',
    fileContent6,
    `--${boundary16}--`,
    ''
  ].join('\r\n');

  const dedupRes = await fetch(`${BASE}/api/upload`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${tokenA}`, 'Content-Type': `multipart/form-data; boundary=${boundary16}` },
    body: body16
  });
  assert(dedupRes.status === 201, `Expected status 201 for duplicate upload, got ${dedupRes.status}`);
  const dedupFile = await dedupRes.json();
  assert(dedupFile.reusedChunksCount === 1, `Expected reusedChunksCount to be 1 for deduplication, got ${dedupFile.reusedChunksCount}`);
  assert(dedupFile.chunks && dedupFile.chunks[0].nodeIds.length >= 2, 'File chunks must be replicated across nodes according to N=2 replication factor');
  console.log('  ✅ TEST 16 PASSED: 100% Chunk deduplication and N=2 replication verified.');

  console.log('\n===============================================================');
  console.log('  🎉 ALL 16 BACKEND AUTOMATED TESTS PASSED 100% SUCCESSFULLY!   ');
  console.log('===============================================================');
}

runTests().catch(err => {
  console.error('TEST RUN FAILURE:', err);
  process.exit(1);
});
