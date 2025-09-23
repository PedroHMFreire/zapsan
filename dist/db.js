"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.supa = void 0;
const supabase_js_1 = require("@supabase/supabase-js");
exports.supa = (0, supabase_js_1.createClient)(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
