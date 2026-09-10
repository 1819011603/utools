// 临时排查脚本：打开播放器 → 开下载抽屉 → 看「视频 1」那颗按钮的点击到底落在谁身上
const PAGE = 'http://127.0.0.1:3000/video-player?url=' + encodeURIComponent('http://127.0.0.1:3000/test-dl.mp4')

const sleep = ms => new Promise(r => setTimeout(r, ms))

const targets = async () => (await (await fetch('http://127.0.0.1:9222/json/list')).json())
let t = (await targets()).find(x => x.type === 'page' && x.url.includes('/video-player'))
for (let i = 0; !t && i < 20; i++) { await sleep(500); t = (await targets()).find(x => x.type === 'page' && x.url.includes('/video-player')) }
if (!t) { console.log('没找到播放器页面'); process.exit(1) }

const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r))
let id = 0
const pending = new Map()
const events = []
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  else if (m.method) events.push(m)
})
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
const evalJs = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '') }
  return r.result?.result?.value
}

await send('Page.enable')
await send('Network.enable')
await send('Runtime.enable')

console.log('页面：', await evalJs('location.href'))
await sleep(1500)

// 开下载抽屉
console.log('开抽屉：', await evalJs(`(() => {
  const b = [...document.querySelectorAll('button[title="下载"]')][0]
  if (!b) return '没找到顶栏下载按钮'
  b.click(); return 'clicked'
})()`))
await sleep(700)

const info = await evalJs(`(() => {
  const drawer = [...document.querySelectorAll('div')].find(d => d.className.includes?.('z-20') && d.className.includes('inset-0') && d.textContent.includes('下载'))
  const a = document.querySelector('a[href*="/api/proxy"][download]')
  const out = { drawer: null, anchor: null, topAtAnchor: null }
  if (drawer) { const r = drawer.getBoundingClientRect(); out.drawer = { x: r.x, y: r.y, w: r.width, h: r.height, cls: drawer.className.replace(/\\s+/g, ' ') } }
  if (a) {
    const r = a.getBoundingClientRect()
    out.anchor = { x: r.x, y: r.y, w: r.width, h: r.height, href: a.getAttribute('href') }
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2
    const top = document.elementFromPoint(cx, cy)
    out.topAtAnchor = top ? (top.tagName + '.' + String(top.className).slice(0, 90) + ' | inA=' + !!top.closest('a')) : 'null'
    out.stack = document.elementsFromPoint(cx, cy).slice(0, 5).map(e => e.tagName + '.' + String(e.className).slice(0, 50))
  }
  return out
})()`)
console.log(JSON.stringify(info, null, 2))

// 真·鼠标点击（走 CDP 的 Input，跟用户点一模一样）
if (info?.anchor) {
  const cx = info.anchor.x + info.anchor.w / 2, cy = info.anchor.y + info.anchor.h / 2
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: cx, y: cy, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
  }
  await sleep(2000)
  const net = events.filter(e => e.method === 'Network.requestWillBeSent' && e.params.request.url.includes('/api/proxy'))
  const dl = events.filter(e => e.method.startsWith('Page.download') || e.method === 'Browser.downloadWillBegin')
  console.log('点击后 /api/proxy 请求数：', net.length, net.map(n => n.params.request.url.slice(0, 90)))
  console.log('下载事件：', dl.map(d => d.method))
  console.log('页面还在：', await evalJs('location.pathname + location.search.slice(0, 40)'))
}
ws.close()
