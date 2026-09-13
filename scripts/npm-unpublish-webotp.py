#!/usr/bin/env python3
"""
撤销 npm 已发布版本 —— 自己实现「浏览器授权换 OTP」，因此：
  * 不依赖 npm 自己的 HTTP 栈（它在某些网络上会 read ETIMEDOUT）
  * 不自动打开浏览器：把授权链接打出来，人在物理机上授权，脚本自己轮询
  * OTP 会被复用：一次授权可能够做完多个版本（注册表若拒绝复用，脚本会自动再要一次授权）

依据 npm 自己的实现：
  * lib/utils/auth.js 的 otplease：EOTP 且响应体带 authUrl/doneUrl 时，
    webAuthOpener(authUrl, doneUrl) 返回的 token 就是 OTP，然后带 otp 重试原请求。
  * libnpmpublish/lib/unpublish.js：删版本的写入序列是
    GET packument(?_rev) → PUT /<pkg>/-rev/<rev> → GET packument → DELETE <tarball>/-rev/<newrev>

用法：
  python3 ~/npm-unpublish-webotp.py 0.1.0 0.1.1 0.1.2 0.1.3
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

PKG = "dsh-agent-shell"
REG = "https://registry.npmjs.org"
TIMEOUT = 60
OTP_WAIT_SECONDS = 420          # 等授权的上限
POLL_INTERVAL = 3


def read_token() -> str:
    path = os.path.expanduser("~/.npmrc")
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if "_authToken=" in line:
                return line.split("_authToken=", 1)[1].strip()
    sys.exit("~/.npmrc 里没有 _authToken，先完成 npm 登录")


TOKEN = read_token()

# 这几个头是「让注册表给出浏览器授权挑战」的关键 —— 实测差异就在这里：
#   * 只带 authorization/content-type 时，401 的 body 只有一句
#     "You must provide a one-time pass. Upgrade your client to npm@latest…"，
#     且挑战 URL 只出现在 npm-notice 响应头（那个是给安全密钥用的 /login/<uuid>，不是 CLI 的 /auth/cli/<uuid>）
#   * 带上下面这组头之后，401 的 body 才会给出 authUrl + doneUrl，也就是 npm 的 otplease 期待的形状
NPM_HEADERS = {
    "npm-command": "unpublish",
    "npm-auth-type": "web",
    "user-agent": "npm/12.0.2 node/v24.19.0 linux x64 workspaces/false",
    "npm-session": "0123456789abcdef",
}


def call(method, url, body=None, otp=None):
    """返回 (status, 解析后的 body)。url 可以是绝对地址或以 / 开头的路径。"""
    target = url if url.startswith("http") else REG + url
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(target, data=data, method=method)
    request.add_header("authorization", f"Bearer {TOKEN}")
    request.add_header("accept", "application/json")
    for key, value in NPM_HEADERS.items():
        request.add_header(key, value)
    if data is not None:
        request.add_header("content-type", "application/json")
    if otp:
        request.add_header("npm-otp", otp)
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            raw = response.read()
            try:
                return response.status, json.loads(raw or b"{}")
            except Exception:
                return response.status, {}
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            return error.code, json.loads(raw or b"{}")
        except Exception:
            return error.code, {"raw": raw.decode("utf-8", "replace")[:300]}
    except Exception as error:                      # 网络抖动：让调用方决定是否重试
        return 0, {"network": str(error)[:200]}


def get_otp(auth_url, done_url, index):
    print(f"\n{'=' * 74}", flush=True)
    print(f"【第 {index} 次授权】把下面这条链接复制到物理机浏览器打开并授权：\n", flush=True)
    print(f"    {auth_url}\n", flush=True)
    print(f"{'=' * 74}", flush=True)
    print("（脚本正在轮询，授权完成后会自动继续；最多等 7 分钟）\n", flush=True)
    deadline = time.time() + OTP_WAIT_SECONDS
    while time.time() < deadline:
        status, body = call("GET", done_url)
        token = body.get("token") if isinstance(body, dict) else None
        if token:
            print("  ✓ 已收到授权凭据（OTP），继续执行\n", flush=True)
            return token
        time.sleep(POLL_INTERVAL)
    print("  ✗ 等待授权超时", flush=True)
    return None


def write_with_otp(method, url, body, otp_state, label):
    """做一次需要 OTP 的写入；遇到挑战就问人授权，OTP 失效则重新挑战。"""
    for attempt in range(4):
        status, payload = call(method, url, body=body, otp=otp_state["otp"])
        if status in (200, 201):
            return True, payload
        message = json.dumps(payload, ensure_ascii=False) if isinstance(payload, dict) else str(payload)

        auth_url = payload.get("authUrl") if isinstance(payload, dict) else None
        done_url = payload.get("doneUrl") if isinstance(payload, dict) else None
        if status == 401 and auth_url and done_url:
            otp_state["round"] += 1
            token = get_otp(auth_url, done_url, otp_state["round"])
            if token is None:
                return False, payload
            otp_state["otp"] = token
            print(f"  ↻ 带 OTP 重试：{label}", flush=True)
            continue

        # OTP 失效/一次性用尽：注册表这时只回一句普通错误，不再给 authUrl。
        # 处理办法是把 OTP 清掉重发 —— 不带 OTP 的请求才会重新给出挑战。
        if status == 401 and ("one-time pass" in message or "otp" in message.lower()):
            if otp_state["otp"] is not None:
                print("  · 该 OTP 已用尽/失效，重新申请授权", flush=True)
                otp_state["otp"] = None
                continue

        if status == 0:                              # 网络抖动
            print(f"  … 网络抖动，重试 {label}", flush=True)
            time.sleep(3)
            continue
        return False, payload
    return False, {"error": f"{label} 重试四次仍失败"}


def versions_on_registry():
    status, body = call("GET", f"/{PKG}?write=true")
    if status != 200:
        sys.exit(f"读 packument 失败：{status} {body}")
    return body


def unpublish(version, otp_state, dry_run=False):
    print(f"\n── 撤销 {PKG}@{version}", flush=True)
    status, packument = call("GET", f"/{PKG}?write=true")
    if status != 200:
        print(f"  ✗ 读 packument 失败（{status}）", flush=True)
        return False
    versions = packument.get("versions") or {}
    if version not in versions:
        print("  · 该版本已不在注册表上，跳过", flush=True)
        return True
    remaining = [v for v in versions if v != version]
    if not remaining:
        print("  ✗ 这是最后一个版本，本脚本不做整包撤销", flush=True)
        return False
    rev = packument.get("_rev")
    del versions[version]
    for tag in list((packument.get("dist-tags") or {}).keys()):
        if packument["dist-tags"][tag] == version:
            del packument["dist-tags"][tag]
    if packument.get("dist-tags", {}).get("latest") in (None, version):
        packument.setdefault("dist-tags", {})["latest"] = sorted(remaining)[-1]
    packument.pop("_revisions", None)
    packument.pop("_attachments", None)

    if dry_run:
        print("  （预演，不做任何写入）将要执行：", flush=True)
        print(f"    PUT    /{PKG}/-rev/{rev}   ← 写回去掉 {version} 的 packument", flush=True)
        print(f"    剩余版本: {', '.join(remaining)}", flush=True)
        print(f"    dist-tags 将变为: {json.dumps(packument.get('dist-tags', {}), ensure_ascii=False)}", flush=True)
        print(f"    DELETE /{PKG}/-/{PKG}-{version}.tgz/-rev/<新的 _rev>", flush=True)
        return True

    ok, payload = write_with_otp("PUT", f"/{PKG}/-rev/{rev}", packument, otp_state, "写回 packument")
    if not ok:
        print(f"  ✗ 写回 packument 失败：{json.dumps(payload, ensure_ascii=False)[:200]}", flush=True)
        return False
    print("  ✓ 已从 packument 移除该版本", flush=True)

    status, fresh = call("GET", f"/{PKG}?write=true")
    rev2 = fresh.get("_rev") if status == 200 else None
    if not rev2:
        print("  ! 取不到新的 _rev，tarball 可能残留（稍后可重跑本脚本）", flush=True)
        return False
    ok, payload = write_with_otp(
        "DELETE", f"/{PKG}/-/{PKG}-{version}.tgz/-rev/{rev2}", None, otp_state, "删除 tarball"
    )
    if not ok:
        print(f"  ! tarball 删除失败：{json.dumps(payload, ensure_ascii=False)[:200]}", flush=True)
        return False
    print("  ✓ tarball 已删除", flush=True)
    return True


def main():
    args = [a for a in sys.argv[1:]]
    dry_run = "--dry-run" in args
    args = [a for a in args if a != "--dry-run"]
    targets = args or ["0.1.0", "0.1.1", "0.1.2", "0.1.3"]
    if dry_run:
        print("【预演模式】只读，不做任何写入")
    print(f"目标：{', '.join(targets)}")
    print(f"包：{PKG}   凭据：~/.npmrc（{len(TOKEN)} 字符）\n")
    otp_state = {"otp": None, "round": 0}
    results = {}
    for version in targets:
        # 实测：一个 OTP 只够一个版本用（同版本的 PUT+DELETE 两次写入有效，换版本就失效）。
        # 所以每个版本都从「无 OTP」开始，由注册表重新发起一次挑战。
        otp_state["otp"] = None
        results[version] = unpublish(version, otp_state, dry_run)
    print("\n── 汇总")
    for version, ok in results.items():
        print(f"  {version}: {'✓ 已撤销' if ok else '✗ 失败'}")
    status, final = call("GET", f"/{PKG}")
    if status == 200:
        print("\n注册表现状：")
        print("  版本:", ", ".join(final.get("versions", {}).keys()))
        print("  dist-tags:", json.dumps(final.get("dist-tags", {})))
    print(f"\n本次共需要 {otp_state['round']} 次浏览器授权。")
    sys.exit(0 if all(results.values()) else 1)


if __name__ == "__main__":
    main()
