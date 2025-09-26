"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveAuthToSupabase = saveAuthToSupabase;
exports.loadAuthFromSupabase = loadAuthFromSupabase;
exports.deleteAuthFromSupabase = deleteAuthFromSupabase;
exports.createPersistentAuthState = createPersistentAuthState;
const db_1 = require("./db");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
// Função para converter Buffers/Uint8Arrays para base64
function serializeAuthData(data) {
    if (Buffer.isBuffer(data)) {
        return {
            __type: 'Buffer',
            data: data.toString('base64')
        };
    }
    if (data instanceof Uint8Array) {
        return {
            __type: 'Uint8Array',
            data: Buffer.from(data).toString('base64')
        };
    }
    if (Array.isArray(data)) {
        return data.map(item => serializeAuthData(item));
    }
    if (data && typeof data === 'object') {
        const result = {};
        for (const [key, value] of Object.entries(data)) {
            result[key] = serializeAuthData(value);
        }
        return result;
    }
    return data;
}
// Função para converter dados serializados de volta para Buffers/Uint8Arrays
function deserializeAuthData(data) {
    if (Array.isArray(data)) {
        return data.map(deserializeAuthData);
    }
    if (data && typeof data === 'object') {
        // Verificar se é um objeto marcado como Buffer/Uint8Array
        if (data.__type === 'Buffer' && typeof data.data === 'string') {
            try {
                return Buffer.from(data.data, 'base64');
            }
            catch (err) {
                console.warn('[auth][deserialize] Invalid base64 Buffer:', err);
                return data;
            }
        }
        if (data.__type === 'Uint8Array' && typeof data.data === 'string') {
            try {
                return new Uint8Array(Buffer.from(data.data, 'base64'));
            }
            catch (err) {
                console.warn('[auth][deserialize] Invalid base64 Uint8Array:', err);
                return data;
            }
        }
        // Processar recursivamente outros objetos
        const result = {};
        for (const [key, value] of Object.entries(data)) {
            result[key] = deserializeAuthData(value);
        }
        return result;
    }
    return data;
}
// Salvar credenciais no Supabase
async function saveAuthToSupabase(sessionId, creds, keys) {
    try {
        // Serializar dados convertendo Buffers para formato JSON seguro
        const serializedCreds = serializeAuthData(creds);
        const serializedKeys = serializeAuthData(keys);
        const { error } = await db_1.supa
            .from('wa_sessions')
            .upsert({
            session_id: sessionId,
            creds: JSON.stringify(serializedCreds),
            keys: JSON.stringify(serializedKeys),
            updated_at: new Date().toISOString()
        }, {
            onConflict: 'session_id'
        });
        if (error) {
            console.warn('[auth][save][supabase][error]', sessionId, error.message);
            return false;
        }
        console.log('[auth][save][supabase][ok]', sessionId);
        return true;
    }
    catch (err) {
        console.warn('[auth][save][supabase][catch]', sessionId, err.message);
        return false;
    }
}
// Carregar credenciais do Supabase
async function loadAuthFromSupabase(sessionId) {
    try {
        const { data, error } = await db_1.supa
            .from('wa_sessions')
            .select('creds, keys')
            .eq('session_id', sessionId)
            .single();
        if (error || !data) {
            console.log('[auth][load][supabase][not_found]', sessionId);
            return null;
        }
        // Deserializar dados convertendo Objects de volta para Buffers
        const rawCreds = JSON.parse(data.creds);
        const rawKeys = JSON.parse(data.keys);
        const creds = deserializeAuthData(rawCreds);
        const keys = deserializeAuthData(rawKeys);
        console.log('[auth][load][supabase][ok]', sessionId);
        return { creds, keys };
    }
    catch (err) {
        console.warn('[auth][load][supabase][catch]', sessionId, err.message);
        return null;
    }
}
// Deletar credenciais do Supabase
async function deleteAuthFromSupabase(sessionId) {
    try {
        const { error } = await db_1.supa
            .from('wa_sessions')
            .delete()
            .eq('session_id', sessionId);
        if (error) {
            console.warn('[auth][delete][supabase][error]', sessionId, error.message);
            return false;
        }
        console.log('[auth][delete][supabase][ok]', sessionId);
        return true;
    }
    catch (err) {
        console.warn('[auth][delete][supabase][catch]', sessionId, err.message);
        return false;
    }
}
// Implementação de AuthState que usa Supabase como fallback
function createPersistentAuthState(sessionId) {
    const localDir = path_1.default.join(process.cwd(), 'sessions', sessionId);
    return {
        state: {
            creds: null,
            keys: null
        },
        async loadState() {
            // Tentar carregar do local primeiro (mais rápido)
            try {
                if (fs_1.default.existsSync(path_1.default.join(localDir, 'creds.json'))) {
                    const credsPath = path_1.default.join(localDir, 'creds.json');
                    // Carregar e deserializar credenciais
                    const rawCreds = JSON.parse(fs_1.default.readFileSync(credsPath, 'utf-8'));
                    this.state.creds = deserializeAuthData(rawCreds);
                    // Carregar keys (podem ser múltiplos arquivos)
                    const keyFiles = fs_1.default.readdirSync(localDir).filter(f => f.startsWith('app-state-sync-key-'));
                    this.state.keys = {};
                    for (const keyFile of keyFiles) {
                        const rawKeyData = JSON.parse(fs_1.default.readFileSync(path_1.default.join(localDir, keyFile), 'utf-8'));
                        const deserializedKeys = deserializeAuthData(rawKeyData);
                        Object.assign(this.state.keys, deserializedKeys);
                    }
                    console.log('[auth][load][local][ok]', sessionId);
                    return this.state;
                }
            }
            catch (err) {
                console.warn('[auth][load][local][error]', sessionId, err);
            }
            // Se não existe local, tentar Supabase
            const supabaseAuth = await loadAuthFromSupabase(sessionId);
            if (supabaseAuth) {
                this.state.creds = supabaseAuth.creds;
                this.state.keys = supabaseAuth.keys;
                // Salvar localmente para próximas vezes
                this.saveToLocal();
                return this.state;
            }
            // Retornar estado vazio para nova sessão
            return this.state;
        },
        async saveState() {
            // Salvar localmente
            this.saveToLocal();
            // Backup no Supabase
            await saveAuthToSupabase(sessionId, this.state.creds, this.state.keys);
        },
        saveToLocal() {
            try {
                fs_1.default.mkdirSync(localDir, { recursive: true });
                if (this.state.creds) {
                    // Serializar credenciais antes de salvar
                    const serializedCreds = serializeAuthData(this.state.creds);
                    fs_1.default.writeFileSync(path_1.default.join(localDir, 'creds.json'), JSON.stringify(serializedCreds, null, 2));
                }
                if (this.state.keys) {
                    // Salvar keys como arquivos separados (padrão Baileys)
                    Object.entries(this.state.keys).forEach(([keyId, keyData]) => {
                        const serializedKeyData = serializeAuthData(keyData);
                        fs_1.default.writeFileSync(path_1.default.join(localDir, `app-state-sync-key-${keyId}.json`), JSON.stringify(serializedKeyData, null, 2));
                    });
                }
            }
            catch (err) {
                console.warn('[auth][save][local][error]', sessionId, err);
            }
        }
    };
}
