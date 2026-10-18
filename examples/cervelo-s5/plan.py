"""Plan accumulator: every action gets an alias; parts are tagged with an aero category, a drag coefficient, a material and
an optional weld group (frame / fork / stem pieces welded later by weld.py with filleted joints)."""

import math

from geom import euler_xyz, rnd, section_frame, frame_point

V_REF, NU_AIR = 40 / 3.6, 1.46e-5
BLUFF = 1.0


def cd_strut(chord, thickness, kamm=False):
    """Hoerner strut / wire fit, frontal-area basis: Cd = 2.66/sqrt(Re)(1 + t/c)(c/t) + t/c (+0.04 for a Kamm tail)."""
    tc = min(1.0, thickness / chord)
    re = V_REF * chord / 1000 / NU_AIR
    return round(2.66 / math.sqrt(re) * (1 + tc) / tc + tc + (0.04 if kamm else 0), 4)


class Plan:
    def __init__(self):
        self.actions = []
        self.parts = {}  # alias -> {category, cd, material, weld}
        self.n = 0

    def add(self, command, params, category=None, cd=BLUFF, material=None, weld=None, alias=None):
        self.n += 1
        alias = alias or f"p{self.n}"
        self.actions.append({"command": command, "params": params, "as": alias})
        if category:
            self.parts[alias] = {"category": category, "cd": cd, "material": material, "weld": weld}
        return alias

    def raw(self, command, params, alias=None):
        return self.add(command, params, alias=alias)

    # ------------------------------------------------------------ solids from section stations

    def loft(self, stations, category, cd, material, weld=None, color="#202020", chord_hint=None, ruled=False):
        """stations: [(centre, tangent, outline)] -> smooth loft, each section normal to its tangent, chord toward `chord_hint`."""
        sections = []
        for centre, tangent, outline, *hint in stations:
            ex, ey, ez = section_frame(tangent, hint[0] if hint else (chord_hint or [1.0, 0.0, 0.0]))
            sections.append({"center": rnd(centre), "rotation": euler_xyz(ex, ey, ez), "section": outline})
        return self.add("loft_sections", {"sections": sections, "ruled": ruled, "color": color}, category, cd, material, weld)

    def cage(self, vertices, faces, category, cd, material, color="#202020", levels=2, name=None):
        params = {"vertices": vertices, "faces": faces, "levels": levels, "color": color}
        if name:
            params["name"] = name
        return self.add("add_subdivision_solid", params, category, cd, material)

    def revolve(self, centre_xyz, profile, category, cd, material, color, segments=128):
        return self.add("revolve_profile", {"profile": [[round(r, 3), round(a, 3)] for r, a in profile], "axis": "y",
                                            "position": rnd(centre_xyz), "segments": segments, "color": color}, category, cd, material)

    def plate(self, outline, origin, ex, ey, thickness, category, material, color, cd=BLUFF):
        """Flat part: outline in (ex, ey) extruded `thickness` along ex x ey from origin."""
        from geom import cross

        ez = cross(ex, ey)
        return self.add("extrude_profile", {"profile": outline, "depth": thickness, "position": rnd(origin),
                                            "rotation": euler_xyz(ex, ey, ez), "color": color}, category, cd, material)


__all__ = ["Plan", "cd_strut", "BLUFF", "frame_point"]
