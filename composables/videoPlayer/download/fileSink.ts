/**
 * 落盘：把一集的字节流写成一个文件。两种实现，同一个接口。
 *
 *  · **流式写盘**（`showDirectoryPicker` + `createWritable`）：一片写一片、内存只留在途的那几片。
 *    一集 500MB~2GB，这是唯一站得住的做法。**只有桌面 Chrome/Edge 有**。
 *  · **Blob 兜底**（Safari / 全部手机浏览器）：整集先攒在内存里，下完才落盘。
 *    所以它**必须封上限**，而且要能在下到 3 片时就按均值把总量**预估**出来 ——
 *    等它下到 80% 再崩掉是最糟的结果（十几分钟白等，还什么都没留下）。
 *
 * 目录句柄**一个手势覆盖整个队列**：每集弹一次保存框，勾了 10 集就要点 10 次，
 * 而那 10 次里有 9 次发生在用户早已切走的时候（弹窗要用户激活，压根弹不出来）。
 *
 * 内部实现模块，走显式相对 import，不进 `imports.dirs`。
 */

/** Blob 兜底的体积上限。桌面 Chrome 的 Blob 会溢到磁盘，手机基本是纯内存、远到不了这个数就被系统杀掉 */
export const BLOB_MAX_BYTES = 3 * 1024 * 1024 * 1024
/** 超过这个数就在任务行上提醒一句「手机上很可能失败」——上限拦不住的那一段风险要让用户看见 */
export const BLOB_WARN_BYTES = 1024 * 1024 * 1024

export interface FileSink {
  /** 按顺序追加一片。抛错即整集失败（比如超了 Blob 上限） */
  write: (chunk: ArrayBuffer) => Promise<void>
  /** 收工落盘 */
  close: () => Promise<void>
  /** 取消：流式的要删掉写了一半的文件，Blob 的直接扔掉内存 */
  abort: () => Promise<void>
  /** 预估总量超上限时提前劝退（返回原因），流式那版恒为空 */
  checkProjected: (projectedBytes: number) => string
  /**
   * **就地覆盖文件开头那一段**（长度必须与原来完全相同），在 `close()` 之前调。
   * 只为一件事：MP4 的时长要等下完才知道，而它写在文件最前面的 `moov` 里
   * （见 `tsToMp4.patchFmp4Duration`）。
   */
  patchStart: (data: ArrayBuffer) => Promise<void>
}

/** 这个浏览器能不能流式写盘。UI 据此决定要不要提醒体积上限 */
export const supportsDiskSink = (): boolean =>
  typeof window !== 'undefined' && typeof (window as any).showDirectoryPicker === 'function'

/**
 * 请一次目录授权，返回目录句柄；用户取消或不支持则返回 null（调用方退回 Blob）。
 * **必须在用户点击的同步调用栈里调**（弹窗要用户激活）。
 */
export const pickDownloadDir = async (): Promise<any | null> => {
  if (!supportsDiskSink()) return null
  try {
    return await (window as any).showDirectoryPicker({ id: 'utools-video-dl', mode: 'readwrite' })
  } catch {
    return null   // 用户点了取消 —— 不是错误，退回 Blob 让他照样能下
  }
}

/** 文件名：剥掉路径分隔符和 Windows 不收的那几个字符，太长的截断（有的站集名是一整句话） */
export const safeFileName = (name: string): string =>
  name.replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').replace(/^\.+/, '').trim().slice(0, 120)
  || 'video'

/** 流式写盘 */
const createDiskSink = async (dirHandle: any, fileName: string): Promise<FileSink> => {
  const fh = await dirHandle.getFileHandle(fileName, { create: true })
  const writable = await fh.createWritable()
  let written = 0
  return {
    write: async chunk => { await writable.write(chunk); written += chunk.byteLength },
    close: async () => { await writable.close() },
    abort: async () => {
      // 先关掉句柄再删：Windows 上文件还开着时 removeEntry 会失败，
      // 留下一个零字节的残片，用户下次看到的是「下过了但播不了」
      try { await writable.abort() } catch { /* 已经关了 */ }
      try { await dirHandle.removeEntry(fileName) } catch { /* 删不掉就留着，比抛错好 */ }
    },
    checkProjected: () => '',
    // 定位写：写完之后**光标要拨回末尾**，否则接着写会从被覆盖的位置继续（把 moov 后面全糊掉）。
    // 眼下只在 close 前调一次，但别把这条依赖留给下一个人踩
    patchStart: async data => {
      await writable.write({ type: 'write', position: 0, data })
      await writable.write({ type: 'seek', position: written })
    },
  }
}

/** Blob 兜底 */
const createBlobSink = (fileName: string): FileSink => {
  let parts: ArrayBuffer[] | null = []
  let bytes = 0
  const overLimit = (n: number) =>
    `预计约 ${(n / 1024 / 1024 / 1024).toFixed(1)}GB，超过内存下载上限 3GB。`
    + '这个浏览器不支持流式写盘（只有桌面版 Chrome/Edge 支持），整集要先攒在内存里。'
    + '换桌面 Chrome/Edge，或换一条码率低些的线路。'

  return {
    write: async chunk => {
      if (!parts) throw new Error('下载已取消')
      bytes += chunk.byteLength
      if (bytes > BLOB_MAX_BYTES) { parts = null; throw new Error(overLimit(bytes)) }
      parts.push(chunk)
    },
    close: async () => {
      if (!parts) throw new Error('下载已取消')
      const blob = new Blob(parts, { type: 'video/mp2t' })
      parts = null   // 尽早松手：Blob 已经持有了字节，再留一份引用等于双倍内存
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      a.click()
      // 立刻 revoke 会让下载拿不到数据（Chrome 上是概率性的空文件），留一分钟够浏览器接手
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    },
    abort: async () => { parts = null },
    checkProjected: projected => (projected > BLOB_MAX_BYTES ? overLimit(projected) : ''),
    // 还没拼成 Blob，直接换掉第一块（remux 那条路第一次 write 写的正是 init 段）
    patchStart: async data => {
      if (!parts?.length) return
      if (parts[0]!.byteLength !== data.byteLength) return   // 长度不一致就别动，宁可时长不准
      parts[0] = data
    },
  }
}

/** 有目录句柄就流式写，没有就退回 Blob */
export const createSink = async (dirHandle: any | null, fileName: string): Promise<FileSink> => {
  if (dirHandle) {
    try {
      return await createDiskSink(dirHandle, fileName)
    } catch (e: any) {
      // 授权过期/被撤销/磁盘满 → 说清楚，别悄悄退回 Blob 把内存吃光
      throw new Error('写文件失败：' + (e?.message || '无法在所选目录创建文件'))
    }
  }
  return createBlobSink(fileName)
}
