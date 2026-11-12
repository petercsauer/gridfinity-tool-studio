#!/usr/bin/env python3
"""Minimal Onshape REST helper. Reads credentials from ~/.onshape_key
(format ACCESS:SECRET) and never prints them. Run scripts with -I.
Base: cad.onshape.com /api/v10."""
import os, json, base64, urllib.request, urllib.error

BASE="https://cad.onshape.com/api/v10"
_key=open(os.path.expanduser("~/.onshape_key")).read().strip()
_auth="Basic "+base64.b64encode(_key.encode()).decode()

def req(method, path, body=None, headers=None):
    url=path if path.startswith("http") else BASE+path
    data=json.dumps(body).encode() if body is not None else None
    h={"Authorization":_auth,"Accept":"application/json;charset=UTF-8; qs=0.09"}
    if data is not None: h["Content-Type"]="application/json"
    if headers: h.update(headers)
    r=urllib.request.Request(url,data=data,headers=h,method=method)
    try:
        with urllib.request.urlopen(r) as resp:
            raw=resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw=e.read().decode(errors="replace")
        return e.code, raw

def get_bytes(path, accept="application/octet-stream"):
    """GET returning raw bytes (for STL/binary export). Follows redirects,
    re-attaching auth on cross-host hops."""
    url=path if path.startswith("http") else BASE+path
    seen=0
    while True:
        r=urllib.request.Request(url,headers={"Authorization":_auth,"Accept":accept},method="GET")
        try:
            with urllib.request.urlopen(r) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            if e.code in (301,302,303,307,308) and seen<5:
                url=e.headers["Location"]; seen+=1
                if url and not url.startswith("http"): url=BASE+url
                continue
            return e.code, e.read()
