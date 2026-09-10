const sleep = ms => new Promise(r => setTimeout(r, ms))
const t = (await (await fetch('http://127.0.0.1:9222/json/list')).json()).find(x => x.type === 'page' && x.url.includes('/video-player'))
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise(r => ws.addEventListener('open', r))
let id = 0; const pending = new Map(); const events = []
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } else if (m.method) events.push(m) })
const send = (m, p = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const ev = async (e, g = true) => (await send('Runtime.evaluate', { expression: e, userGesture: g, returnByValue: true })).result?.result?.value
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
await send('Page.navigate', { url: 'http://127.0.0.1:3000/video-player?url=' + encodeURIComponent('http://127.0.0.1:3000/test-dl.mp4') })
await sleep(4000)
await ev(`document.querySelector('button[title="下载"]').click()`); await sleep(700)
const reqs = () => events.filter(e => e.method === 'Network.requestWillBeSent' && e.params.request.url.includes('dl=1')).length
const dls = () => events.filter(e => e.method === 'Page.downloadWillBegin').length
let r0 = reqs(), d0 = dls()
await ev(`document.querySelector('a[href*="/api/proxy"][download]').click()`); await sleep(1200)
console.log('① 请求 +', reqs() - r0, '下载 +', dls() - d0)
await sleep(3400)
console.log('冷却是否已解除（格子文本）:', await ev(`document.querySelector('a[href*="/api/proxy"][download]').textContent.trim().replace(/\s+/g,' ')`))
r0 = reqs(); d0 = dls()
await ev(`document.querySelector('a[href*="/api/proxy"][download]').click()`); await sleep(1600)
console.log('③ 请求 +', reqs() - r0, '下载 +', dls() - d0)
ws.close()
