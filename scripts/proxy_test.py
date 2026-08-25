"""
从远程代理池列表下载代理，测试哪些能访问目标网页，以及每个可用代理能连续访问多少次。
结果写入一个 HTML 报告。

用法：
    python scripts/proxy_test.py
"""

import concurrent.futures
import datetime
import html
import sys
import time

import requests

# Windows 控制台默认 GBK，代理报错信息里常带非 GBK 字符，直接 print 会崩
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

TARGET_URL = "https://www.24bit.net/music/c/ffd42eb95819da57e5daaaadf5905bfe"
PROXY_LIST_URL = "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    )
}

CONNECT_TIMEOUT = 5
READ_TIMEOUT = 6
# 同一瞬间对几十个陌生 IP 建连，会把家用路由器的连接跟踪表/带宽打满，
# 表现为「整台机器网络都卡」——踩过一次坑，并发必须压低，宁可跑得慢一点。
PROBE_WORKERS = 10
STRESS_WORKERS = 3             # 连续请求阶段，多个可用代理并行测，但每个代理内部仍是串行
MAX_SEQUENTIAL_REQUESTS = 20   # 每个可用代理最多连续打多少次
REQUEST_INTERVAL = 0.3         # 单个代理内，连续请求之间的间隔
MAX_PROXIES_TO_LOAD = None     # None = 不截断，全量测试


def fetch_proxy_list(url: str):
    print(f"下载代理列表: {url}")
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    proxies = [line.strip() for line in resp.text.splitlines() if line.strip()]
    if MAX_PROXIES_TO_LOAD:
        proxies = proxies[:MAX_PROXIES_TO_LOAD]
    print(f"共 {len(proxies)} 个代理")
    return proxies


def probe_proxy(proxy: str):
    """单次探测：这个代理能不能通过 http/https 拿到目标页面。"""
    proxies = {"http": f"http://{proxy}", "https": f"http://{proxy}"}
    start = time.time()
    try:
        resp = requests.get(
            TARGET_URL,
            proxies=proxies,
            headers=HEADERS,
            timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
        )
        elapsed = time.time() - start
        return {
            "proxy": proxy,
            "ok": resp.status_code < 400,
            "status": resp.status_code,
            "elapsed": round(elapsed, 2),
            "error": None,
        }
    except Exception as e:  # noqa: BLE001 — 探测阶段任何异常都算这个代理不可用
        elapsed = time.time() - start
        return {
            "proxy": proxy,
            "ok": False,
            "status": None,
            "elapsed": round(elapsed, 2),
            "error": f"{type(e).__name__}: {e}",
        }


def probe_all(proxies):
    print(f"[1/2] 并发探测 {len(proxies)} 个代理是否可达目标页面...")
    results = []
    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=PROBE_WORKERS) as pool:
        futures = {pool.submit(probe_proxy, p): p for p in proxies}
        for fut in concurrent.futures.as_completed(futures):
            r = fut.result()
            results.append(r)
            done += 1
            if r["ok"]:
                print(f"  [{done}/{len(proxies)}] OK   {r['proxy']:<24} "
                      f"status={r['status']} time={r['elapsed']}s")
            elif done % 100 == 0:
                print(f"  [{done}/{len(proxies)}] 进度中...")
    return results


def stress_one_proxy(proxy: str, max_requests: int):
    """连续请求某个代理，直到失败或达到上限，记录能扛几次。"""
    proxies = {"http": f"http://{proxy}", "https": f"http://{proxy}"}
    attempts = []
    success_count = 0
    for i in range(1, max_requests + 1):
        start = time.time()
        try:
            resp = requests.get(
                TARGET_URL,
                proxies=proxies,
                headers=HEADERS,
                timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
            )
            elapsed = round(time.time() - start, 2)
            ok = resp.status_code < 400
            attempts.append({
                "seq": i, "ok": ok, "status": resp.status_code,
                "elapsed": elapsed, "error": None,
            })
            if ok:
                success_count += 1
            else:
                break
        except Exception as e:  # noqa: BLE001
            elapsed = round(time.time() - start, 2)
            attempts.append({
                "seq": i, "ok": False, "status": None,
                "elapsed": elapsed, "error": f"{type(e).__name__}: {e}",
            })
            break
        time.sleep(REQUEST_INTERVAL)
    print(f"  {proxy}: 连续成功 {success_count} 次")
    return {"proxy": proxy, "success_count": success_count, "attempts": attempts}


def stress_all(ok_proxies, max_requests):
    print(f"[2/2] 对 {len(ok_proxies)} 个可用代理逐个做连续请求测试（每个最多 {max_requests} 次）...")
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=STRESS_WORKERS) as pool:
        futures = {pool.submit(stress_one_proxy, p, max_requests): p for p in ok_proxies}
        for fut in concurrent.futures.as_completed(futures):
            results.append(fut.result())
    results.sort(key=lambda r: r["success_count"], reverse=True)
    return results


