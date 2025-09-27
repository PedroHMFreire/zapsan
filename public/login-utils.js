// login.js - Versão minimalista e moderna
(function() {
  'use strict';

  // Configuration
  const CONFIG = {
    MIN_PASSWORD_LENGTH: 8,
    MAX_EMAIL_LENGTH: 255,
    MAX_PASSWORD_LENGTH: 128,
    MAX_NAME_LENGTH: 100,
    RATE_LIMIT_ATTEMPTS: 5,
    RATE_LIMIT_WINDOW: 300000, // 5 minutes
  };

  // Rate limiting
  const authAttempts = new Map();
  
  function checkRateLimit(key) {
    const now = Date.now();
    const attempts = authAttempts.get(key) || { count: 0, firstAttempt: now };
    
    // Reset if window expired
    if (now - attempts.firstAttempt > CONFIG.RATE_LIMIT_WINDOW) {
      attempts.count = 0;
      attempts.firstAttempt = now;
    }
    
    attempts.count++;
    authAttempts.set(key, attempts);
    
    return {
      allowed: attempts.count <= CONFIG.RATE_LIMIT_ATTEMPTS,
      remaining: Math.max(0, CONFIG.RATE_LIMIT_ATTEMPTS - attempts.count),
      resetTime: attempts.firstAttempt + CONFIG.RATE_LIMIT_WINDOW
    };
  }

  // Validation functions
  function validateEmail(email) {
    if (!email || typeof email !== 'string') return false;
    if (email.length > CONFIG.MAX_EMAIL_LENGTH) return false;
    
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  function validatePassword(password) {
    if (!password || typeof password !== 'string') return false;
    return password.length >= CONFIG.MIN_PASSWORD_LENGTH && password.length <= CONFIG.MAX_PASSWORD_LENGTH;
  }

  function validateName(name) {
    if (!name || typeof name !== 'string') return false;
    if (name.length < 2 || name.length > CONFIG.MAX_NAME_LENGTH) return false;
    
    // Check for dangerous characters
    return !/[<>'"&]/.test(name);
  }

  function sanitizeInput(input, maxLength = 1000) {
    if (typeof input !== 'string') return '';
    
    return input
      .trim()
      .substring(0, maxLength)
      .replace(/[<>'"&]/g, ''); // Remove potentially dangerous characters
  }

  // Security helpers
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Export for use in HTML
  window.loginUtils = {
    validateEmail,
    validatePassword,
    validateName,
    sanitizeInput,
    escapeHtml,
    checkRateLimit: (key) => checkRateLimit(key || 'default'),
    CONFIG
  };

  console.log('✅ Login utilities loaded');
})();