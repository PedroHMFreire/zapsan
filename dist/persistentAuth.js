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
                return null; // Retorna null ao invés do dado corrompido
            }
        }
        if (data.__type === 'Uint8Array' && typeof data.data === 'string') {
            try {
                return new Uint8Array(Buffer.from(data.data, 'base64'));
            }
            catch (err) {
                console.warn('[auth][deserialize] Invalid base64 Uint8Array:', err);
                return null; // Retorna null ao invés do dado corrompido
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
        console.log('🔥 [SYNC_DEBUG] ENTRADA saveAuthToSupabase para', sessionId);
        console.log('[auth][save][supabase][attempting]', sessionId, {
            hasCreds: !!creds,
            hasKeys: !!keys,
            credsType: typeof creds,
            keysType: typeof keys
        });
        // Serializar dados convertendo Buffers para formato JSON seguro
        console.log('🔥 [SYNC_DEBUG] Serializando dados...');
        const serializedCreds = serializeAuthData(creds);
        const serializedKeys = serializeAuthData(keys);
        console.log('✅ [SYNC_DEBUG] Dados serializados com sucesso');
        console.log('[auth][save][supabase][serialized]', sessionId, {
            serializedCredsSize: JSON.stringify(serializedCreds).length,
            serializedKeysSize: JSON.stringify(serializedKeys).length
        });
        console.log('🔥 [SYNC_DEBUG] Fazendo upsert no Supabase...');
        const { data, error } = await db_1.supa
            .from('wa_sessions')
            .upsert({
            session_id: sessionId,
            creds: JSON.stringify(serializedCreds),
            keys: JSON.stringify(serializedKeys),
            updated_at: new Date().toISOString()
        }, {
            onConflict: 'session_id'
        })
            .select(); // Adicionar select para ver o que foi inserido
        if (error) {
            console.error('[auth][save][supabase][error]', sessionId, {
                message: error.message,
                details: error.details,
                hint: error.hint,
                code: error.code
            });
            console.log('❌ [SYNC_DEBUG] ERRO no upsert Supabase:', error);
            return false;
        }
        console.log('[auth][save][supabase][success]', sessionId, {
            inserted: !!data,
            rowCount: data?.length || 0
        });
        console.log('✅ [SYNC_DEBUG] SUCESSO no upsert Supabase:', data);
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
            console.log('[auth][load][supabase][not_found]', sessionId, error?.message || 'no data');
            return null;
        }
        // Validar se os dados existem e são strings válidas
        if (!data.creds || !data.keys) {
            console.warn('[auth][load][supabase][invalid_data]', sessionId, 'missing creds or keys');
            return null;
        }
        // Deserializar dados convertendo Objects de volta para Buffers
        let rawCreds, rawKeys;
        try {
            rawCreds = JSON.parse(data.creds);
            rawKeys = JSON.parse(data.keys);
        }
        catch (parseErr) {
            console.error('[auth][load][supabase][parse_error]', sessionId, parseErr);
            return null;
        }
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
                    // Carregar keys - formato compatível com Baileys
                    this.state.keys = {};
                    // Carregar TODOS os arquivos de key (não só app-state-sync)
                    if (fs_1.default.existsSync(localDir)) {
                        const allFiles = fs_1.default.readdirSync(localDir);
                        // Arquivos de key do Baileys: app-state-sync-key-*, session-*, sender-key-*, pre-key-*
                        const keyFiles = allFiles.filter(f => f.startsWith('app-state-sync-key-') ||
                            f.startsWith('session-') ||
                            f.startsWith('sender-key-') ||
                            f.startsWith('pre-key-') ||
                            f.startsWith('sender-keys-') ||
                            f.startsWith('sessions-'));
                        for (const keyFile of keyFiles) {
                            try {
                                const keyPath = path_1.default.join(localDir, keyFile);
                                const rawKeyData = JSON.parse(fs_1.default.readFileSync(keyPath, 'utf-8'));
                                const deserializedKey = deserializeAuthData(rawKeyData);
                                // Para app-state-sync-key, usar o ID como chave
                                if (keyFile.startsWith('app-state-sync-key-')) {
                                    const keyId = keyFile.replace('app-state-sync-key-', '').replace('.json', '');
                                    this.state.keys[keyId] = deserializedKey;
                                }
                                else {
                                    // Para outros tipos, usar o nome do arquivo sem extensão como chave
                                    const keyName = keyFile.replace('.json', '');
                                    this.state.keys[keyName] = deserializedKey;
                                }
                            }
                            catch (err) {
                                console.warn('[auth][load][key][error]', keyFile, err);
                            }
                        }
                        console.log('[auth][load][local][keys]', sessionId, Object.keys(this.state.keys).length, 'keys loaded');
                    }
                    console.log('[auth][load][local][ok]', sessionId);
                    return this.state;
                }
                else {
                    console.log('[auth][load][local][not_found]', sessionId, 'creds.json não existe');
                }
            }
            catch (err) {
                console.warn('[auth][load][local][error]', sessionId, err);
            }
            // Se não existe local, tentar Supabase com retry
            console.log('[auth][load][supabase][trying]', sessionId);
            let supabaseAuth = null;
            let attempts = 0;
            const maxAttempts = 3;
            while (attempts < maxAttempts && !supabaseAuth) {
                attempts++;
                try {
                    supabaseAuth = await loadAuthFromSupabase(sessionId);
                    if (supabaseAuth)
                        break;
                }
                catch (err) {
                    console.warn(`[auth][load][supabase][attempt_${attempts}]`, sessionId, err);
                    if (attempts < maxAttempts) {
                        // Aguardar antes do retry
                        await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
                    }
                }
            }
            if (supabaseAuth) {
                console.log('[auth][load][supabase][ok]', sessionId, 'credenciais recuperadas do Supabase');
                this.state.creds = supabaseAuth.creds;
                this.state.keys = supabaseAuth.keys || {};
                // Validar integridade dos dados recuperados
                const credsValid = supabaseAuth.creds && typeof supabaseAuth.creds === 'object';
                const keysValid = supabaseAuth.keys && typeof supabaseAuth.keys === 'object';
                if (!credsValid || !keysValid) {
                    console.warn('[auth][load][supabase][invalid_data]', sessionId, {
                        credsValid,
                        keysValid,
                        credsType: typeof supabaseAuth.creds,
                        keysType: typeof supabaseAuth.keys
                    });
                    // Continuar mesmo com dados inválidos, mas registrar o problema
                }
                // Salvar localmente para próximas vezes com validação
                try {
                    this.saveToLocal();
                }
                catch (saveErr) {
                    console.warn('[auth][load][supabase][save_local_failed]', sessionId, saveErr);
                }
                return this.state;
            }
            else {
                console.log('[auth][load][supabase][not_found]', sessionId, `após ${attempts} tentativas`);
            }
            // Retornar estado vazio para nova sessão
            console.log('[auth][load][empty]', sessionId, 'criando nova sessão');
            return this.state;
        },
        async saveState() {
            console.log('🔥 [SYNC_DEBUG] INÍCIO saveState() para', sessionId);
            // Validar dados antes de salvar
            if (!this.state.creds && !this.state.keys) {
                console.warn('[auth][save][empty_state]', sessionId, 'nenhuma credencial para salvar');
                console.log('⚠️ [SYNC_DEBUG] ERRO: Estado vazio, nenhuma credencial para salvar');
                return;
            }
            console.log('🔥 [SYNC_DEBUG] Estado validado:', {
                hasCreds: !!this.state.creds,
                hasKeys: !!this.state.keys,
                keysCount: this.state.keys ? Object.keys(this.state.keys).length : 0
            });
            console.log('[auth][save][starting]', sessionId, {
                hasCreds: !!this.state.creds,
                hasKeys: !!this.state.keys,
                keysCount: this.state.keys ? Object.keys(this.state.keys).length : 0
            });
            // Salvar localmente primeiro (mais rápido e confiável)
            console.log('🔥 [SYNC_DEBUG] Salvando localmente...');
            try {
                this.saveToLocal();
                console.log('✅ [SYNC_DEBUG] Salvo localmente com sucesso');
            }
            catch (localErr) {
                console.error('[auth][save][local][error]', sessionId, localErr);
                console.log('❌ [SYNC_DEBUG] ERRO ao salvar localmente:', localErr);
            }
            // Backup no Supabase com retry
            console.log('🔥 [SYNC_DEBUG] Iniciando backup no Supabase...');
            let saved = false;
            let attempts = 0;
            const maxAttempts = 3;
            while (!saved && attempts < maxAttempts) {
                attempts++;
                console.log(`🔥 [SYNC_DEBUG] Tentativa ${attempts}/${maxAttempts} de salvar no Supabase...`);
                try {
                    saved = await saveAuthToSupabase(sessionId, this.state.creds, this.state.keys);
                    if (saved) {
                        console.log('[auth][save][complete]', sessionId, `local + supabase (attempt ${attempts})`);
                        console.log(`✅ [SYNC_DEBUG] Credenciais salvas no Supabase na tentativa ${attempts}!`);
                        break;
                    }
                    else {
                        console.log(`⚠️ [SYNC_DEBUG] saveAuthToSupabase retornou false na tentativa ${attempts}`);
                    }
                }
                catch (err) {
                    console.error(`[auth][save][supabase][attempt_${attempts}]`, sessionId, err);
                    console.log(`❌ [SYNC_DEBUG] ERRO na tentativa ${attempts}:`, err);
                    if (attempts < maxAttempts) {
                        await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
                    }
                }
            }
            if (!saved) {
                console.error('[auth][save][supabase][failed]', sessionId, `após ${attempts} tentativas`);
                console.log(`❌ [SYNC_DEBUG] FALHA TOTAL: Não foi possível salvar no Supabase após ${attempts} tentativas`);
            }
            else {
                console.log(`✅ [SYNC_DEBUG] FIM saveState() - credenciais salvas com sucesso`);
            }
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
                    Object.entries(this.state.keys).forEach(([keyName, keyData]) => {
                        // Pular dados nulos ou corrompidos
                        if (keyData === null || keyData === undefined) {
                            console.warn(`[auth][save][local] Skipping null/undefined key: ${keyName}`);
                            return;
                        }
                        const serializedKeyData = serializeAuthData(keyData);
                        // Determinar o nome do arquivo baseado no tipo de key
                        let fileName;
                        if (keyName.includes('app-state-sync-key') || (!keyName.includes('-') && !keyName.includes(':'))) {
                            // App state sync keys (formato: keyId ou app-state-sync-key-keyId)
                            const keyId = keyName.replace('app-state-sync-key-', '');
                            fileName = `app-state-sync-key-${keyId}.json`;
                        }
                        else {
                            // Outros tipos de key (session, sender-key, pre-key)
                            fileName = `${keyName}.json`;
                        }
                        fs_1.default.writeFileSync(path_1.default.join(localDir, fileName), JSON.stringify(serializedKeyData, null, 2));
                    });
                }
            }
            catch (err) {
                console.warn('[auth][save][local][error]', sessionId, err);
            }
        }
    };
}
