"""
针对前两个稳定代理做更长的连续请求压测（不设人为的小上限）。
复用 proxy_test.py 里的目标地址、超时、请求逻辑。

用法：
    python scripts/proxy_stress_top2.py
"""

import datetime
import html

from proxy_test import TARGET_URL, stress_all

# “不设上限”仍然给一个安全顶，避免脚本失控对目标站点打成千上万次请求。
# 500 次已经远超前一轮测试的 20 次上限，足够看出这两个代理的真实极限。
SAFETY_CAP = 500

PROXIES = [
    "219.142.66.245:9090",
    "120.232.115.170:17981",
]


def render_html(results, out_path):
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    sections = ""
    for r in results:
        rows = ""
        for a in r["attempts"]:
            rows += (
                "<tr>"
                f"<td>{a['seq']}</td>"
                f"<td>{'成功' if a['ok'] else '失败'}</td>"
                f"<td>{a['status'] if a['status'] is not None else '-'}</td>"
                f"<td>{a['elapsed']}s</td>"
                f"<td>{html.escape(a['error'] or '')}</td>"
                "</tr>\n"
            )
        sections += f"""
    <h2>{html.escape(r['proxy'])} — 连续成功 {r['success_count']} 次（共尝试 {len(r['attempts'])} 次，安全上限 {SAFETY_CAP}）</h2>
    <table>
      <thead><tr><th>#</th><th>结果</th><th>状态码</th><th>耗时</th><th>错误信息</th></tr></thead>
      <tbody>
      {rows}
      </tbody>
    </table>
"""
    doc = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>代理压测报告（前二）</title>
<style>
  body {{ font-family: -apple-system, "Microsoft YaHei", sans-serif; margin: 24px; color: #222; }}
  h1 {{ font-size: 20px; }}
  h2 {{ font-size: 15px; margin-top: 32px; }}
  table {{ border-collapse: collapse; width: 100%; margin-top: 8px; font-size: 13px; }}
  th, td {{ border: 1px solid #ddd; padding: 5px 8px; text-align: left; }}
  th {{ background: #f5f5f5; }}
  tr:nth-child(even) {{ background: #fafafa; }}
  .meta {{ color: #666; font-size: 13px; }}
</style>
</head>
<body>
  <h1>代理压测报告（前二稳定代理，无小上限）</h1>
  <p class="meta">目标地址：{html.escape(TARGET_URL)}<br>生成时间：{now}</p>
  {sections}
</body>
</html>
"""
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(doc)
    print(f"\n报告已写入: {out_path}")


def main():
    print(f"并行压测 {PROXIES}（每个最多 {SAFETY_CAP} 次）...")
    results = stress_all(PROXIES, SAFETY_CAP)
    for r in results:
        print(f"  -> {r['proxy']} 连续成功 {r['success_count']} 次")
    render_html(results, "scripts/proxy_stress_top2_report.html")


if __name__ == "__main__":
    main()
