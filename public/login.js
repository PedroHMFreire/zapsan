// login.js - lógica da tela de login/cadastro
(function(){
  const qs = (sel,root=document)=>root.querySelector(sel)
  const qsa = (sel,root=document)=>Array.from(root.querySelectorAll(sel))

  const form = qs('#login-form')
  const email = qs('#email')
  const pass = qs('#password')
  const pass2 = qs('#password2')
  const regName = qs('#reg-name')
  const remember = qs('#remember')
  const errBox = qs('#err-box')
  const btn = qs('#btn-login')
  const modeTabs = qsa('[data-mode-tab]')
  const regExtra = qs('#register-extra')
  const pwMeter = qs('#pw-meter')
  const pwMeterFill = qs('#pw-meter-fill')
  const pwMeterLabel = qs('#pw-meter-label')
  const passToggle = qs('#btn-pass')

  // ===== Tema =====
  const themeBtn = qs('#theme-toggle')
  function applyTheme(t){ document.documentElement.dataset.theme = t; try { localStorage.setItem('theme',t) } catch {} }
  const savedTheme = localStorage.getItem('theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light':'dark')
  applyTheme(savedTheme)
  function updateThemeIcon(){ themeBtn.textContent = document.documentElement.dataset.theme === 'light' ? '🌙' : '☀️' }
  themeBtn?.addEventListener('click', ()=>{ applyTheme(document.documentElement.dataset.theme==='light'?'dark':'light'); updateThemeIcon() })
  updateThemeIcon()

  // ===== UI helpers =====
  function showErr(msg){ if(!errBox) return; errBox.textContent = msg; errBox.classList.add('show'); errBox.setAttribute('aria-hidden','false') }
  function clearErr(){ if(!errBox)return; errBox.classList.remove('show'); errBox.textContent=''; errBox.setAttribute('aria-hidden','true') }
  function setLoading(v){ if(!btn)return; btn.disabled=v; btn.classList.toggle('loading', v); btn.innerHTML = v ? '<span class="spinner" aria-hidden="true"></span><span>Processando…</span>' : (form.dataset.mode==='register'?'Criar conta':'Entrar') }

  function setMode(mode){
    form.dataset.mode = mode
    const isReg = mode==='register'
    regExtra.style.display = isReg ? 'flex':'none'
    btn.textContent = isReg ? 'Criar conta':'Entrar'
    modeTabs.forEach(t=>{
      const m = t.getAttribute('data-mode-tab')
      const sel = m===mode
      t.setAttribute('aria-selected', String(sel))
      t.classList.toggle('active', sel)
      t.tabIndex = sel? '0':'-1'
    })
    clearErr()
    updatePwStrength()
  }

  modeTabs.forEach(t=> t.addEventListener('click', ()=> setMode(t.getAttribute('data-mode-tab')) ))

  // ===== Validações =====
  function markField(el, ok, msg){
    if(!el) return
    let wrap = el.closest('.field')
    if(!wrap) return
    let hint = wrap.querySelector('.field-msg')
    if(!hint){
      hint = document.createElement('div')
      hint.className='field-msg'
      wrap.appendChild(hint)
    }
    if(ok){
      wrap.classList.remove('invalid')
      wrap.classList.add('valid')
      hint.textContent = msg || 'Ok'
    } else {
      wrap.classList.remove('valid')
      wrap.classList.add('invalid')
      hint.textContent = msg || 'Verifique'
    }
  }

  function validateEmail(){
    const val = (email.value||'').trim()
    const ok = /.+@.+\..+/.test(val)
    markField(email, ok, ok?'Email válido':'Email inválido')
    return ok
  }
  function validatePassword(){
    const val = (pass.value||'')
    const ok = val.length >= 6
    markField(pass, ok, ok? 'Senha ok':'Mínimo 6 caracteres')
    return ok
  }
  function validatePassword2(){
    if(form.dataset.mode !== 'register') return true
    const val = (pass2.value||'')
    const ok = val && val === pass.value
    markField(pass2, ok, ok? 'Ok':'Não coincide')
    return ok
  }
  function validateName(){
    if(form.dataset.mode !== 'register') return true
    const val = (regName.value||'').trim()
    const ok = val.length >= 2
    markField(regName, ok, ok? 'Ok':'Muito curto')
    return ok
  }

  email.addEventListener('input', validateEmail)
  pass.addEventListener('input', ()=>{ validatePassword(); updatePwStrength(); if(form.dataset.mode==='register') validatePassword2() })
  pass2?.addEventListener('input', validatePassword2)
  regName?.addEventListener('input', validateName)

  // ===== Força da senha =====
  function scorePassword(p){
    if(!p) return 0
    let score = 0
    if(p.length >= 6) score++
    if(p.length >= 10) score++
    if(/[A-Z]/.test(p) && /[a-z]/.test(p)) score++
    if(/\d/.test(p)) score++
    if(/[^A-Za-z0-9]/.test(p)) score++
    return Math.min(score,4)
  }
  function updatePwStrength(){
    if(!pwMeter || form.dataset.mode!=='register'){ pwMeter.style.display='none'; return }
    pwMeter.style.display='block'
    const s = scorePassword(pass.value||'')
    const pct = (s/4)*100
    pwMeterFill.style.width = pct+'%'
    const labels = ['Muito fraca','Fraca','Média','Boa','Excelente']
    pwMeterFill.dataset.level = String(s)
    pwMeterLabel.textContent = labels[s]
  }

  // ===== Toggle de senha =====
  passToggle?.addEventListener('click', ()=>{
    if(pass.type==='password'){ pass.type='text'; passToggle.textContent='🙈'; passToggle.setAttribute('aria-label','Ocultar senha') }
    else { pass.type='password'; passToggle.textContent='👁'; passToggle.setAttribute('aria-label','Mostrar senha') }
  })

  // ===== Submit =====
  form.addEventListener('submit', async (e)=>{
    e.preventDefault()
    clearErr()
    const vEmail = validateEmail()
    const vPass = validatePassword()
    const vName = validateName()
    const vPass2 = validatePassword2()
    if(!(vEmail && vPass && vName && vPass2)){
      showErr('Corrija os campos destacados.')
      return
    }
    const mode = form.dataset.mode
    try {
      setLoading(true)
      const payload = { email: (email.value||'').trim(), password: pass.value }
      if(mode==='register') payload.confirm = pass2.value
      if(mode==='register' && regName.value.trim()) payload.name = regName.value.trim()
      let endpoint = mode==='register' ? '/auth/register' : '/auth/login'
      const r = await fetch(endpoint, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) })
      if(!r.ok){ const j= await r.json().catch(()=>({})); showErr('Falha '+(mode==='register'?'no registro':'no login')+': '+(j.error||r.status)); return }
      const j = await r.json()
      try {
        localStorage.setItem('auth','ok')
        localStorage.setItem('sessionId', j.sessionId)
        localStorage.setItem('userId', j.userId)
        if(remember?.checked) localStorage.setItem('remember','1')
      } catch {}
      location.replace('/')
    } catch(err){
      showErr('Erro de rede, tente novamente.')
    } finally { setLoading(false) }
  })

  // Redirect se já logado
  try { if(localStorage.getItem('auth')==='ok'){ location.replace('/') } } catch {}

  // Estado inicial
  setMode('login')
  updatePwStrength()
})();
