const sleep = ms => new Promise(r => setTimeout(r, ms))
const list = async () => (await (await fetch('http://127.0.0.1:9222/json/list')).json())
let t = (await list()).find(x => x.type === 'page' && x.url.includes('/video-player'))
if (!t) { console.log('没有播放器页面'); process.exit(1) }
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r))
let id = 0; const pending = new Map(); const events = []
ws.addEventListener('message', e => { const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } else if (m.method) events.push(m) })
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
const ev = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value
await send('Page.enable'); await send('Network.enable'); await send('Runtime.enable')
await send('Page.navigate', { url: 'http://127.0.0.1:3000/video-player?url=' + encodeURIComponent('http://127.0.0.1:3000/test-dl.mp4') })
await sleep(3500)
console.log('开抽屉:', await ev(`(()=>{const b=document.querySelector('button[title="下载"]'); if(!b) return '没有下载按钮'; b.click(); return 'ok'})()`))
await sleep(800)
const box = await ev(`(()=>{const a=document.querySelector('a[href*="/api/proxy"][download]'); if(!a) return null; const r=a.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
console.log('按钮位置:', box)
const click = async () => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1 })
}
await click(); await sleep(1500)
console.log('第一次点击 → /api/proxy 请求数:', events.filter(e => e.method === 'Network.requestWillBeSent' && e.params.request.url.includes('/api/proxy')).length)
console.log('格子状态:', await ev(`document.querySelector('a[href*="/api/proxy"][download]')?.innerText.replace(/\n/g,' ')`))
console.log('提示条:', await ev(`[...document.querySelectorAll('div')].map(d=>d.textContent).find(t=>t?.startsWith('已交给浏览器下载'))?.slice(0,60)`))
events.length = 0
await click(); await sleep(1200)
console.log('3 秒内再点 → /api/proxy 请求数:', events.filter(e => e.method === 'Network.requestWillBeSent' && e.params.request.url.includes('/api/proxy')).length)
console.log('提示条:', await ev(`[...document.querySelectorAll('div')].map(d=>d.textContent).find(t=>t?.startsWith('刚刚已经开始'))?.slice(0,60)`))
ws.close()
