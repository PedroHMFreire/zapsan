"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adaptiveConfig = adaptiveConfig;
exports.getPaginationConfig = getPaginationConfig;
exports.getPerformanceConfig = getPerformanceConfig;
exports.getTimeoutConfig = getTimeoutConfig;
// Configurações predefinidas por tipo de dispositivo/conexão
const CONFIG_PRESETS = {
    'mobile-slow': {
        pagination: { defaultLimit: 10, maxLimit: 50, messageLimit: 20 },
        performance: { compressionLevel: 9, imageQuality: 60, enableLazyLoad: true },
        features: { enableRealtime: true, enablePush: true, cacheTTL: 300 },
        timeouts: { requestTimeout: 15000, sseTimeout: 120000, uploadTimeout: 60000 }
    },
    'mobile-medium': {
        pagination: { defaultLimit: 20, maxLimit: 100, messageLimit: 50 },
        performance: { compressionLevel: 6, imageQuality: 75, enableLazyLoad: true },
        features: { enableRealtime: true, enablePush: true, cacheTTL: 180 },
        timeouts: { requestTimeout: 10000, sseTimeout: 90000, uploadTimeout: 45000 }
    },
    'mobile-fast': {
        pagination: { defaultLimit: 30, maxLimit: 150, messageLimit: 100 },
        performance: { compressionLevel: 4, imageQuality: 85, enableLazyLoad: false },
        features: { enableRealtime: true, enablePush: true, cacheTTL: 120 },
        timeouts: { requestTimeout: 8000, sseTimeout: 60000, uploadTimeout: 30000 }
    },
    'desktop-slow': {
        pagination: { defaultLimit: 50, maxLimit: 200, messageLimit: 100 },
        performance: { compressionLevel: 6, imageQuality: 80, enableLazyLoad: true },
        features: { enableRealtime: true, enablePush: false, cacheTTL: 240 },
        timeouts: { requestTimeout: 12000, sseTimeout: 90000, uploadTimeout: 45000 }
    },
    'desktop-fast': {
        pagination: { defaultLimit: 100, maxLimit: 500, messageLimit: 200 },
        performance: { compressionLevel: 3, imageQuality: 95, enableLazyLoad: false },
        features: { enableRealtime: true, enablePush: false, cacheTTL: 60 },
        timeouts: { requestTimeout: 5000, sseTimeout: 30000, uploadTimeout: 20000 }
    }
};
// Configuração padrão fallback
const DEFAULT_CONFIG = {
    pagination: { defaultLimit: 50, maxLimit: 200, messageLimit: 100 },
    performance: { compressionLevel: 6, imageQuality: 80, enableLazyLoad: false },
    features: { enableRealtime: true, enablePush: false, cacheTTL: 120 },
    timeouts: { requestTimeout: 8000, sseTimeout: 60000, uploadTimeout: 30000 }
};
function adaptiveConfig(req, res, next) {
    const context = req.deviceContext;
    if (!context) {
        req.adaptiveConfig = DEFAULT_CONFIG;
        return next();
    }
    // Determinar preset baseado no contexto
    const deviceType = context.isMobile ? 'mobile' : 'desktop';
    const presetKey = `${deviceType}-${context.connectionType}`;
    // Buscar configuração ou usar padrão
    const preset = CONFIG_PRESETS[presetKey] || {};
    // Merge com configuração padrão
    const config = {
        pagination: { ...DEFAULT_CONFIG.pagination, ...preset.pagination },
        performance: { ...DEFAULT_CONFIG.performance, ...preset.performance },
        features: { ...DEFAULT_CONFIG.features, ...preset.features },
        timeouts: { ...DEFAULT_CONFIG.timeouts, ...preset.timeouts }
    };
    // Ajustes dinâmicos baseados em capacidades
    if (context.capabilities.prefersReducedData) {
        config.pagination.defaultLimit = Math.min(config.pagination.defaultLimit, 10);
        config.performance.compressionLevel = Math.max(config.performance.compressionLevel, 8);
        config.performance.imageQuality = Math.min(config.performance.imageQuality, 60);
        config.performance.enableLazyLoad = true;
    }
    // Headers informativos para debug
    if (process.env.NODE_ENV === 'development') {
        res.set('X-Adaptive-Preset', presetKey);
        res.set('X-Page-Limit', config.pagination.defaultLimit.toString());
    }
    req.adaptiveConfig = config;
    next();
}
// Helper para extrair configuração de paginação de forma segura
function getPaginationConfig(req) {
    return req.adaptiveConfig?.pagination || DEFAULT_CONFIG.pagination;
}
// Helper para extrair configuração de performance
function getPerformanceConfig(req) {
    return req.adaptiveConfig?.performance || DEFAULT_CONFIG.performance;
}
// Helper para extrair timeouts
function getTimeoutConfig(req) {
    return req.adaptiveConfig?.timeouts || DEFAULT_CONFIG.timeouts;
}
