# sites

> 从 CLAUDE.md 下沉的细节（原样保留）。需要时再读。

## 各站实测结论

- **nbmovie 系（4kvm / ziziys）**：同一套程序换皮，接同族站点只需往 `PATTERN` 和 `CODED_PARSE_SITES` 各加一个域名
  （**两边必须同步**），地址一律从 `ctx.pageUrl` 的 origin 现拼。真实地址由 wasm 的 `build_play_url` 生成，
  **令牌 `k` 来自页面里的 `userlink`**（少了 401）；**wasm 会读 `<meta id="nb-plt">` 当时间戳，每次签名前都要刷新**。
  wasm 传 **ArrayBuffer** 避开 MIME 校验。**别用剥标签的办法取集名**（属性里有 `=>`，`<[^>]*>` 会断在中间）
- **MacCMS 系（ylsp / netflixgc）**：地址在 `player_aaaa` 的 `url` 里。**`encrypt` 决定编码但不要按它分支**
  （同站不同线路可以不同）→ `sourceDecode: 'maccms'` 自适应剥到 http 开头、**层数硬封在 2 层**。
  **当前线路的 class 标记各站不同**（`activeFlagRe`，认错不报错只是悄悄落到第一条）。
  **选集容器不能用 `</div>` 收尾**（当前集的 `<a>` 里嵌了 `<div>` → 整条线路只剩 1 集）。
  **防盗链域名可以跟播放页毫无关系且不该写死** → `playerOrigin` 从站点播放器配置里现取
- **kpkuang**：地址在 `data-play`（**随机前缀 + base64** → `base64-scan`）。**防盗链域名每条线路一份**
  （写在 `data-pars` 上）→ **绝不能按 host 缓存**。26 条线路里 4 条给的是第三方播放页 → `sourceMediaOnly: true`
  （**这类做不到**：地址由第三方在浏览器里用混淆 JS 现算）
- **内嵌播放器的「反内嵌」自检提示都提 Sandbox，别当成防盗链或正则问题**：EV 线探的是 `document.domain` 在沙箱里必抛，
  **没有 token 可解**（`allow-document-domain` 不是合法 token，加了现象一模一样——别再往那个方向试），
  唯一出路是整个摘掉属性 →「限制广告」开关（**默认关**，iframe 的 `:key` **必须带上它**，sandbox 是文档创建时定死的）。
  追这类问题别猜 flag：**拉下 bundle 搜 `Sandbox`**
