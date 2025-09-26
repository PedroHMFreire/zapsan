"use strict";
/**
 * Middleware de autenticação e autorização
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = requireAuth;
exports.requireSessionOwnership = requireSessionOwnership;
exports.securityLogger = securityLogger;
exports.userRateLimit = userRateLimit;
const security_1 = require("./security");
// Middleware para verificar autenticação
function requireAuth(req, res, next) {
    const uid = req.cookies?.uid;
    if (!uid) {
        console.warn(`[auth] Tentativa de acesso sem autenticação: ${(0, security_1.sanitizeForLog)(req.path)} - IP: ${req.ip}`);
        return res.status(401).json({ error: 'unauthenticated', message: 'Login necessário' });
    }
    // Validar formato do UID (deve ser UUID ou string alfanumérica)
    if (typeof uid !== 'string' || uid.length < 8 || uid.length > 100) {
        console.warn(`[auth] UID inválido detectado: ${(0, security_1.sanitizeForLog)(uid)} - IP: ${req.ip}`);
        res.clearCookie('uid');
        return res.status(401).json({ error: 'invalid_session', message: 'Sessão inválida' });
    }
    // Adicionar userId ao request
    req.userId = uid;
    next();
}
// Middleware para verificar propriedade de sessão
function requireSessionOwnership(req, res, next) {
    const sessionId = req.params.sessionId || req.params.id;
    const userId = req.userId;
    if (!sessionId || !userId) {
        return res.status(400).json({ error: 'bad_request', message: 'session_id ou user_id ausente' });
    }
    // Verificar se o usuário tem acesso a esta sessão
    // Implementar lógica de verificação baseada no banco de dados
    // Por enquanto, permitir acesso (pode ser refinado posteriormente)
    next();
}
// Middleware para logs de segurança
function securityLogger(req, res, next) {
    // Log de tentativas suspeitas
    const suspiciousPatterns = [
        /[<>]/, // XSS básico
        /javascript:/i, // JavaScript injection
        /union\s+select/i, // SQL injection
        /\.\.\//, // Path traversal
        /%2e%2e%2f/i, // Path traversal encoded
        /eval\(/i, // Code injection
        /exec\(/i, // Command injection
    ];
    const url = req.url;
    const body = JSON.stringify(req.body || {});
    const isSuspicious = suspiciousPatterns.some(pattern => pattern.test(url) || pattern.test(body));
    if (isSuspicious) {
        console.warn(`[security] Tentativa suspeita detectada:`, {
            ip: req.ip,
            userAgent: (0, security_1.sanitizeForLog)(req.get('User-Agent') || ''),
            url: (0, security_1.sanitizeForLog)(url),
            method: req.method,
            body: (0, security_1.sanitizeForLog)(body),
            timestamp: new Date().toISOString()
        });
    }
    next();
}
// Rate limiting específico por usuário autenticado
const userAttempts = new Map();
const USER_MAX_ATTEMPTS = 200; // por hora
const USER_WINDOW_MS = 60 * 60 * 1000; // 1 hora
function userRateLimit(req, res, next) {
    const userId = req.userId;
    if (!userId) {
        return next(); // Se não autenticado, não aplicar rate limit por usuário
    }
    const now = Date.now();
    const userData = userAttempts.get(userId);
    if (!userData) {
        userAttempts.set(userId, { count: 1, lastAttempt: now });
        return next();
    }
    // Reset se passou da janela de tempo
    if (now - userData.lastAttempt > USER_WINDOW_MS) {
        userAttempts.set(userId, { count: 1, lastAttempt: now });
        return next();
    }
    // Incrementar tentativas
    userData.count++;
    userData.lastAttempt = now;
    if (userData.count > USER_MAX_ATTEMPTS) {
        console.warn(`[auth] Rate limit por usuário excedido: ${(0, security_1.sanitizeForLog)(userId)}`);
        return res.status(429).json({
            error: 'user_rate_limited',
            message: 'Muitas operações. Aguarde 1 hora.'
        });
    }
    next();
}
// Limpeza periódica
setInterval(() => {
    const now = Date.now();
    for (const [userId, data] of userAttempts.entries()) {
        if (now - data.lastAttempt > USER_WINDOW_MS) {
            userAttempts.delete(userId);
        }
    }
}, USER_WINDOW_MS);
