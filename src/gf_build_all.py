#!/usr/bin/env python3
"""Build a single parametric 'Gridfinity Tool Bin' FeatureScript embedding all
four tool outlines (tool enum), then instantiate it once per tool, each in its
own Part Studio. Renders each. Run with -I:  python3 gf_build_all.py
"""
import sys, os, json, base64, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import onshape

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "out")
CELL = 42.0; GAP = 0.5
TOOLS = [("FLUSHCUTTER", "flushcutter", "Flush cutter"),
         ("NEEDLENOSE",  "needlenose",  "Needle-nose"),
         ("COMBOPLIERS", "combopliers", "Combo pliers"),
         ("STRIPPER",    "stripper",    "Wire stripper")]
HELPERS = open(os.path.join(os.path.dirname(__file__), "gridfinity.fs.tmpl"), encoding="utf-8").read()

def resample(c, n):
    cl = np.vstack([c, c[:1]])
    seg = np.r_[0, np.cumsum(np.sqrt((np.diff(cl, axis=0)**2).sum(1)))]
    u = np.linspace(0, seg[-1], n, endpoint=False)
    return np.c_[np.interp(u, seg, cl[:,0]), np.interp(u, seg, cl[:,1])]

def smooth(c, n=150, sf=0.4):
    """Periodic smoothing spline: rounds sharp corners to a small radius so the
    Onshape interpolating spline stays a clean single edge (no overshoot) and is
    still filletable. Returns n points on the smoothed closed curve."""
    from scipy.interpolate import splprep, splev
    d = resample(c, 400)
    tck, _ = splprep([d[:,0], d[:,1]], s=len(d)*sf, per=1)
    u = np.linspace(0, 1, n, endpoint=False)
    x, y = splev(u, tck)
    return np.c_[x, y]

def clean(c, r=1.0, n=160):
    """Round every corner to radius r (morphological open then close) so the
    Onshape interpolating spline can't overshoot into a razor-thin sliver
    (which cracks the STL). Keeps a smooth, filletable, watertight outline."""
    from shapely.geometry import Polygon
    p = Polygon(c).buffer(-r, join_style=1, quad_segs=16).buffer(2*r, join_style=1, quad_segs=16).buffer(-r, join_style=1, quad_segs=16)
    if p.geom_type == "MultiPolygon":
        p = max(p.geoms, key=lambda g: g.area)
    cc = np.array(p.exterior.coords)[:-1]
    return resample(cc, n)

def tool_block(enum, base):
    pk = np.load(os.path.join(OUT, f"{base}_pocket.npy"))
    pw, ph = pk[:,0].max(), pk[:,1].max()
    nx, ny = int(np.ceil(pw/CELL)), int(np.ceil(ph/CELL))
    c = (pk - [pw/2, ph/2])
    c = c[np.unique(np.linspace(0, len(c)-1, 260).astype(int))]
    pts = ", ".join(f"[{x:.3f}, {y:.3f}]" for x, y in c)
    return nx, ny, f'    if (t == ToolType.{enum}) {{ return {{ "nx" : {nx}, "ny" : {ny}, "pts" : [ {pts} ] }}; }}\n'

def build_fs():
    # take helpers (rrect/rrSketch/makeFoot) + feature from the template, swap the
    # single-tool const header for an enum + toolData, and read NX/NY/POCKET from it.
    body = HELPERS
    # strip the single-tool const header (lines 13-16 region)
    head = body[:body.index("// rounded rectangle")]
    rest = body[body.index("// rounded rectangle"):]
    blocks = "";
    for enum, base, _ in TOOLS:
        _, _, blk = tool_block(enum, base); blocks += blk
    enum_def = ("export enum ToolType { FLUSHCUTTER, NEEDLENOSE, COMBOPLIERS, STRIPPER }\n\n"
                "function toolData(t is ToolType) returns map\n{\n" + blocks +
                '    return { "nx" : 3, "ny" : 4, "pts" : [[0,0],[1,0],[0,1]] };\n}\n\n')
    head = head.replace('// closed tool-pocket outline (mm), centred on origin. __POINTS__ injected.\n'
                        'const NX = __NX__;\nconst NY = __NY__;\nconst POCKET = [ __POINTS__ ];\n', enum_def)
    # feature: add tool param, pull NX/NY/POCKET from toolData
    rest = rest.replace('        annotation { "Name" : "Height (U)" }',
                        '        annotation { "Name" : "Tool" } definition.tool is ToolType;\n'
                        '        annotation { "Name" : "Smooth pocket (spline)", "Default" : true } definition.smoothPocket is boolean;\n'
                        '        annotation { "Name" : "Height (U)" }')
    rest = rest.replace('        const top = definition.heightU * 7 * millimeter;',
                        '        var td = toolData(definition.tool);\n'
                        '        const NX = td.nx; const NY = td.ny; var POCKET = td.pts;\n'
                        '        const top = definition.heightU * 7 * millimeter;')
    return head + rest

