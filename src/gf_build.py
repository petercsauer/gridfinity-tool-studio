#!/usr/bin/env python3
"""Build the gridfinity FeatureScript from the template + a tool's pocket,
push it, (re)instantiate the feature in the Part Studio, report regen state,
render an isometric view. Run with -I:  python3 gf_build.py flushcutter [--u 3]
"""
import sys, os, json, base64, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import onshape

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "out")
CELL = 42.0; GAP = 0.5
TMPL = open(os.path.join(os.path.dirname(__file__), "gridfinity.fs.tmpl"), encoding="utf-8").read()

def main():
    a = sys.argv[1:]; name = a[0] if a and not a[0].startswith("--") else "flushcutter"
    u = int(a[a.index("--u")+1]) if "--u" in a else 3
    ids = json.load(open("/tmp/gf_onshape.json", encoding="utf-8")); did, wid = ids["did"], ids["wid"]
    fseid, ps = ids["featurestudio"], ids["partstudio"]; ns = ids["ns"]

    pk = np.load(os.path.join(OUT, f"{name}_pocket.npy"))
    pw, ph = pk[:,0].max(), pk[:,1].max()
    nx, ny = int(np.ceil(pw/CELL)), int(np.ceil(ph/CELL))
    c = pk - [pw/2, ph/2]                                   # centre
    idx = np.unique(np.linspace(0, len(c)-1, 100).astype(int))
    c = c[idx]
    pts = ", ".join(f"[{x:.3f}, {y:.3f}]" for x, y in c)

    fs = (TMPL.replace("__NX__", str(nx)).replace("__NY__", str(ny)).replace("__POINTS__", pts))
    st, _ = onshape.req("POST", f"/featurestudios/d/{did}/w/{wid}/e/{fseid}", {"contents": fs})
    print("push FS HTTP", st)
    st, fsp = onshape.req("GET", f"/featurestudios/d/{did}/w/{wid}/e/{fseid}/featurespecs")
    if not (isinstance(fsp, dict) and fsp.get("featureSpecs")):
        print("COMPILE FAIL:", str(fsp)[:600]); return
    micro = [e for e in onshape.req("GET", f"/documents/d/{did}/w/{wid}/elements?elementId={fseid}")[1]][0]["microversionId"]
    ns = f"e{fseid}::m{micro}"; ids["ns"] = ns; json.dump(ids, open("/tmp/gf_onshape.json","w", encoding="utf-8"))

    # remove existing custom features, add the gridfinity one
    st, f = onshape.req("GET", f"/partstudios/d/{did}/w/{wid}/e/{ps}/features")
    for fe in f.get("features", []):
        fid = fe.get("featureId") or fe.get("message", {}).get("featureId")
        if fid:
            onshape.req("DELETE", f"/partstudios/d/{did}/w/{wid}/e/{ps}/features/featureid/{fid}")
    feat = {"feature": {"btType":"BTMFeature-134","featureType":"gridfinityToolBin","name":f"{name} bin","namespace":ns,
            "parameters":[
                {"btType":"BTMParameterQuantity-147","parameterId":"heightU","expression":f"{u}"},
                {"btType":"BTMParameterQuantity-147","parameterId":"floor","expression":"2.25 mm"},
                {"btType":"BTMParameterQuantity-147","parameterId":"fillet","expression":"0.125 in"},
            ]}}
    st, r = onshape.req("POST", f"/partstudios/d/{did}/w/{wid}/e/{ps}/features", feat)
    print("add feature HTTP", st, "" if st < 300 else str(r)[:300])

    st, f = onshape.req("GET", f"/partstudios/d/{did}/w/{wid}/e/{ps}/features")
    states = {k: v.get("featureStatus") for k, v in (f.get("featureStates") or {}).items()}
    print("states:", states)
    q = "outputHeight=640&outputWidth=900&viewMatrix=isometric&pixelSize=0&showPlanes=false"
    st, img = onshape.req("GET", f"/partstudios/d/{did}/w/{wid}/e/{ps}/shadedviews?{q}")
    if isinstance(img, dict) and img.get("images"):
        p = f"/tmp/gf_{name}.png"; open(p,"wb").write(base64.b64decode(img["images"][0]))
        print("render ->", p)
    else:
        print("render fail:", str(img)[:200])

if __name__ == "__main__": main()
