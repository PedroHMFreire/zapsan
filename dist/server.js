"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const cors_1 = __importDefault(require("cors"));
const compression = require('compression');
const path_1 = __importDefault(require("path"));
const dns_1 = require("dns");
const logger_1 = require("./logger");
const responseLimiter_1 = require("./middleware/responseLimiter");
const jsonOptimizer_1 = require("./middleware/jsonOptimizer");
const apiCache_1 = require("./middleware/apiCache");
const deviceDetector_1 = require("./middleware/deviceDetector");
const adaptiveConfig_1 = require("./middleware/adaptiveConfig");
const performanceMonitor_1 = require("./middleware/performanceMonitor");
const lazyLoader_1 = require("./middleware/lazyLoader");
const routes_1 = __importDefault(require("./routes"));
// Força resolução IPv4 primeiro – mitiga quedas (ex.: stream errored 515) ligadas a IPv6/DNS em alguns ISPs macOS
(0, dns_1.setDefaultResultOrder)('ipv4first');
// __dirname já existe em CommonJS; remoção de import.meta para evitar erro de compilação
const app = (0, express_1.default)();
// Captura falhas não tratadas cedo para evitar saída silenciosa em produção (Render, etc.)
process.on('unhandledRejection', (reason) => {
    logger_1.logger.error({ reason }, 'Unhandled Rejection');
});
process.on('uncaughtException', (err) => {
    logger_1.logger.error({ err }, 'Uncaught Exception');
});
// Middlewares básicos
app.use((0, cors_1.default)());
app.use(compression({
    filter: (req, res) => {
        if (req.headers['x-no-compression'])
            return false;
        return compression.filter(req, res);
    },
    threshold: 1024, // Apenas arquivos > 1KB
    level: 6 // Balanceio compressão/CPU
}));
app.use(express_1.default.json({ limit: '10mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '10mb' }));
app.use((0, cookie_parser_1.default)());
// Performance monitoring (métricas em tempo real)
app.use((0, performanceMonitor_1.performanceMonitor)());
// Sistema adaptativo (detecta dispositivo e configura dinamicamente)
app.use(deviceDetector_1.deviceDetector);
app.use(adaptiveConfig_1.adaptiveConfig);
// Auto-otimização baseada em performance (Fase 3)
app.use((0, performanceMonitor_1.autoOptimizeMiddleware)());
// Middleware de limite de resposta (protege dispositivos móveis)
app.use((0, responseLimiter_1.responseLimiter)({
    maxSize: 5 * 1024 * 1024, // 5MB para desktop
    mobileMaxSize: 2 * 1024 * 1024, // 2MB para mobile
    skipPaths: ['/messages/media', '/download', '/uploads']
}));
// Otimizador JSON para respostas grandes
app.use((0, jsonOptimizer_1.jsonOptimizer)({
    compressThreshold: 50 * 1024, // 50KB threshold
    removeEmptyFields: true,
    truncateStrings: 1000
}));
// Frontend estático (sem bundler) - servimos depois dos redirects básicos
const pub = path_1.default.join(process.cwd(), 'public');
// Redireciona sempre para /login.html se não autenticado (cookie uid ausente) quando acessa raiz ou páginas principais
app.get(['/', '/index.html'], (req, res, next) => {
    try {
        const uid = req.cookies?.uid;
        if (!uid) {
            return res.redirect(302, '/login.html');
        }
        // autenticado: segue fluxo normal (servir index via estático)
        return res.sendFile(path_1.default.join(pub, 'index.html'));
    }
    catch {
        return res.redirect(302, '/login.html');
    }
});
// Se já autenticado e abrir /login.html manualmente, redireciona para /
app.get('/login.html', (req, res, next) => {
    const uid = req.cookies?.uid;
    if (uid) {
        return res.redirect(302, '/');
    }
    return res.sendFile(path_1.default.join(pub, 'login.html'));
});
app.use(express_1.default.static(pub, {
    maxAge: process.env.NODE_ENV === 'production' ? '1d' : '0',
    etag: true,
    lastModified: true,
    setHeaders: (res, path) => {
        // Cache mais agressivo para assets
        if (path.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$/)) {
            res.set('Cache-Control', 'public, max-age=31536000, immutable');
        }
        // Cache moderado para HTML
        else if (path.match(/\.html$/)) {
            res.set('Cache-Control', 'public, max-age=3600, must-revalidate');
        }
    }
}));
// Rotas da API
app.use('/api', apiCache_1.apiCache); // Cache para rotas de API
app.use('/', apiCache_1.apiCache); // Cache para outras rotas específicas
app.use('/', routes_1.default);
// Inicializar serviços avançados da Fase 3
(0, lazyLoader_1.startMetaCacheCleaner)();
// Health extra rápido (opcional; já existe em routes)
app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));
// 404 para API
app.use((req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/sessions') || req.path.startsWith('/messages')) {
        return res.status(404).json({ error: 'not_found' });
    }
    next();
});
// Erros padrão em JSON
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err, _req, res, _next) => {
    logger_1.logger.error({ err }, 'Unhandled error');
    res.status(500).json({ error: 'internal_error' });
});
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
    logger_1.logger.info(`ZapSan online em http://localhost:${PORT}`);
});
