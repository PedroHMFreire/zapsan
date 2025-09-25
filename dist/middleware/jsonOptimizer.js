"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.jsonOptimizer = jsonOptimizer;
function jsonOptimizer(options) {
    const { compressThreshold, removeEmptyFields = true, truncateStrings } = options;
    return (req, res, next) => {
        // Detectar se é móvel para otimizações mais agressivas
        const isMobile = /Mobile|Android|iPhone|iPad/i.test(req.headers['user-agent'] || '');
        const originalJson = res.json.bind(res);
        res.json = function (body) {
            let optimizedBody = body;
            // Se o body for grande o suficiente, otimizar
            const jsonString = JSON.stringify(body);
            if (Buffer.byteLength(jsonString, 'utf8') > compressThreshold) {
                optimizedBody = optimizeJsonData(body, {
                    removeEmpty: removeEmptyFields,
                    truncateStrings: isMobile ? (truncateStrings || 500) : truncateStrings,
                    isMobile
                });
            }
            return originalJson(optimizedBody);
        };
        next();
    };
}
function optimizeJsonData(data, options) {
    const { removeEmpty, truncateStrings, isMobile } = options;
    if (Array.isArray(data)) {
        return data.map(item => optimizeJsonData(item, options)).filter(Boolean);
    }
    if (data && typeof data === 'object') {
        const optimized = {};
        for (const [key, value] of Object.entries(data)) {
            // Remover campos vazios se solicitado
            if (removeEmpty && (value === null || value === undefined || value === '')) {
                continue;
            }
            // Truncar strings longas em mobile
            if (truncateStrings && typeof value === 'string' && value.length > truncateStrings) {
                optimized[key] = value.substring(0, truncateStrings) + '...';
                continue;
            }
            // Otimizações específicas para mobile
            if (isMobile) {
                // Remover metadados desnecessários
                if (['created_at', 'updated_at', 'metadata'].includes(key) &&
                    typeof value === 'object') {
                    continue;
                }
            }
            // Recursivo para objetos aninhados
            optimized[key] = optimizeJsonData(value, options);
        }
        return optimized;
    }
    return data;
}
