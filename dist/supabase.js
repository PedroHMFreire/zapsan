"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSupabase = getSupabase;
exports.getSupabaseAdmin = getSupabaseAdmin;
exports.hasSupabaseEnv = hasSupabaseEnv;
const supabase_js_1 = require("@supabase/supabase-js");
// Centraliza criação do client. Usa URL e chave anon para operações públicas.
// Para operações administrativas (ex: upsert direto em tabela), pode-se usar SERVICE_ROLE via outra instância.
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
let supabase = null;
let supabaseAdmin = null;
function getSupabase() {
    if (!supabase) {
        if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
            throw new Error('supabase_env_missing');
        }
        supabase = (0, supabase_js_1.createClient)(SUPABASE_URL, SUPABASE_ANON_KEY, {
            auth: {
                persistSession: false,
                autoRefreshToken: false
            }
        });
    }
    return supabase;
}
function getSupabaseAdmin() {
    if (!supabaseAdmin) {
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
            throw new Error('supabase_admin_env_missing');
        }
        supabaseAdmin = (0, supabase_js_1.createClient)(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
            auth: { persistSession: false, autoRefreshToken: false }
        });
    }
    return supabaseAdmin;
}
function hasSupabaseEnv() {
    return !!(SUPABASE_URL && SUPABASE_ANON_KEY);
}
