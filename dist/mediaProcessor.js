"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processMedia = processMedia;
exports.serveMedia = serveMedia;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const sharp_1 = __importDefault(require("sharp"));
const crypto_1 = require("crypto");
const MEDIA_DIR = path_1.default.join(process.cwd(), 'data', 'media');
const THUMBS_DIR = path_1.default.join(MEDIA_DIR, 'thumbnails');
const PREVIEWS_DIR = path_1.default.join(MEDIA_DIR, 'previews');
// Garantir que os diretórios existem
function ensureMediaDirs() {
    try {
        fs_1.default.mkdirSync(MEDIA_DIR, { recursive: true });
        fs_1.default.mkdirSync(THUMBS_DIR, { recursive: true });
        fs_1.default.mkdirSync(PREVIEWS_DIR, { recursive: true });
    }
    catch (e) {
        console.warn('[media][dirs][warn]', e);
    }
}
ensureMediaDirs();
// Gerar hash único para arquivo
function getMediaHash(buffer) {
    return (0, crypto_1.createHash)('md5').update(buffer).digest('hex');
}
// Determinar tipo de mídia
function getMediaType(mimetype) {
    if (mimetype.startsWith('image/'))
        return 'image';
    if (mimetype.startsWith('video/'))
        return 'video';
    if (mimetype.startsWith('audio/'))
        return 'audio';
    return 'document';
}
// Processar imagem - criar thumbnail e preview
async function processImage(buffer, hash, mimetype) {
    try {
        const image = (0, sharp_1.default)(buffer);
        const metadata = await image.metadata();
        // Thumbnail pequeno (150x150 max, para lista de mensagens)
        const thumbnailPath = path_1.default.join(THUMBS_DIR, `${hash}.webp`);
        await image
            .resize(150, 150, {
            fit: 'inside',
            withoutEnlargement: true
        })
            .webp({ quality: 80 })
            .toFile(thumbnailPath);
        // Preview médio (800x600 max, para modal)
        const previewPath = path_1.default.join(PREVIEWS_DIR, `${hash}.webp`);
        await image
            .resize(800, 600, {
            fit: 'inside',
            withoutEnlargement: true
        })
            .webp({ quality: 90 })
            .toFile(previewPath);
        return {
            type: 'image',
            thumbnailPath,
            previewPath,
            width: metadata.width,
            height: metadata.height
        };
    }
    catch (error) {
        console.warn('[media][image][process][warn]', error);
        return { type: 'image' };
    }
}
// Processar vídeo - extrair thumbnail do primeiro frame
async function processVideo(buffer, hash) {
    try {
        // Para vídeo, vamos criar um placeholder por enquanto
        // Em produção, usaria ffmpeg para extrair frame
        const thumbnailPath = path_1.default.join(THUMBS_DIR, `${hash}_video.svg`);
        const videoIcon = `<svg width="150" height="150" viewBox="0 0 24 24" fill="#128C7E"><path d="M8 5v14l11-7z"/></svg>`;
        fs_1.default.writeFileSync(thumbnailPath, videoIcon);
        return {
            type: 'video',
            thumbnailPath
        };
    }
    catch (error) {
        console.warn('[media][video][process][warn]', error);
        return { type: 'video' };
    }
}
// Processar áudio - criar waveform placeholder
async function processAudio(buffer, hash) {
    try {
        const thumbnailPath = path_1.default.join(THUMBS_DIR, `${hash}_audio.svg`);
        const audioIcon = `<svg width="150" height="150" viewBox="0 0 24 24" fill="#128C7E"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;
        fs_1.default.writeFileSync(thumbnailPath, audioIcon);
        return {
            type: 'audio',
            thumbnailPath
        };
    }
    catch (error) {
        console.warn('[media][audio][process][warn]', error);
        return { type: 'audio' };
    }
}
// Processar documento - criar ícone baseado na extensão
async function processDocument(filename, hash, mimetype) {
    try {
        const ext = path_1.default.extname(filename).toLowerCase();
        const thumbnailPath = path_1.default.join(THUMBS_DIR, `${hash}_doc.svg`);
        // Ícones por tipo de documento
        const docIcons = {
            '.pdf': `<svg width="150" height="150" viewBox="0 0 24 24" fill="#DC4E41"><path d="M8.8 20H5c-.5 0-1-.5-1-1V5c0-.5.5-1 1-1h9.2c.4 0 .7.1 1 .3l4.5 4.5c.2.3.3.6.3 1v5.7c0 .5-.5 1-1 1h-2.5v3c0 .5-.5 1-1 1zm-3-2h2V9c0-.5.5-1 1-1h6V7h-4c-.5 0-1-.5-1-1V2H6v16z"/></svg>`,
            '.doc': `<svg width="150" height="150" viewBox="0 0 24 24" fill="#2B579A"><path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z"/></svg>`,
            '.xls': `<svg width="150" height="150" viewBox="0 0 24 24" fill="#1D6F42"><path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z"/></svg>`,
            default: `<svg width="150" height="150" viewBox="0 0 24 24" fill="#666"><path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z"/></svg>`
        };
        const icon = docIcons[ext] || docIcons.default;
        fs_1.default.writeFileSync(thumbnailPath, icon);
        return {
            type: 'document',
            thumbnailPath
        };
    }
    catch (error) {
        console.warn('[media][document][process][warn]', error);
        return { type: 'document' };
    }
}
// Função principal para processar mídia
async function processMedia(filePath, mimetype) {
    const buffer = fs_1.default.readFileSync(filePath);
    const hash = getMediaHash(buffer);
    const filename = path_1.default.basename(filePath);
    const stats = fs_1.default.statSync(filePath);
    const baseInfo = {
        type: getMediaType(mimetype),
        originalPath: filePath,
        mimetype,
        size: stats.size,
        filename
    };
    let processedInfo = {};
    switch (baseInfo.type) {
        case 'image':
            processedInfo = await processImage(buffer, hash, mimetype);
            break;
        case 'video':
            processedInfo = await processVideo(buffer, hash);
            break;
        case 'audio':
            processedInfo = await processAudio(buffer, hash);
            break;
        case 'document':
            processedInfo = await processDocument(filename, hash, mimetype);
            break;
    }
    return { ...baseInfo, ...processedInfo };
}
// Servir mídia com cache headers
function serveMedia(mediaPath, res) {
    try {
        if (!fs_1.default.existsSync(mediaPath)) {
            return res.status(404).json({ error: 'media_not_found' });
        }
        const stats = fs_1.default.statSync(mediaPath);
        const ext = path_1.default.extname(mediaPath).toLowerCase();
        // MIME types
        const mimeTypes = {
            '.webp': 'image/webp',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.svg': 'image/svg+xml',
            '.pdf': 'application/pdf',
            '.mp4': 'video/mp4',
            '.mp3': 'audio/mpeg'
        };
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        // Cache headers (1 hora)
        res.set({
            'Content-Type': contentType,
            'Content-Length': stats.size,
            'Cache-Control': 'public, max-age=3600',
            'ETag': `"${stats.mtime.getTime()}-${stats.size}"`
        });
        // Stream do arquivo
        const stream = fs_1.default.createReadStream(mediaPath);
        stream.pipe(res);
    }
    catch (error) {
        console.warn('[media][serve][error]', error);
        res.status(500).json({ error: 'serve_error' });
    }
}