def render_html(probe_results, stress_results, out_path):
    ok_list = [r for r in probe_results if r["ok"]]
    fail_list = [r for r in probe_results if not r["ok"]]

    def probe_rows(rows):
        out = []
        for r in rows:
            out.append(
                "<tr>"
                f"<td>{html.escape(r['proxy'])}</td>"
                f"<td>{'可用' if r['ok'] else '不可用'}</td>"
                f"<td>{r['status'] if r['status'] is not None else '-'}</td>"
                f"<td>{r['elapsed']}s</td>"
                f"<td>{html.escape(r['error'] or '')}</td>"
                "</tr>"
            )
        return "\n".join(out)

    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    stress_summary_rows = ""
    stress_detail_sections = ""
    for r in stress_results:
        stress_summary_rows += (
            "<tr>"
            f"<td>{html.escape(r['proxy'])}</td>"
            f"<td>{r['success_count']}</td>"
            f"<td>{len(r['attempts'])}</td>"
            "</tr>\n"
        )
        detail_rows = ""
        for a in r["attempts"]:
            detail_rows += (
                "<tr>"
                f"<td>{a['seq']}</td>"
                f"<td>{'成功' if a['ok'] else '失败'}</td>"
                f"<td>{a['status'] if a['status'] is not None else '-'}</td>"
                f"<td>{a['elapsed']}s</td>"
                f"<td>{html.escape(a['error'] or '')}</td>"
                "</tr>\n"
            )
        stress_detail_sections += f"""
    <details>
      <summary>{html.escape(r['proxy'])} — 连续成功 {r['success_count']} 次</summary>
      <table>
        <thead><tr><th>#</th><th>结果</th><th>状态码</th><th>耗时</th><th>错误信息</th></tr></thead>
        <tbody>
        {detail_rows}
        </tbody>
      </table>
    </details>
"""

    if stress_results:
        stress_section = f"""
    <h2>连续请求测试汇总（每个可用代理）</h2>
    <table>
      <thead><tr><th>代理</th><th>连续成功次数</th><th>共尝试次数</th></tr></thead>
      <tbody>
      {stress_summary_rows}
      </tbody>
    </table>

    <h2>连续请求测试明细（点击展开）</h2>
    {stress_detail_sections}
"""
    else:
        stress_section = "<h2>连续请求测试</h2><p>没有探测到可用代理，跳过。</p>"

    doc = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>代理池测试报告</title>
<style>
  body {{ font-family: -apple-system, "Microsoft YaHei", sans-serif; margin: 24px; color: #222; }}
  h1 {{ font-size: 20px; }}
  h2 {{ font-size: 16px; margin-top: 32px; }}
  table {{ border-collapse: collapse; width: 100%; margin-top: 8px; font-size: 13px; }}
  th, td {{ border: 1px solid #ddd; padding: 6px 8px; text-align: left; }}
  th {{ background: #f5f5f5; }}
  tr:nth-child(even) {{ background: #fafafa; }}
  .meta {{ color: #666; font-size: 13px; }}
  details {{ margin: 6px 0; border: 1px solid #eee; border-radius: 4px; padding: 4px 8px; }}
  summary {{ cursor: pointer; font-size: 13px; }}
</style>
</head>
<body>
  <h1>代理池测试报告</h1>
  <p class="meta">目标地址：{html.escape(TARGET_URL)}<br>
  代理来源：{html.escape(PROXY_LIST_URL)}<br>
  生成时间：{now}</p>
  <p>探测总数：{len(probe_results)}，可用：{len(ok_list)}，不可用：{len(fail_list)}</p>

  <h2>探测结果（仅列可用的，不可用的太多不展示明细）</h2>
  <table>
    <thead><tr><th>代理</th><th>是否可用</th><th>状态码</th><th>耗时</th><th>错误信息</th></tr></thead>
    <tbody>
    {probe_rows(ok_list)}
    </tbody>
  </table>

  {stress_section}
</body>
</html>
"""
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(doc)
    print(f"\n报告已写入: {out_path}")


def main():
    proxy_list = fetch_proxy_list(PROXY_LIST_URL)
    probe_results = probe_all(proxy_list)
    ok_proxies = [r["proxy"] for r in probe_results if r["ok"]]

    stress_results = []
    if ok_proxies:
        stress_results = stress_all(ok_proxies, MAX_SEQUENTIAL_REQUESTS)
    else:
        print("没有探测到可用代理，无法做连续请求测试。")

    render_html(probe_results, stress_results, "scripts/proxy_test_report.html")


if __name__ == "__main__":
    main()
