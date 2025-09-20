import dns from 'dns'
import { execSync } from 'child_process'

;(async () => {
  try { dns.setDefaultResultOrder?.('ipv4first') } catch {}
  dns.lookup('web.whatsapp.com', { all: true }, (e, a) => console.log('lookup web.whatsapp.com', e || a))
  dns.lookup('g.whatsapp.net', { all: true }, (e, a) => console.log('lookup g.whatsapp.net', e || a))
  try {
    const out = execSync('curl -sS -o /dev/null -w "%{http_code} TLS:%{ssl_verify_result}\\n" https://web.whatsapp.com')
    console.log('curl web.whatsapp.com =>', out.toString().trim())
  } catch (e) {
    console.error('curl web.whatsapp.com falhou')
  }
  try {
    const out2 = execSync('curl -sS -o /dev/null -w "%{http_code} TLS:%{ssl_verify_result}\\n" https://g.whatsapp.net')
    console.log('curl g.whatsapp.net =>', out2.toString().trim())
  } catch (e) {
    console.error('curl g.whatsapp.net falhou')
  }
})()
