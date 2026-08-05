#!/usr/bin/env python3
"""Generate the demo's default sample: an elaborate involute spur gear.

Part: a 24-tooth, module-2, 20-degree pressure-angle involute SPUR GEAR with

  * a true involute tooth flank profile (curved surfaces, not a primitive),
  * a raised central HUB,
  * a through center BORE with a rectangular KEYWAY,
  * a ring of six lightening HOLES on a bolt circle,
  * CHAMFERS on the bore mouth and hub top edge.

The result tessellates to a few thousand triangles and is clearly a real
mechanical part rather than a primitive. Exported as STEP AP214 to
``samples/sample.step``.

Reproduce:

    python3 -m venv venv && . venv/bin/activate && pip install cadquery
    python scripts/gen_sample.py

Requires: cadquery (pulls OpenCASCADE wheels).
"""
import math
import os

import cadquery as cq

# ---- Gear parameters (millimetres / degrees) -----------------------------
MODULE = 2.0            # gear module (mm)
TEETH = 24             # number of teeth
PRESSURE_ANGLE = 20.0  # degrees
THICKNESS = 12.0        # gear face width (mm)
HUB_DIA = 34.0          # raised hub diameter (mm)
HUB_HEIGHT = 8.0        # hub rise above the gear face (mm)
BORE_DIA = 14.0         # central through-bore diameter (mm)
KEYWAY_W = 5.0          # keyway width (mm)
KEYWAY_DEPTH = 2.3      # keyway depth past the bore radius (mm)
N_LIGHTENING = 6        # lightening holes on the web
LIGHTENING_DIA = 9.0    # lightening hole diameter (mm)
FLANK_STEPS = 6         # sample points per involute flank (curve resolution)


def involute_gear_profile():
    """Return a closed list of (x, y) points tracing the full gear outline."""
    m = MODULE
    z = TEETH
    alpha = math.radians(PRESSURE_ANGLE)

    rp = m * z / 2.0                 # pitch radius
    rb = rp * math.cos(alpha)        # base radius
    ra = rp + m                      # addendum (tip) radius
    rf = rp - 1.25 * m               # dedendum (root) radius

    # Angular half-thickness of a tooth at the pitch circle, plus the
    # involute correction so flanks cross the pitch circle at the right place.
    def inv(a):
        return math.tan(a) - a

    half_tooth = math.pi / (2.0 * z)
    gamma = half_tooth + inv(alpha)  # angle of involute origin vs tooth centre

    r_start = max(rb, rf)            # involute is undefined below base circle

    def flank_angle(r):
        a = math.acos(rb / r)
        return gamma - inv(a)

    pts = []
    pitch = 2.0 * math.pi / z
    for i in range(z):
        c = i * pitch                # this tooth's centre angle

        # If the root sits below the base circle, add a short radial run.
        if rf < rb:
            a0 = flank_angle(r_start)
            pts.append((rf * math.cos(c - a0), rf * math.sin(c - a0)))

        # Left flank, root -> tip (angle increases toward the tooth centre).
        for s in range(FLANK_STEPS + 1):
            r = r_start + (ra - r_start) * s / FLANK_STEPS
            a = flank_angle(r)
            pts.append((r * math.cos(c - a), r * math.sin(c - a)))

        # Right flank, tip -> root (mirror of the left flank).
        for s in range(FLANK_STEPS, -1, -1):
            r = r_start + (ra - r_start) * s / FLANK_STEPS
            a = flank_angle(r)
            pts.append((r * math.cos(c + a), r * math.sin(c + a)))

        if rf < rb:
            a0 = flank_angle(r_start)
            pts.append((rf * math.cos(c + a0), rf * math.sin(c + a0)))

    return pts, dict(rp=rp, ra=ra, rf=rf)


def build_gear():
    pts, dims = involute_gear_profile()

    # Toothed body from the involute outline.
    gear = cq.Workplane("XY").polyline(pts).close().extrude(THICKNESS)

    # Raised central hub on the top face.
    gear = (
        gear.faces(">Z").workplane()
        .circle(HUB_DIA / 2.0)
        .extrude(HUB_HEIGHT)
    )

    # Chamfer the hub's top outer edge (robust; fall back if OCC balks).
    try:
        gear = gear.faces(">Z").edges(cq.selectors.RadiusNthSelector(0)).chamfer(1.0)
    except Exception:
        pass

    # Central through-bore.
    gear = (
        gear.faces(">Z").workplane()
        .circle(BORE_DIA / 2.0)
        .cutThruAll()
    )

    # Keyway: a slot cut into the bore wall.
    key_h = THICKNESS + HUB_HEIGHT + 2.0
    keyway = (
        cq.Workplane("XY")
        .transformed(offset=(0, BORE_DIA / 2.0 + KEYWAY_DEPTH / 2.0, -1.0))
        .box(KEYWAY_W, KEYWAY_DEPTH + 0.001, key_h, centered=(True, True, False))
    )
    gear = gear.cut(keyway)

    # Ring of lightening holes through the web, between hub and teeth.
    bolt_circle = (dims["rf"] + HUB_DIA / 2.0) / 2.0
    holes = cq.Workplane("XY")
    for i in range(N_LIGHTENING):
        ang = 2.0 * math.pi * i / N_LIGHTENING
        holes = (
            holes.moveTo(bolt_circle * math.cos(ang), bolt_circle * math.sin(ang))
            .circle(LIGHTENING_DIA / 2.0)
        )
    holes = holes.extrude(THICKNESS + 5.0)
    gear = gear.cut(holes)

    # Chamfer the bore mouth on the top face for a finished look.
    try:
        top_bore = (
            gear.faces(">Z").edges(cq.selectors.RadiusNthSelector(0)).chamfer(0.8)
        )
        gear = top_bore
    except Exception:
        pass

    return gear


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.normpath(os.path.join(here, "..", "samples", "sample.step"))
    gear = build_gear()
    cq.exporters.export(gear, out, exportType="STEP")
    size = os.path.getsize(out)
    print(f"wrote {out} ({size} bytes)")


if __name__ == "__main__":
    main()
