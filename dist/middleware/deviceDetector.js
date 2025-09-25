"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deviceDetector = deviceDetector;
function deviceDetector(req, res, next) {
    const userAgent = req.headers['user-agent'] || '';
    const acceptEncoding = req.headers['accept-encoding'] || '';
    const connection = req.headers.connection || '';
    const saveData = req.headers['save-data'];
    // Detectar tipo de dispositivo
    const isMobile = /Mobile|Android|iPhone|iPod|BlackBerry|Opera Mini/i.test(userAgent);
    const isTablet = /iPad|Android.*Tablet|Kindle|Silk/i.test(userAgent) && !isMobile;
    // Detectar conexão lenta
    const isSlowConnection = saveData === 'on' ||
        connection === 'close' ||
        /2G|3G|slow/i.test(req.headers['downlink'] || '') ||
        parseInt(req.headers['rtt'] || '0') > 300;
    // Determinar tipo de conexão
    let connectionType = 'medium';
    const rtt = parseInt(req.headers['rtt'] || '0');
    const downlink = parseFloat(req.headers['downlink'] || '0');
    if (isSlowConnection || rtt > 500 || downlink < 1) {
        connectionType = 'slow';
    }
    else if (rtt < 100 && downlink > 5) {
        connectionType = 'fast';
    }
    // Detectar capacidades
    const capabilities = {
        supportsWebP: acceptEncoding.includes('webp') || userAgent.includes('Chrome'),
        supportsModernJS: !(/MSIE|Trident/i.test(userAgent)),
        prefersReducedData: saveData === 'on' || isSlowConnection
    };
    // Criar contexto
    const deviceContext = {
        isMobile,
        isTablet,
        isSlowConnection,
        connectionType,
        capabilities
    };
    // Anexar ao request
    req.deviceContext = deviceContext;
    // Headers de debug (opcional, apenas em desenvolvimento)
    if (process.env.NODE_ENV === 'development') {
        res.set('X-Device-Type', isMobile ? 'mobile' : isTablet ? 'tablet' : 'desktop');
        res.set('X-Connection-Type', connectionType);
    }
    next();
}
