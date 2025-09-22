#!/usr/bin/env node
// Verifica funcionamento de /auth/register e /auth/login
import http from 'http'

const HOST = process.env.HOST || 'localhost'
const PORT = process.env.PORT || 3000

function req(method, path, body){
  return new Promise((resolve,reject)=>{
    const data = body ? JSON.stringify(body) : null
    const opts = { method, hostname: HOST, port: PORT, path, headers: { 'Content-Type':'application/json', 'Content-Length': data? Buffer.byteLength(data):0 } }
    const r = http.request(opts, res=>{
      let chunks=''
      res.on('data', d=> chunks+=d)
      res.on('end', ()=>{
        let json=null
        try{ json = JSON.parse(chunks||'{}') }catch{}
        resolve({ status: res.statusCode, json })
      })
    })
    r.on('error', reject)
    if(data) r.write(data)
    r.end()
  })
}

async function main(){
  const stamp = Date.now().toString(36)
  const email = `ver${stamp}@test.local`
  const password = 'teste123'

  const reg = await req('POST','/auth/register',{ name: 'Verificador', email, password, confirm: password })
  const loginNew = await req('POST','/auth/login',{ email, password })
  const loginFail = await req('POST','/auth/login',{ email, password: 'errada' })
  const loginMissing = await req('POST','/auth/login',{ email: 'naoexiste'+stamp+'@test.local', password })

  const summary = {
    register: reg,
    loginNew: loginNew,
    loginFail: loginFail,
    loginMissing: loginMissing
  }

  const ok = reg.status===201 && loginNew.status===200 && loginFail.status===401 && loginMissing.status===404
  console.log(JSON.stringify({ ok, summary }, null, 2))
  if(!ok) process.exit(1)
}

main().catch(err=>{ console.error('verify-auth error', err); process.exit(1) })
