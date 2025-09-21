"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const dns_1 = require("dns");
const logger_1 = require("./logger");
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
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
// Frontend estático (sem bundler)
const pub = path_1.default.join(process.cwd(), 'public');
app.use(express_1.default.static(pub));
// Rotas da API
app.use('/', routes_1.default);
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