def main():
    ids = json.load(open("/tmp/gf_onshape.json", encoding="utf-8")); did, wid = ids["did"], ids["wid"]
    fseid = ids["featurestudio"]
    fs = build_fs()
    open("/tmp/gridfinity_all.fs", "w", encoding="utf-8").write(fs)
    st, _ = onshape.req("POST", f"/featurestudios/d/{did}/w/{wid}/e/{fseid}", {"contents": fs})
    print("push FS HTTP", st)
    st, fsp = onshape.req("GET", f"/featurestudios/d/{did}/w/{wid}/e/{fseid}/featurespecs")
    if not (isinstance(fsp, dict) and fsp.get("featureSpecs")):
        print("COMPILE FAIL"); return
    micro = onshape.req("GET", f"/documents/d/{did}/w/{wid}/elements?elementId={fseid}")[1][0]["microversionId"]
    ns = f"e{fseid}::m{micro}"

    ps_map = ids.get("ps_map", {})
    ps_map["flushcutter"] = ids["partstudio"]           # reuse original PS
    # ensure a Part Studio per tool
    for enum, base, label in TOOLS:
        if base not in ps_map:
            st, el = onshape.req("POST", f"/partstudios/d/{did}/w/{wid}", {"name": label})
            ps_map[base] = el["id"]; print("created PS", label, el["id"])
    ids["ps_map"] = ps_map; ids["ns"] = ns; json.dump(ids, open("/tmp/gf_onshape.json","w", encoding="utf-8"))

    for enum, base, label in TOOLS:
        ps = ps_map[base]
        st, f = onshape.req("GET", f"/partstudios/d/{did}/w/{wid}/e/{ps}/features")
        for fe in f.get("features", []):
            fid = fe.get("featureId")
            if fid: onshape.req("DELETE", f"/partstudios/d/{did}/w/{wid}/e/{ps}/features/featureid/{fid}")
        smooth = base != "stripper"     # stripper -> exact polyline (watertight); others -> smooth spline
        feat = {"feature": {"btType":"BTMFeature-134","featureType":"gridfinityToolBin","name":f"{label} bin","namespace":ns,
                "parameters":[
                    {"btType":"BTMParameterEnum-145","parameterId":"tool","value":enum,"enumName":"ToolType","namespace":ns},
                    {"btType":"BTMParameterBoolean-144","parameterId":"smoothPocket","value":smooth},
                    {"btType":"BTMParameterQuantity-147","parameterId":"heightU","expression":"3"},
                    {"btType":"BTMParameterQuantity-147","parameterId":"floor","expression":"2.25 mm"},
                    {"btType":"BTMParameterQuantity-147","parameterId":"fillet","expression":"0.125 in"},
                ]}}
        st, r = onshape.req("POST", f"/partstudios/d/{did}/w/{wid}/e/{ps}/features", feat)
        st2, f2 = onshape.req("GET", f"/partstudios/d/{did}/w/{wid}/e/{ps}/features")
        states = {k: v.get("featureStatus") for k, v in (f2.get("featureStates") or {}).items()}
        ok = all(v == "OK" for v in states.values())
        q = "outputHeight=600&outputWidth=820&viewMatrix=isometric&pixelSize=0&showPlanes=false"
        st3, img = onshape.req("GET", f"/partstudios/d/{did}/w/{wid}/e/{ps}/shadedviews?{q}")
        p = f"/tmp/gf_{base}.png"
        if isinstance(img, dict) and img.get("images"):
            open(p,"wb").write(base64.b64decode(img["images"][0]))
        print(f"{label}: add={st} {'OK' if ok else states}  render={'ok' if os.path.exists(p) else 'fail'}")

if __name__ == "__main__": main()
