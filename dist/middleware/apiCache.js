"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.apiCache = apiCache;
const cacheConfig = {
    '/health': { maxAge: 60 }, // 1 minuto
    '/knowledge': { maxAge: 300 }, // 5 minutos
    '/knowledge/sections': { maxAge: 300 },
    '/me/profile': { maxAge: 180, private: true }, // 3 minutos, privado
    '/sessions/*/status': { maxAge: 30, mustRevalidate: true }, // 30s com revalidação
    '/sessions/*/contacts': { maxAge: 600 }, // 10 minutos
};
function apiCache(req, res, next) {
    // Encontrar configuração de cache para o path
    let config;
    for (const [pattern, cfg] of Object.entries(cacheConfig)) {
        const regex = new RegExp('^' + pattern.replace('*', '[^/]+') + '$');
        if (regex.test(req.path)) {
            config = cfg;
            break;
        }
    }
    if (!config) {
        return next();
    }
    // Construir header Cache-Control
    const cacheDirectives = [];
    if (config.private) {
        cacheDirectives.push('private');
    }
    else {
        cacheDirectives.push('public');
    }
    cacheDirectives.push(`max-age=${config.maxAge}`);
    if (config.mustRevalidate) {
        cacheDirectives.push('must-revalidate');
    }
    res.set({
        'Cache-Control': cacheDirectives.join(', '),
        'ETag': `"${req.path}-${Date.now()}"`, // ETag simples
        'Vary': 'Accept, User-Agent' // Varia por tipo de dispositivo
    });
    next();
}
