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
// Salvar credenciais no Supabase
async function saveAuthToSupabase(sessionId, creds, keys) {
    try {
        const { error } = await db_1.supa
            .from('wa_sessions')
            .upsert({
            session_id: sessionId,
            creds: JSON.stringify(creds),
            keys: JSON.stringify(keys),
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
        const creds = JSON.parse(data.creds);
        const keys = JSON.parse(data.keys);
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
                    const keysPath = path_1.default.join(localDir, 'app-state-sync-key-*.json');
                    this.state.creds = JSON.parse(fs_1.default.readFileSync(credsPath, 'utf-8'));
                    // Carregar keys (podem ser múltiplos arquivos)
                    const keyFiles = fs_1.default.readdirSync(localDir).filter(f => f.startsWith('app-state-sync-key-'));
                    this.state.keys = {};
                    for (const keyFile of keyFiles) {
                        const keyData = JSON.parse(fs_1.default.readFileSync(path_1.default.join(localDir, keyFile), 'utf-8'));
                        Object.assign(this.state.keys, keyData);
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
                    fs_1.default.writeFileSync(path_1.default.join(localDir, 'creds.json'), JSON.stringify(this.state.creds, null, 2));
                }
                if (this.state.keys) {
                    // Salvar keys como arquivos separados (padrão Baileys)
                    Object.entries(this.state.keys).forEach(([keyId, keyData]) => {
                        fs_1.default.writeFileSync(path_1.default.join(localDir, `app-state-sync-key-${keyId}.json`), JSON.stringify(keyData, null, 2));
                    });
                }
            }
            catch (err) {
                console.warn('[auth][save][local][error]', sessionId, err);
            }
        }
    };
}
