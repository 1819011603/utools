const sleep = ms => new Promise(r => setTimeout(r, ms))
const t = (await (await fetch('http://127.0.0.1:9222/json/list')).json()).find(x => x.type === 'page' && x.url.includes('/video-player'))
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r))
let id = 0; const pending = new Map(); let events = []
ws.addEventListener('message', e => { const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } else if (m.method) events.push(m) })
const send = (m, p = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const ev = async e => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); return r.result?.exceptionDetails ? 'ERR' : r.result?.result?.value }
await send('Page.enable'); await send('Runtime.enable')
const begins = () => events.filter(e => e.method === 'Page.downloadWillBegin').length
events = []
await ev(`document.querySelector('a[href*="/api/proxy"][download]').click()`); await sleep(900)
console.log('紧接着第二次点击（3 秒内）:')
const before = begins()
await ev(`document.querySelector('a[href*="/api/proxy"][download]').click()`); await sleep(1200)
console.log('  新增 downloadWillBegin:', begins() - before, '(期望 0)')
console.log('  提示:', await ev(`[...document.querySelectorAll('div')].map(d=>d.textContent).find(t=>t?.startsWith('刚刚已经开始'))?.slice(0,40)`))
console.log('  格子上的标记:', await ev(`document.querySelector('a[href*="/api/proxy"][download]')?.textContent?.trim().slice(0,30)`))
console.log('等 3.2 秒后再点（应放行）:')
await sleep(3200); const b2 = begins()
await ev(`document.querySelector('a[href*="/api/proxy"][download]').click()`); await sleep(1500)
console.log('  新增 downloadWillBegin:', begins() - b2, '(期望 1)')
ws.close()
