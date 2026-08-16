// Auth storage and helper utilities for CloudVault

(() => {
  const TOKEN_KEY = 'cv_token';
  const USER_KEY = 'cv_user';

  // Determine API Base URL automatically.
  // If served from port 3000 (Express backend), relative URL '' is used.
  // If served from any other port (e.g., port 3001 via npx serve), fallback to http://localhost:3000
  const API_BASE = (window.location.port === '3000') 
    ? '' 
    : `${window.location.protocol === 'file:' ? 'http:' : window.location.protocol}//${window.location.hostname || 'localhost'}:3000`;

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  function getUser() {
    const data = localStorage.getItem(USER_KEY);
    try {
      return data ? JSON.parse(data) : null;
    } catch (e) {
      return null;
    }
  }

  function setAuth(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }

  function clearAuth() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  function requireAuth() {
    const token = getToken();
    if (!token) {
      window.location.href = 'login.html';
      return false;
    }
    return true;
  }

  /**
   * Fetch wrapper that automatically injects JWT Authorization header
   * and redirects to login if 401 Unauthenticated is returned.
   */
  async function authFetch(url, options = {}) {
    const token = getToken();
    const fullUrl = (url.startsWith('/api') && API_BASE) ? `${API_BASE}${url}` : url;
    
    const headers = new Headers(options.headers || {});
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    const config = {
      ...options,
      headers,
    };

    try {
      const response = await fetch(fullUrl, config);
      if (response.status === 401) {
        clearAuth();
        window.location.href = 'login.html';
        throw new Error('Session expired. Please log in again.');
      }
      return response;
    } catch (err) {
      throw err;
    }
  }

  async function logout() {
    try {
      await authFetch('/api/auth/logout', { method: 'POST' });
    } catch (e) {
      // Ignore error if server logout fails (e.g. network down)
    } finally {
      clearAuth();
      window.location.href = 'login.html';
    }
  }

  window.CloudVaultAuth = {
    API_BASE,
    getToken,
    getUser,
    setAuth,
    clearAuth,
    requireAuth,
    authFetch,
    logout
  };
})();

