"""
《NULL：無聲協定》角色資產產生器（Blender Python／bpy，無介面執行）。

產出（預設寫到 client/public/models/）：
  crew_blind.glb  crew_deaf.glb  crew_mute.glb   三名角色：低多邊形蒙皮網格＋共用骨架（不含動畫）
  crew_anims.glb                                  共用動畫庫：同一副骨架＋全部動畫片段
  manifest.json                                   前端載入設定（模型路徑、骨骼、必要動畫）

這是「程式產生的風格化低多邊形模型」，不是建模師手工雕塑的正式資產：
  - 幾何由多邊形截面放樣（loft）組成，刻意保留稜角（平面著色）。
  - 權重以「每個截面環指定骨骼權重」的方式手動分配，關節處兩根骨骼各半。
  - 貼圖 64×64 以下，程式繪製；前端以 nearest 取樣。
  - 動畫是手寫關鍵影格（30 fps），沒有動作捕捉。

執行：
  pip install bpy==5.2.2           （需要 Python 3.13）
  python3 tools/characters/build_crew.py [輸出資料夾] [--preview 預覽圖資料夾]
"""

import json
import math
import os
import random
import sys

import bpy  # noqa: I001  必須先匯入 bpy，bmesh／mathutils 才能使用
import bmesh
from mathutils import Matrix, Vector

FPS = 30

# --------------------------------------------------------------------------------------
# 骨架（Blender 座標：Z 向上、角色面向 -Y；角色的左手在 +X）
# --------------------------------------------------------------------------------------

J = {
    'hips': (0.0, 0.0, 0.975),
    'spine': (0.0, 0.0, 1.075),
    'chest': (0.0, 0.0, 1.215),
    'neck': (0.0, 0.0, 1.445),
    'head': (0.0, -0.005, 1.535),
    'head_end': (0.0, -0.005, 1.76),
}
for s, sx in (('L', 1), ('R', -1)):
    J[f'clav_{s}'] = (0.03 * sx, 0.0, 1.39)
    J[f'shoulder_{s}'] = (0.195 * sx, 0.01, 1.405)
    J[f'elbow_{s}'] = (0.255 * sx, 0.02, 1.13)
    J[f'wrist_{s}'] = (0.29 * sx, 0.0, 0.88)
    J[f'hand_end_{s}'] = (0.30 * sx, -0.01, 0.78)
    J[f'hip_{s}'] = (0.095 * sx, 0.0, 0.93)
    J[f'knee_{s}'] = (0.10 * sx, -0.005, 0.51)
    J[f'ankle_{s}'] = (0.10 * sx, 0.015, 0.09)
    J[f'toe_{s}'] = (0.10 * sx, -0.11, 0.025)

# (骨骼名稱, 頭, 尾, 父骨骼)
BONES = [
    ('hips', 'hips', 'spine', None),
    ('spine', 'spine', 'chest', 'hips'),
    ('chest', 'chest', 'neck', 'spine'),
    ('neck', 'neck', 'head', 'chest'),
    ('head', 'head', 'head_end', 'neck'),
]
for s in ('L', 'R'):
    BONES += [
        (f'shoulder_{s}', f'clav_{s}', f'shoulder_{s}', 'chest'),
        (f'upperArm_{s}', f'shoulder_{s}', f'elbow_{s}', f'shoulder_{s}'),
        (f'lowerArm_{s}', f'elbow_{s}', f'wrist_{s}', f'upperArm_{s}'),
        (f'hand_{s}', f'wrist_{s}', f'hand_end_{s}', f'lowerArm_{s}'),
        (f'upperLeg_{s}', f'hip_{s}', f'knee_{s}', 'hips'),
        (f'lowerLeg_{s}', f'knee_{s}', f'ankle_{s}', f'upperLeg_{s}'),
        (f'foot_{s}', f'ankle_{s}', f'toe_{s}', f'lowerLeg_{s}'),
    ]
BONE_NAMES = [b[0] for b in BONES]

V = lambda t: Vector(t)  # noqa: E731

# --------------------------------------------------------------------------------------
# 低解析度貼圖（程式繪製）
# --------------------------------------------------------------------------------------


def hex_rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def make_image(name, w, h, painter):
    img = bpy.data.images.new(name, width=w, height=h, alpha=True)
    px = [0.0] * (w * h * 4)

    def put(x, y, rgb, a=1.0):
        if 0 <= x < w and 0 <= y < h:
            i = (y * w + x) * 4
            # 新建的 8 位元影像是 sRGB 色彩空間：pixels 直接存 sRGB 色值（不要再轉成線性，否則會被套兩次 gamma 變得太暗）
            for k in range(3):
                px[i + k] = max(0.0, min(1.0, rgb[k]))
            px[i + 3] = a

    painter(put, w, h)
    img.pixels[:] = px
    img.pack()
    return img


def shade(rgb, k):
    return tuple(c * k for c in rgb)


def fabric_painter(base, seed, seam=True, grime=0.22, stripe=None, noise=0.12):
    """制服布料：基底色＋顆粒、縱向縫線、下半部髒污；stripe＝(v0, v1, 顏色) 反光條"""
    c = hex_rgb(base)

    def paint(put, w, h):
        r = random.Random(seed)
        for y in range(h):
            for x in range(w):
                k = 1.0 + (r.random() - 0.5) * noise
                k *= 1.0 - grime * max(0.0, 0.45 - y / h)  # 越下面越髒
                if seam and (x == w // 2 or x == 0):
                    k *= 0.72
                if (y % 16) == 0:
                    k *= 0.9
                col = shade(c, k)
                if stripe and stripe[0] <= y / h < stripe[1]:
                    col = shade(hex_rgb(stripe[2]), 1.0 + (r.random() - 0.5) * 0.1)
                put(x, y, col)

    return paint


def solid_painter(base, seed, noise=0.1, scuff=0.0):
    c = hex_rgb(base)

    def paint(put, w, h):
        r = random.Random(seed)
        for y in range(h):
            for x in range(w):
                k = 1.0 + (r.random() - 0.5) * noise
                if scuff and r.random() < scuff:
                    k *= 1.25
                put(x, y, shade(c, k))

    return paint


def face_painter(skin, hair, seed):
    """頭部以圓柱投影展開：u=0.5 是臉的正面、u=0/1 是後腦；v 由下（下巴）到上（頭頂）"""
    sk = hex_rgb(skin)
    hr = hex_rgb(hair)
    dark = hex_rgb('#2A2624')

    def paint(put, w, h):
        r = random.Random(seed)
        for y in range(h):
            for x in range(w):
                u = x / w
                v = y / h
                col = shade(sk, 1.0 + (r.random() - 0.5) * 0.06)
                # 頭髮：頭頂與後腦（短髮）
                back = abs(u - 0.5) > 0.27
                if v > 0.80 or (back and v > 0.42) or (abs(u - 0.5) > 0.2 and v > 0.66):
                    col = shade(hr, 1.0 + (r.random() - 0.5) * 0.15)
                # 臉部陰影：側面略暗
                elif abs(u - 0.5) > 0.16:
                    col = shade(col, 0.9)
                put(x, y, col)
        cx = w // 2
        # 簡化的五官：眉、眼（2×2）、鼻影、嘴；只有幾個像素，靠低解析度保留 PS1 的模糊感
        ey = int(h * 0.5)
        for dx in (-6, -5, -4, -3, 2, 3, 4, 5):
            put(cx + dx, ey + 4, shade(hr, 0.85))
        for dx in (-5, -4, 3, 4):
            for dy in (0, 1):
                put(cx + dx, ey + dy, dark)
        for dx in (-6, -3, 2, 5):
            put(cx + dx, ey, shade(sk, 0.78))
        for dy in (1, 2, 3):
            put(cx, ey - dy, shade(sk, 0.8))
            put(cx - 1, ey - dy, shade(sk, 0.9))
        my = int(h * 0.27)
        for dx in (-3, -2, -1, 0, 1, 2):
            put(cx + dx, my, shade(dark, 1.3))
        for dx in (-2, -1, 0, 1):
            put(cx + dx, my - 2, shade(sk, 0.85))
            put(cx + dx, my + 1, shade(sk, 0.9))
    return paint


# 5×7 點陣字（胸前識別牌）
GLYPH = {
    'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    'B': ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    'C': ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
}


def badge_painter(letter, bg, fg):
    b = hex_rgb(bg)
    f = hex_rgb(fg)

    def paint(put, w, h):
        for y in range(h):
            for x in range(w):
                edge = x == 0 or y == 0 or x == w - 1 or y == h - 1
                put(x, y, shade(f, 0.8) if edge else b)
        rows = GLYPH[letter]
        ox = (w - 5) // 2
        oy = (h - 7) // 2
        for ry, row in enumerate(rows):
            for rx, ch in enumerate(row):
                if ch == '1':
                    put(ox + rx, oy + (6 - ry), f)

    return paint


def make_material(name, image, roughness=0.92, metallic=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get('Principled BSDF')
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metallic
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = image
    tex.interpolation = 'Closest'
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    return mat


# --------------------------------------------------------------------------------------
# 網格建構：截面放樣
# --------------------------------------------------------------------------------------


class Builder:
    def __init__(self):
        self.verts = []
        self.weights = []
        self.faces = []  # (indices, uvs, material slot)
        self.slots = []

    def slot(self, name):
        if name not in self.slots:
            self.slots.append(name)
        return self.slots.index(name)

    def vert(self, co, w):
        self.verts.append(Vector(co))
        total = sum(w.values()) or 1.0
        self.weights.append({k: v / total for k, v in w.items() if v > 0})
        return len(self.verts) - 1

    def face(self, idx, uvs, mat):
        self.faces.append((list(idx), list(uvs), self.slot(mat)))


def frame_for(t):
    t = t.normalized()
    ref = Vector((1, 0, 0)) if abs(t.x) < 0.9 else Vector((0, 1, 0))
    u = (ref - t * ref.dot(t)).normalized()
    v = t.cross(u).normalized()
    return u, v


def loft(b, rings, mat, sides=8, phase=0.0, cap0=True, cap1=True, v0=0.0, v1=1.0):
    """
    rings：[{'c': (x,y,z), 'rx': 半徑, 'ry': 半徑, 'w': {骨骼: 權重} 或 函式(角度)->dict}]
    沿截面中心連線計算局部座標框；每個環有 sides 個頂點；UV：u＝環上的位置、v＝沿長度。
    """
    centers = [V(r['c']) for r in rings]
    n = len(rings)
    # 每個環的切線取前後中心的差；座標框沿著放樣方向「平行移動」，相鄰的環不會突然扭轉
    frames = []
    u_prev = None
    for i in range(n):
        a = centers[max(0, i - 1)]
        c = centers[min(n - 1, i + 1)]
        t = (c - a).normalized()
        if u_prev is None:
            u, v = frame_for(t)
        else:
            u = u_prev - t * u_prev.dot(t)
            if u.length < 1e-4:
                u, v = frame_for(t)
            else:
                u = u.normalized()
                v = t.cross(u).normalized()
        u_prev = u
        frames.append((u, v))
    lengths = [0.0]
    for i in range(1, n):
        lengths.append(lengths[-1] + (centers[i] - centers[i - 1]).length)
    total = lengths[-1] or 1.0
    ids = []
    for i, r in enumerate(rings):
        u, v = r.get('frame', frames[i])
        row = []
        for k in range(sides):
            a = phase + 2 * math.pi * k / sides
            p = centers[i] + u * (r['rx'] * math.cos(a)) + v * (r['ry'] * math.sin(a))
            w = r['w'](a, p) if callable(r['w']) else r['w']
            row.append(b.vert(p, w))
        ids.append(row)
    for i in range(n - 1):
        va = v0 + (v1 - v0) * lengths[i] / total
        vb = v0 + (v1 - v0) * lengths[i + 1] / total
        for k in range(sides):
            k2 = (k + 1) % sides
            ua = k / sides
            ub = (k + 1) / sides
            b.face([ids[i][k], ids[i][k2], ids[i + 1][k2], ids[i + 1][k]], [(ua, va), (ub, va), (ub, vb), (ua, vb)], mat)
    for cap, row, vv in ((cap0, ids[0], v0), (cap1, ids[-1], v1)):
        if not cap:
            continue
        uvs = [(0.5 + 0.5 * math.cos(2 * math.pi * k / sides) * 0.3, vv) for k in range(sides)]
        b.face(row if cap is True else row, uvs, mat)
    return ids


def box(b, center, size, mat, w, rot=None):
    """有方向的方塊（rot：Matrix 3×3）"""
    cx, cy, cz = center
    sx, sy, sz = (s / 2 for s in size)
    m = rot or Matrix.Identity(3)
    corners = []
    for dz in (-1, 1):
        for dy in (-1, 1):
            for dx in (-1, 1):
                p = Vector((cx, cy, cz)) + m @ Vector((dx * sx, dy * sy, dz * sz))
                corners.append(b.vert(p, w))
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    for q in f:
        b.face([corners[i] for i in q], [(0, 0), (1, 0), (1, 1), (0, 1)], mat)


def cylinder(b, a, c, r, mat, w, sides=8, r2=None):
    """從 a 到 c 的圓柱（截錐）"""
    loft(b, [{'c': a, 'rx': r, 'ry': r, 'w': w}, {'c': c, 'rx': r2 or r, 'ry': r2 or r, 'w': w}], mat, sides=sides)


def mix(a, b_, t):
    return tuple(x + (y - x) * t for x, y in zip(a, b_))


def lerpw(wa, wb, t):
    out = {}
    for k, v in wa.items():
        out[k] = out.get(k, 0) + v * (1 - t)
    for k, v in wb.items():
        out[k] = out.get(k, 0) + v * t
    return out


# --------------------------------------------------------------------------------------
# 人體（制服底層）
# --------------------------------------------------------------------------------------


def side_weight(base, left, right, spread=0.5):
    """依頂點在左右哪一側，把一部分權重分給左／右腿（用在胯下與外套下襬）"""

    def f(_a, p):
        w = dict(base)
        t = max(0.0, min(1.0, abs(p.x) / 0.16)) * spread
        if p.x > 0:
            w[left] = w.get(left, 0) + t
        else:
            w[right] = w.get(right, 0) + t
        return w

    return f


def build_body(b, suit='suit'):
    # 軀幹：胯、臀、腰帶、腰、胸、肩
    loft(b, [
        {'c': (0, 0.005, 0.86), 'rx': 0.12, 'ry': 0.085, 'w': side_weight({'hips': 1}, 'upperLeg_L', 'upperLeg_R', 0.9)},
        {'c': (0, 0.008, 0.93), 'rx': 0.165, 'ry': 0.11, 'w': side_weight({'hips': 1}, 'upperLeg_L', 'upperLeg_R', 0.35)},
        {'c': (0, 0.005, 1.0), 'rx': 0.17, 'ry': 0.115, 'w': {'hips': 1}},
        {'c': (0, 0.0, 1.075), 'rx': 0.158, 'ry': 0.108, 'w': {'hips': 0.5, 'spine': 0.5}},
        {'c': (0, 0.0, 1.15), 'rx': 0.152, 'ry': 0.104, 'w': {'spine': 1}},
        {'c': (0, -0.005, 1.235), 'rx': 0.172, 'ry': 0.118, 'w': {'spine': 0.4, 'chest': 0.6}},
        {'c': (0, -0.008, 1.32), 'rx': 0.19, 'ry': 0.128, 'w': {'chest': 1}},
        {'c': (0, -0.002, 1.395), 'rx': 0.198, 'ry': 0.118, 'w': {'chest': 1}},
        {'c': (0, 0.005, 1.44), 'rx': 0.13, 'ry': 0.092, 'w': {'chest': 0.7, 'neck': 0.3}},
    ], suit, sides=8, phase=math.pi / 8)
    # 衣領
    loft(b, [
        {'c': (0, 0.008, 1.425), 'rx': 0.088, 'ry': 0.078, 'w': {'chest': 1}},
        {'c': (0, 0.01, 1.47), 'rx': 0.072, 'ry': 0.066, 'w': {'chest': 0.4, 'neck': 0.6}},
    ], suit, sides=8, cap0=False, cap1=False)
    # 頸
    loft(b, [
        {'c': (0, 0.008, 1.43), 'rx': 0.057, 'ry': 0.055, 'w': {'chest': 0.3, 'neck': 0.7}},
        {'c': (0, 0.0, 1.55), 'rx': 0.054, 'ry': 0.056, 'w': {'neck': 0.4, 'head': 0.6}},
    ], 'face', sides=6, v0=0.0, v1=0.2)
    # 頭（臉朝 -Y，略往前）
    hw = {'head': 1}
    head_rings = [
        ((0, -0.02, 1.535), 0.045, 0.048),
        ((0, -0.03, 1.565), 0.068, 0.072),
        ((0, -0.012, 1.615), 0.083, 0.094),
        ((0, -0.005, 1.66), 0.087, 0.1),
        ((0, 0.0, 1.705), 0.083, 0.097),
        ((0, 0.005, 1.742), 0.065, 0.078),
        ((0, 0.008, 1.765), 0.03, 0.036),
    ]
    loft(b, [{'c': c, 'rx': rx, 'ry': ry, 'w': hw} for c, rx, ry in head_rings], 'face', sides=8, phase=math.pi / 2, v0=0.0, v1=1.0)
    # 鼻子（小楔形）與耳朵
    nose_top = b.vert((0, -0.108, 1.648), hw)
    nose_l = b.vert((0.014, -0.102, 1.618), hw)
    nose_r = b.vert((-0.014, -0.102, 1.618), hw)
    nose_tip = b.vert((0, -0.122, 1.616), hw)
    b.face([nose_top, nose_tip, nose_l], [(0.5, 0.6), (0.5, 0.55), (0.52, 0.55)], 'face')
    b.face([nose_top, nose_r, nose_tip], [(0.5, 0.6), (0.48, 0.55), (0.5, 0.55)], 'face')
    b.face([nose_l, nose_tip, nose_r], [(0.52, 0.55), (0.5, 0.55), (0.48, 0.55)], 'face')
    for sx in (1, -1):
        box(b, (0.088 * sx, 0.005, 1.645), (0.018, 0.035, 0.05), 'face', hw)

    for s, sx in (('L', 1), ('R', -1)):
        sh = J[f'shoulder_{s}']
        el = J[f'elbow_{s}']
        wr = J[f'wrist_{s}']
        # 肩頭（肩膀的圓）
        loft(b, [
            {'c': mix(J[f'clav_{s}'], sh, 0.55), 'rx': 0.06, 'ry': 0.07, 'w': {'chest': 0.5, f'shoulder_{s}': 0.5}},
            {'c': (sh[0] + 0.012 * sx, sh[1], sh[2] - 0.02), 'rx': 0.072, 'ry': 0.07, 'w': {f'shoulder_{s}': 0.4, f'upperArm_{s}': 0.6}},
            {'c': mix(sh, el, 0.18), 'rx': 0.06, 'ry': 0.062, 'w': {f'upperArm_{s}': 1}},
        ], suit, sides=8, cap0=True, cap1=False)
        # 上臂、手肘、前臂（袖子）
        loft(b, [
            {'c': mix(sh, el, 0.12), 'rx': 0.062, 'ry': 0.064, 'w': {f'shoulder_{s}': 0.2, f'upperArm_{s}': 0.8}},
            {'c': mix(sh, el, 0.55), 'rx': 0.054, 'ry': 0.056, 'w': {f'upperArm_{s}': 1}},
            {'c': el, 'rx': 0.049, 'ry': 0.052, 'w': {f'upperArm_{s}': 0.5, f'lowerArm_{s}': 0.5}},
            {'c': mix(el, wr, 0.35), 'rx': 0.05, 'ry': 0.048, 'w': {f'lowerArm_{s}': 1}},
            {'c': mix(el, wr, 0.92), 'rx': 0.041, 'ry': 0.038, 'w': {f'lowerArm_{s}': 0.8, f'hand_{s}': 0.2}},
        ], suit, sides=7, cap0=False, cap1=False)
        # 手套：袖口、手掌、兩組手指、拇指
        he = J[f'hand_end_{s}']
        loft(b, [
            {'c': mix(el, wr, 0.82), 'rx': 0.047, 'ry': 0.045, 'w': {f'lowerArm_{s}': 1}},
            {'c': mix(el, wr, 1.0), 'rx': 0.046, 'ry': 0.044, 'w': {f'lowerArm_{s}': 0.5, f'hand_{s}': 0.5}},
        ], 'glove', sides=7)
        palm = [
            {'c': mix(wr, he, 0.0), 'rx': 0.026, 'ry': 0.038, 'w': {f'lowerArm_{s}': 0.3, f'hand_{s}': 0.7}},
            {'c': mix(wr, he, 0.45), 'rx': 0.024, 'ry': 0.047, 'w': {f'hand_{s}': 1}},
            {'c': mix(wr, he, 0.85), 'rx': 0.02, 'ry': 0.045, 'w': {f'hand_{s}': 1}},
        ]
        loft(b, palm, 'glove', sides=6)
        hw2 = {f'hand_{s}': 1}
        tip = Vector(he) + (Vector(he) - Vector(wr)).normalized() * 0.07
        base = Vector(mix(wr, he, 0.8))
        for dy in (-0.022, 0.014):
            a = base + Vector((0, dy, 0))
            c = tip + Vector((-0.012 * sx, dy, 0))
            cylinder(b, tuple(a), tuple(c), 0.016, 'glove', hw2, sides=5, r2=0.013)
        # 拇指朝前（-Y）向內
        tb = Vector(mix(wr, he, 0.2)) + Vector((-0.012 * sx, -0.035, 0))
        tt = tb + Vector((-0.02 * sx, -0.03, -0.055))
        cylinder(b, tuple(tb), tuple(tt), 0.014, 'glove', hw2, sides=5, r2=0.011)
        # 袖上的反光條（識別標記）
        loft(b, [
            {'c': mix(sh, el, 0.38), 'rx': 0.059, 'ry': 0.061, 'w': {f'upperArm_{s}': 1}},
            {'c': mix(sh, el, 0.48), 'rx': 0.058, 'ry': 0.06, 'w': {f'upperArm_{s}': 1}},
        ], 'stripe', sides=7, cap0=False, cap1=False)

        # 腿：大腿、膝、小腿
        hp = J[f'hip_{s}']
        kn = J[f'knee_{s}']
        an = J[f'ankle_{s}']
        loft(b, [
            {'c': (hp[0] * 0.9, hp[1], hp[2] + 0.02), 'rx': 0.088, 'ry': 0.09, 'w': {'hips': 0.5, f'upperLeg_{s}': 0.5}},
            {'c': mix(hp, kn, 0.3), 'rx': 0.082, 'ry': 0.084, 'w': {f'upperLeg_{s}': 1}},
            {'c': mix(hp, kn, 0.75), 'rx': 0.066, 'ry': 0.068, 'w': {f'upperLeg_{s}': 1}},
            {'c': kn, 'rx': 0.06, 'ry': 0.062, 'w': {f'upperLeg_{s}': 0.5, f'lowerLeg_{s}': 0.5}},
            {'c': mix(kn, an, 0.3), 'rx': 0.06, 'ry': 0.064, 'w': {f'lowerLeg_{s}': 1}},
            {'c': mix(kn, an, 0.7), 'rx': 0.05, 'ry': 0.052, 'w': {f'lowerLeg_{s}': 1}},
        ], suit, sides=8, cap0=False, cap1=False)
        # 護膝
        box(b, (kn[0], kn[1] - 0.06, kn[2] + 0.005), (0.085, 0.022, 0.1), 'pad', {f'upperLeg_{s}': 0.4, f'lowerLeg_{s}': 0.6},
            rot=Matrix.Rotation(-0.08, 3, 'X'))
        # 大腿側袋
        box(b, (hp[0] + 0.078 * sx, hp[1] - 0.005, 0.73), (0.03, 0.1, 0.12), suit, {f'upperLeg_{s}': 1})
        # 工作靴：靴筒、腳背、鞋頭、鞋底
        loft(b, [
            {'c': mix(kn, an, 0.62), 'rx': 0.058, 'ry': 0.062, 'w': {f'lowerLeg_{s}': 1}},
            {'c': (an[0], an[1], 0.17), 'rx': 0.057, 'ry': 0.064, 'w': {f'lowerLeg_{s}': 1}},
            {'c': (an[0], an[1] - 0.005, 0.1), 'rx': 0.056, 'ry': 0.07, 'w': {f'lowerLeg_{s}': 0.5, f'foot_{s}': 0.5}},
        ], 'boot', sides=8, cap0=False, cap1=False)
        fw = {f'foot_{s}': 1}
        loft(b, [
            {'c': (an[0], 0.06, 0.06), 'rx': 0.055, 'ry': 0.055, 'w': {f'lowerLeg_{s}': 0.3, f'foot_{s}': 0.7}, 'frame': (V((1, 0, 0)), V((0, 0, 1)))},
            {'c': (an[0], -0.02, 0.06), 'rx': 0.058, 'ry': 0.055, 'w': fw, 'frame': (V((1, 0, 0)), V((0, 0, 1)))},
            {'c': (an[0], -0.11, 0.045), 'rx': 0.054, 'ry': 0.04, 'w': fw, 'frame': (V((1, 0, 0)), V((0, 0, 1)))},
            {'c': (an[0], -0.165, 0.035), 'rx': 0.042, 'ry': 0.028, 'w': fw, 'frame': (V((1, 0, 0)), V((0, 0, 1)))},
        ], 'boot', sides=8)
        box(b, (an[0], -0.045, 0.012), (0.115, 0.255, 0.024), 'sole', fw)
        box(b, (an[0], 0.055, 0.03), (0.1, 0.05, 0.04), 'sole', fw)

    # 腰帶與扣環
    loft(b, [
        {'c': (0, 0.0, 1.05), 'rx': 0.168, 'ry': 0.116, 'w': {'hips': 0.7, 'spine': 0.3}},
        {'c': (0, 0.0, 1.095), 'rx': 0.163, 'ry': 0.113, 'w': {'hips': 0.4, 'spine': 0.6}},
    ], 'belt', sides=8, phase=math.pi / 8, cap0=False, cap1=False)
    box(b, (0, -0.118, 1.072), (0.06, 0.012, 0.045), 'metal', {'hips': 0.6, 'spine': 0.4})
    # 胸前口袋與識別牌（左胸）
    box(b, (-0.085, -0.13, 1.3), (0.08, 0.016, 0.085), 'suit', {'chest': 1})
    box(b, (0.085, -0.133, 1.31), (0.07, 0.012, 0.05), 'badge', {'chest': 1})


# --------------------------------------------------------------------------------------
# 三名角色的裝備
# --------------------------------------------------------------------------------------


def gear_blind(b):
    """盲區員：包覆雙眼的厚重感測面罩、兩側的拾音器、頭頂天線、背後的感測背包"""
    hw = {'head': 1}
    # 面罩：環繞頭部的厚帶，前方加厚
    loft(b, [
        {'c': (0, -0.008, 1.632), 'rx': 0.094, 'ry': 0.108, 'w': hw},
        {'c': (0, -0.006, 1.682), 'rx': 0.095, 'ry': 0.109, 'w': hw},
    ], 'gear', sides=10, phase=-math.pi / 2, cap0=False, cap1=False)
    box(b, (0, -0.108, 1.657), (0.15, 0.03, 0.06), 'gear', hw)
    box(b, (0, -0.124, 1.657), (0.1, 0.008, 0.026), 'lens', hw)  # 封死的感測窗（不透光）
    for sx in (1, -1):
        # 太陽穴的拾音器（朝外）
        cylinder(b, (0.09 * sx, 0.0, 1.66), (0.135 * sx, 0.0, 1.66), 0.028, 'metal', hw, sides=8, r2=0.024)
        cylinder(b, (0.135 * sx, 0.0, 1.66), (0.145 * sx, 0.0, 1.66), 0.03, 'gear', hw, sides=8)
    # 頭帶與天線
    loft(b, [
        {'c': (0.075, 0.03, 1.72), 'rx': 0.012, 'ry': 0.012, 'w': hw},
        {'c': (0.03, 0.035, 1.775), 'rx': 0.012, 'ry': 0.012, 'w': hw},
        {'c': (-0.03, 0.035, 1.775), 'rx': 0.012, 'ry': 0.012, 'w': hw},
        {'c': (-0.075, 0.03, 1.72), 'rx': 0.012, 'ry': 0.012, 'w': hw},
    ], 'gear', sides=5)
    cylinder(b, (0.0, 0.04, 1.77), (0.0, 0.06, 1.93), 0.007, 'metal', hw, sides=5)
    box(b, (0.0, 0.06, 1.935), (0.024, 0.024, 0.024), 'gear', hw)
    # 感測背包＋桅杆
    cw = {'chest': 1}
    box(b, (0, 0.175, 1.24), (0.27, 0.12, 0.33), 'pack', cw)
    box(b, (0, 0.24, 1.16), (0.22, 0.02, 0.12), 'gear', cw)
    cylinder(b, (0.09, 0.2, 1.4), (0.09, 0.21, 1.86), 0.012, 'metal', cw, sides=5)
    box(b, (0.09, 0.21, 1.87), (0.05, 0.02, 0.05), 'gear', cw)
    # 背包連到面罩的導線
    loft(b, [
        {'c': (-0.09, 0.16, 1.39), 'rx': 0.011, 'ry': 0.011, 'w': cw},
        {'c': (-0.11, 0.11, 1.49), 'rx': 0.011, 'ry': 0.011, 'w': {'chest': 0.5, 'neck': 0.5}},
        {'c': (-0.12, 0.05, 1.6), 'rx': 0.011, 'ry': 0.011, 'w': hw},
    ], 'gear', sides=5)
    for sx in (1, -1):
        box(b, (0.11 * sx, -0.04, 1.33), (0.03, 0.2, 0.025), 'gear', cw, rot=Matrix.Rotation(0.25 * sx, 3, 'Y'))  # 背帶


def coat_weight(spread):
    """外套下襬：依左右位置平滑地分給兩條腿（正中央各半），讓前後擺動時膝蓋不會穿出外套"""

    def f(_a, p):
        lft = max(0.0, min(1.0, 0.5 + p.x / 0.3))
        return {'hips': 1.0, 'upperLeg_L': spread * lft, 'upperLeg_R': spread * (1 - lft)}

    return f


def gear_deaf(b):
    """靜默員：厚重耳罩（不過度巨大）＋及膝的無袖工作外套（剪影與其他人不同）"""
    hw = {'head': 1}
    for sx in (1, -1):
        cylinder(b, (0.085 * sx, 0.003, 1.645), (0.122 * sx, 0.003, 1.645), 0.05, 'gear', hw, sides=10, r2=0.046)
        cylinder(b, (0.122 * sx, 0.003, 1.645), (0.13 * sx, 0.003, 1.645), 0.03, 'metal', hw, sides=8)
    loft(b, [
        {'c': (0.115, 0.004, 1.68), 'rx': 0.016, 'ry': 0.008, 'w': hw},
        {'c': (0.09, 0.006, 1.75), 'rx': 0.016, 'ry': 0.008, 'w': hw},
        {'c': (0.0, 0.008, 1.785), 'rx': 0.016, 'ry': 0.008, 'w': hw},
        {'c': (-0.09, 0.006, 1.75), 'rx': 0.016, 'ry': 0.008, 'w': hw},
        {'c': (-0.115, 0.004, 1.68), 'rx': 0.016, 'ry': 0.008, 'w': hw},
    ], 'gear', sides=6)
    # 外套：肩到膝，下襬逐漸外擴；下半部的權重部分分給雙腿，走路時會跟著擺
    loft(b, [
        {'c': (0, 0.006, 1.452), 'rx': 0.11, 'ry': 0.085, 'w': {'chest': 0.8, 'neck': 0.2}},
        {'c': (0, -0.002, 1.4), 'rx': 0.212, 'ry': 0.13, 'w': {'chest': 1}},
        {'c': (0, -0.01, 1.32), 'rx': 0.205, 'ry': 0.142, 'w': {'chest': 1}},
        {'c': (0, -0.006, 1.235), 'rx': 0.188, 'ry': 0.132, 'w': {'spine': 0.4, 'chest': 0.6}},
        {'c': (0, 0.0, 1.13), 'rx': 0.175, 'ry': 0.122, 'w': {'spine': 1}},
        {'c': (0, 0.004, 1.03), 'rx': 0.188, 'ry': 0.128, 'w': {'hips': 1}},
        {'c': (0, 0.006, 0.88), 'rx': 0.215, 'ry': 0.145, 'w': coat_weight(0.35)},
        {'c': (0, 0.006, 0.68), 'rx': 0.235, 'ry': 0.17, 'w': coat_weight(0.9)},
        {'c': (0, 0.004, 0.56), 'rx': 0.245, 'ry': 0.18, 'w': coat_weight(1.3)},
    ], 'coat', sides=10, phase=math.pi / 10, cap0=False, cap1=False)
    # 外套前襟與口袋
    box(b, (0, -0.143, 1.1), (0.014, 0.012, 0.5), 'gear', {'spine': 0.5, 'chest': 0.5})
    for sx in (1, -1):
        box(b, (0.12 * sx, -0.135, 0.95), (0.09, 0.014, 0.1), 'coat', {'hips': 1}, rot=Matrix.Rotation(-0.15 * sx, 3, 'Z'))
    # 肩章（外套的肩線比制服寬）
    for sx in (1, -1):
        box(b, (0.17 * sx, 0.0, 1.415), (0.09, 0.15, 0.025), 'coat', {'chest': 0.6, f'shoulder_{"L" if sx > 0 else "R"}': 0.4})


def gear_mute(b):
    """失語員：封住口鼻的呼吸器（兩個濾罐＋導管）、短披肩與背後的兜帽"""
    hw = {'head': 1}
    loft(b, [
        {'c': (0, -0.068, 1.605), 'rx': 0.072, 'ry': 0.05, 'w': hw, 'frame': (V((1, 0, 0)), V((0, 0, 1)))},
        {'c': (0, -0.105, 1.6), 'rx': 0.06, 'ry': 0.042, 'w': hw, 'frame': (V((1, 0, 0)), V((0, 0, 1)))},
        {'c': (0, -0.132, 1.594), 'rx': 0.034, 'ry': 0.026, 'w': hw, 'frame': (V((1, 0, 0)), V((0, 0, 1)))},
    ], 'gear', sides=8)
    box(b, (0, -0.142, 1.594), (0.035, 0.012, 0.025), 'metal', hw)  # 通訊封鎖閥
    for sx in (1, -1):
        cylinder(b, (0.04 * sx, -0.112, 1.585), (0.062 * sx, -0.15, 1.56), 0.02, 'metal', hw, sides=8)
        cylinder(b, (0.062 * sx, -0.15, 1.56), (0.068 * sx, -0.16, 1.555), 0.023, 'gear', hw, sides=8)
    # 固定帶
    loft(b, [
        {'c': (0, 0.0, 1.61), 'rx': 0.092, 'ry': 0.104, 'w': hw},
        {'c': (0, 0.0, 1.625), 'rx': 0.092, 'ry': 0.104, 'w': hw},
    ], 'gear', sides=10, cap0=False, cap1=False)
    # 導管：呼吸器 → 胸前的單元
    loft(b, [
        {'c': (0, -0.13, 1.575), 'rx': 0.014, 'ry': 0.014, 'w': hw},
        {'c': (0.02, -0.14, 1.5), 'rx': 0.014, 'ry': 0.014, 'w': {'head': 0.4, 'neck': 0.6}},
        {'c': (0.03, -0.15, 1.42), 'rx': 0.014, 'ry': 0.014, 'w': {'chest': 1}},
    ], 'gear', sides=5)
    box(b, (0.035, -0.15, 1.37), (0.09, 0.04, 0.07), 'gear', {'chest': 1})
    # 短披肩：從頸部垂到上臂，形成寬而垂的肩線
    def cape_w(_a, p):
        w = {'chest': 1.0}
        if abs(p.x) > 0.15:
            w[f'shoulder_{"L" if p.x > 0 else "R"}'] = 0.5
        return w

    loft(b, [
        {'c': (0, 0.012, 1.475), 'rx': 0.092, 'ry': 0.08, 'w': {'chest': 0.7, 'neck': 0.3}},
        {'c': (0, 0.006, 1.425), 'rx': 0.215, 'ry': 0.15, 'w': cape_w},
        {'c': (0, 0.008, 1.32), 'rx': 0.275, 'ry': 0.172, 'w': cape_w},
        {'c': (0, 0.01, 1.2), 'rx': 0.29, 'ry': 0.18, 'w': cape_w},
    ], 'cape', sides=12, phase=math.pi / 12, cap0=False, cap1=False)
    # 背後堆疊的兜帽
    loft(b, [
        {'c': (0, 0.105, 1.47), 'rx': 0.11, 'ry': 0.045, 'w': {'chest': 0.6, 'neck': 0.4}, 'frame': (V((1, 0, 0)), V((0, 1, 0.5)).normalized())},
        {'c': (0, 0.135, 1.42), 'rx': 0.12, 'ry': 0.05, 'w': {'chest': 1}, 'frame': (V((1, 0, 0)), V((0, 1, 0.5)).normalized())},
        {'c': (0, 0.14, 1.36), 'rx': 0.07, 'ry': 0.035, 'w': {'chest': 1}, 'frame': (V((1, 0, 0)), V((0, 1, 0.5)).normalized())},
    ], 'cape', sides=8)
    # 腰間的文件匣（失語員帶著規則文件）
    box(b, (-0.17, 0.02, 0.98), (0.04, 0.16, 0.12), 'pack', {'hips': 1})


ROLES = {
    'BLIND': {
        'file': 'crew_blind.glb', 'letter': 'A', 'gear': gear_blind,
        'suit': '#56626B', 'stripe': '#A9ACA3', 'gearc': '#25292B', 'pack': '#4B5148', 'pad': '#3B4245',
    },
    'DEAF': {
        'file': 'crew_deaf.glb', 'letter': 'B', 'gear': gear_deaf,
        'suit': '#3F4A42', 'stripe': '#9DA29A', 'gearc': '#5C5444', 'coat': '#A3A59A', 'pack': '#3A3F3B', 'pad': '#33393A',
    },
    'MUTE': {
        'file': 'crew_mute.glb', 'letter': 'C', 'gear': gear_mute,
        'suit': '#6E736F', 'stripe': '#A3A69D', 'gearc': '#1F2325', 'cape': '#56605A', 'pack': '#5A574C', 'pad': '#3C4240',
    },
}


def role_materials(role, cfg):
    seed = sum(map(ord, role))
    mats = {
        'suit': make_material(f'{role}_suit', make_image(f'{role}_suit', 64, 64, fabric_painter(cfg['suit'], seed))),
        'stripe': make_material(f'{role}_stripe', make_image(f'{role}_stripe', 16, 8, solid_painter(cfg['stripe'], seed + 1, 0.12))),
        'face': make_material(f'{role}_face', make_image(f'{role}_face', 64, 64, face_painter('#9A8C80', '#2E2B28', seed + 2))),
        'glove': make_material(f'{role}_glove', make_image(f'{role}_glove', 32, 32, solid_painter('#2F3332', seed + 3, 0.16, 0.04))),
        'boot': make_material(f'{role}_boot', make_image(f'{role}_boot', 32, 32, solid_painter('#24282A', seed + 4, 0.14, 0.05))),
        'sole': make_material(f'{role}_sole', make_image(f'{role}_sole', 8, 8, solid_painter('#161819', seed + 5, 0.1))),
        'pad': make_material(f'{role}_pad', make_image(f'{role}_pad', 16, 16, solid_painter(cfg['pad'], seed + 6, 0.14, 0.05))),
        'belt': make_material(f'{role}_belt', make_image(f'{role}_belt', 16, 8, solid_painter('#2B2D2A', seed + 7, 0.1))),
        'metal': make_material(f'{role}_metal', make_image(f'{role}_metal', 16, 16, solid_painter('#6E7472', seed + 8, 0.2, 0.08)), roughness=0.65, metallic=0.3),
        'badge': make_material(f'{role}_badge', make_image(f'{role}_badge', 16, 16, badge_painter(cfg['letter'], '#B9BAB0', '#25292B'))),
        'gear': make_material(f'{role}_gear', make_image(f'{role}_gear', 32, 32, solid_painter(cfg['gearc'], seed + 9, 0.12, 0.06)), roughness=0.75),
        'lens': make_material(f'{role}_lens', make_image(f'{role}_lens', 8, 8, solid_painter('#121416', seed + 10, 0.05)), roughness=0.4),
        'pack': make_material(f'{role}_pack', make_image(f'{role}_pack', 32, 32, fabric_painter(cfg['pack'], seed + 11, seam=False, grime=0.1))),
    }
    if 'coat' in cfg:
        mats['coat'] = make_material(f'{role}_coat', make_image(f'{role}_coat', 64, 64, fabric_painter(cfg['coat'], seed + 12, grime=0.3, noise=0.05)))
    if 'cape' in cfg:
        mats['cape'] = make_material(f'{role}_cape', make_image(f'{role}_cape', 64, 64, fabric_painter(cfg['cape'], seed + 13, seam=False, grime=0.2, noise=0.06)))
    return mats


# --------------------------------------------------------------------------------------
# 場景、骨架、網格物件
# --------------------------------------------------------------------------------------


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.fps = FPS


def make_armature(name='Armature'):
    data = bpy.data.armatures.new(name)
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = data.edit_bones
    for bname, h, t, parent in BONES:
        bone = eb.new(bname)
        bone.head = V(J[h])
        bone.tail = V(J[t])
        # 骨骼的 Z 軸一律朝角色前方（-Y）；手腳的骨骼則朝上方，讓旋轉軸在不同骨骼間一致
        ref = V((0, -1, 0)) if abs((bone.tail - bone.head).normalized().y) < 0.9 else V((0, 0, 1))
        bone.align_roll(ref)
        if parent:
            bone.parent = eb[parent]
            bone.use_connect = False
    bpy.ops.object.mode_set(mode='OBJECT')
    return obj


def make_mesh(name, b, mats, arm):
    me = bpy.data.meshes.new(name)
    faces = [f[0] for f in b.faces]
    me.from_pydata([tuple(v) for v in b.verts], [], faces)
    me.update()
    for slot in b.slots:
        me.materials.append(mats[slot])
    uv = me.uv_layers.new(name='UVMap')
    li = 0
    for pi, (idx, uvs, mat) in enumerate(b.faces):
        poly = me.polygons[pi]
        poly.material_index = mat
        poly.use_smooth = False
        for k in range(poly.loop_total):
            uv.data[poly.loop_start + k].uv = uvs[k] if k < len(uvs) else (0.5, 0.5)
        li += poly.loop_total
    # 統一法線朝外（各個部件是封閉或近似封閉的殼）
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    for bn in BONE_NAMES:
        obj.vertex_groups.new(name=bn)
    for vi, w in enumerate(b.weights):
        for bn, val in w.items():
            obj.vertex_groups[bn].add([vi], val, 'REPLACE')
    obj.parent = arm
    mod = obj.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm
    return obj


def build_role(role, cfg):
    reset_scene()
    arm = make_armature('Armature')
    b = Builder()
    build_body(b, 'suit')
    cfg['gear'](b)
    mats = role_materials(role, cfg)
    obj = make_mesh(f'crew_{role.lower()}', b, mats, arm)
    tris = sum(len(f[0]) - 2 for f in b.faces)
    return arm, obj, tris


# --------------------------------------------------------------------------------------
# 動畫：以「骨架座標軸」描述旋轉（度）
#   X：正值＝腿往後擺、軀幹往前傾、頭往下點；負值＝腿／手臂往前抬
#   Y：左側肢體負值＝往外張（右側相反）
#   Z：正值＝往角色的左邊轉
# 每個關鍵影格都寫入全部骨骼，動畫之間交叉淡入淡出時不會留下前一個動畫的殘餘姿勢。
# --------------------------------------------------------------------------------------

from mathutils import Euler  # noqa: E402


def mirror(pose):
    out = {}
    for k, v in pose.items():
        if k == '_loc':
            out[k] = (-v[0], v[1], v[2])
            continue
        if k.endswith('_L'):
            k2 = k[:-2] + '_R'
        elif k.endswith('_R'):
            k2 = k[:-2] + '_L'
        else:
            k2 = k
        out[k2] = (v[0], -v[1], -v[2])
    return out


def merge(*poses):
    out = {}
    for p in poses:
        for k, v in p.items():
            if k in out and k != '_loc':
                out[k] = tuple(a + b for a, b in zip(out[k], v))
            else:
                out[k] = v
    return out


def scaled(pose, k):
    return {b: tuple(x * k for x in v) for b, v in pose.items()}


ARMS_DOWN = {
    'upperArm_L': (3, 7, 0), 'upperArm_R': (3, -7, 0),
    'lowerArm_L': (-10, 0, 0), 'lowerArm_R': (-10, 0, 0),
    'hand_L': (-6, 0, 0), 'hand_R': (-6, 0, 0),
}
STAND = merge(ARMS_DOWN, {'spine': (1, 0, 0), 'neck': (2, 0, 0), 'head': (3, 0, 0), '_loc': (0, 0, 0)})

CROUCH = {
    '_loc': (0, 0.085, -0.33),
    'spine': (18, 0, 0), 'chest': (8, 0, 0), 'neck': (-8, 0, 0), 'head': (-14, 0, 0),
    'upperLeg_L': (-62, -6, 0), 'upperLeg_R': (-62, 6, 0),
    'lowerLeg_L': (104, 0, 0), 'lowerLeg_R': (104, 0, 0),
    'foot_L': (-42, 0, 0), 'foot_R': (-42, 0, 0),
    'upperArm_L': (-30, 8, 0), 'upperArm_R': (-30, -8, 0),
    'lowerArm_L': (-40, 0, 0), 'lowerArm_R': (-40, 0, 0),
    'hand_L': (-10, 0, 0), 'hand_R': (-10, 0, 0),
}

WALK_CONTACT = {
    '_loc': (0, 0, -0.025),
    'hips': (0, 0, -4), 'spine': (3, 0, 0), 'chest': (0, 0, 5), 'neck': (2, 0, 0), 'head': (3, 0, -1),
    'upperLeg_L': (-29, 0, 0), 'lowerLeg_L': (6, 0, 0), 'foot_L': (-14, 0, 0),
    'upperLeg_R': (22, 0, 0), 'lowerLeg_R': (24, 0, 0), 'foot_R': (16, 0, 0),
    'upperArm_L': (16, 6, 0), 'lowerArm_L': (-12, 0, 0), 'hand_L': (-5, 0, 0),
    'upperArm_R': (-16, -6, 0), 'lowerArm_R': (-24, 0, 0), 'hand_R': (-5, 0, 0),
}
WALK_PASS = {
    '_loc': (0, 0, 0.008),
    'hips': (0, 0, 0), 'spine': (3, 0, 0), 'chest': (0, 0, 0), 'neck': (2, 0, 0), 'head': (3, 0, 0),
    'upperLeg_L': (2, 0, 0), 'lowerLeg_L': (6, 0, 0), 'foot_L': (-2, 0, 0),
    'upperLeg_R': (-10, 0, 0), 'lowerLeg_R': (42, 0, 0), 'foot_R': (-8, 0, 0),
    'upperArm_L': (2, 7, 0), 'lowerArm_L': (-14, 0, 0), 'hand_L': (-5, 0, 0),
    'upperArm_R': (-2, -7, 0), 'lowerArm_R': (-16, 0, 0), 'hand_R': (-5, 0, 0),
}
RUN_CONTACT = {
    '_loc': (0, 0, -0.045),
    'hips': (0, 0, -7), 'spine': (10, 0, 0), 'chest': (3, 0, 8), 'neck': (-4, 0, 0), 'head': (-2, 0, -2),
    'upperLeg_L': (-38, 0, 0), 'lowerLeg_L': (14, 0, 0), 'foot_L': (-10, 0, 0),
    'upperLeg_R': (26, 0, 0), 'lowerLeg_R': (46, 0, 0), 'foot_R': (24, 0, 0),
    'upperArm_L': (34, 10, 0), 'lowerArm_L': (-72, 0, 0), 'hand_L': (-8, 0, 0),
    'upperArm_R': (-40, -10, 0), 'lowerArm_R': (-86, 0, 0), 'hand_R': (-8, 0, 0),
}
RUN_PASS = {
    '_loc': (0, 0, 0.03),
    'hips': (0, 0, 0), 'spine': (10, 0, 0), 'chest': (3, 0, 0), 'neck': (-4, 0, 0), 'head': (-2, 0, 0),
    'upperLeg_L': (6, 0, 0), 'lowerLeg_L': (20, 0, 0), 'foot_L': (4, 0, 0),
    'upperLeg_R': (-34, 0, 0), 'lowerLeg_R': (98, 0, 0), 'foot_R': (-12, 0, 0),
    'upperArm_L': (6, 10, 0), 'lowerArm_L': (-80, 0, 0), 'hand_L': (-8, 0, 0),
    'upperArm_R': (-8, -10, 0), 'lowerArm_R': (-80, 0, 0), 'hand_R': (-8, 0, 0),
}
INTERACT = merge(STAND, {
    'spine': (9, 0, 0), 'chest': (6, 0, 0), 'neck': (4, 0, 0), 'head': (14, 0, 0),
    'upperArm_L': (-48, 14, 0), 'upperArm_R': (-48, -14, 0),
    'lowerArm_L': (-28, 0, -8), 'lowerArm_R': (-28, 0, 8),
    'hand_L': (-14, 0, 0), 'hand_R': (-14, 0, 0),
    'upperLeg_L': (-3, 0, 0), 'lowerLeg_L': (5, 0, 0), 'upperLeg_R': (3, 0, 0), 'lowerLeg_R': (4, 0, 0),
})
INTERACT_HIGH = merge(STAND, {
    'spine': (2, 0, 0), 'chest': (1, 0, 0), 'neck': (-2, 0, 0), 'head': (-2, 0, 0),
    'upperArm_L': (-62, 12, 0), 'upperArm_R': (-62, -12, 0),
    'lowerArm_L': (-26, 0, -10), 'lowerArm_R': (-26, 0, 10),
    'hand_L': (4, 0, 0), 'hand_R': (4, 0, 0),
})
INSPECT = merge(STAND, {
    'spine': (4, 0, 0), 'chest': (2, 0, 3), 'neck': (8, 0, 0), 'head': (16, 0, 5),
    'upperArm_L': (-28, 16, 0), 'lowerArm_L': (-92, 0, -12), 'hand_L': (-10, 0, 0),
    'upperArm_R': (-6, -10, 0), 'lowerArm_R': (-30, 0, 0),
    'upperLeg_L': (0, 0, 0), 'upperLeg_R': (2, 0, 0), 'lowerLeg_R': (6, 0, 0),
})

OBSERVE = merge(STAND, {
    'spine': (-1, 0, 0), 'neck': (-4, 0, 0), 'head': (-6, 0, 0),
    'upperArm_R': (-34, -18, 0), 'lowerArm_R': (-118, 0, 14), 'hand_R': (-20, 0, 0),
    'upperArm_L': (-16, 22, 0), 'lowerArm_L': (-82, 0, -34), 'hand_L': (0, 0, 0),
    'upperLeg_R': (2, 0, 0), 'lowerLeg_R': (5, 0, 0),
})


def clip(length, keys, loop):
    """keys：[(影格, 姿勢)]；loop 時自動在最後補上第一格"""
    if loop and keys[-1][0] != length:
        keys = keys + [(length, keys[0][1])]
    return {'length': length, 'keys': keys, 'loop': loop}


def breathing(base, length, amp=1.0):
    inhale = merge(base, {'chest': (-1.2 * amp, 0, 0), 'shoulder_L': (0, -2 * amp, 0), 'shoulder_R': (0, 2 * amp, 0), '_loc': tuple(a + b for a, b in zip(base.get('_loc', (0, 0, 0)), (0, 0, 0.003 * amp)))})
    return [(0, base), (length // 2, inhale)]


CLIPS = {
    # 待機：呼吸幅度小、姿勢略僵直；偶爾緩慢地轉一下頭
    'Idle': clip(120, [
        (0, STAND),
        (40, merge(STAND, {'chest': (-1.0, 0, 0), 'shoulder_L': (0, -1.8, 0), 'shoulder_R': (0, 1.8, 0), '_loc': (0, 0, 0.003)})),
        (64, merge(STAND, {'head': (0, 0, 6)})),
        (82, merge(STAND, {'head': (0, 0, 6), 'chest': (-0.8, 0, 0)})),
        (100, STAND),
    ], True),
    'Walk': clip(36, [(0, WALK_CONTACT), (9, WALK_PASS), (18, mirror(WALK_CONTACT)), (27, mirror(WALK_PASS))], True),
    'Run': clip(20, [(0, RUN_CONTACT), (5, RUN_PASS), (10, mirror(RUN_CONTACT)), (15, mirror(RUN_PASS))], True),
    # 開始移動：重心先往前、第一步
    'StartMoving': clip(10, [
        (0, STAND),
        (5, merge(STAND, {'spine': (9, 0, 0), 'upperLeg_L': (-12, 0, 0), 'lowerLeg_L': (14, 0, 0), 'upperLeg_R': (6, 0, 0), 'upperArm_R': (-8, 0, 0), '_loc': (0, 0, -0.012)})),
        (10, WALK_CONTACT),
    ], False),
    # 停止移動：煞住、上身往後、手臂順著慣性往前，最後回到站姿
    'StopMoving': clip(20, [
        (0, WALK_PASS),
        (4, merge(STAND, {'spine': (-5, 0, 0), 'chest': (-2, 0, 0), 'upperLeg_L': (-12, 0, 0), 'lowerLeg_L': (8, 0, 0), 'upperLeg_R': (8, 0, 0), 'lowerLeg_R': (10, 0, 0),
                          'upperArm_L': (-14, 7, 0), 'upperArm_R': (-12, -7, 0), '_loc': (0, 0, -0.022)})),
        (11, merge(STAND, {'spine': (4, 0, 0), 'upperArm_L': (6, 7, 0), 'upperArm_R': (6, -7, 0), '_loc': (0, 0, -0.006)})),
        (20, STAND),
    ], False),
    # 原地轉身：小碎步（上半身與頭的延遲由前端程式疊加）
    'Turn': clip(24, [
        (0, STAND),
        (6, merge(STAND, {'upperLeg_L': (-12, -3, 0), 'lowerLeg_L': (24, 0, 0), 'foot_L': (-6, 0, 0), 'hips': (0, 0, 3), '_loc': (0, 0, 0.004)})),
        (12, STAND),
        (18, merge(STAND, {'upperLeg_R': (-12, 3, 0), 'lowerLeg_R': (24, 0, 0), 'foot_R': (-6, 0, 0), 'hips': (0, 0, -3), '_loc': (0, 0, 0.004)})),
    ], True),
    'Crouch': clip(12, [(0, STAND), (12, CROUCH)], False),
    'CrouchIdle': clip(80, [(0, CROUCH), (40, merge(CROUCH, {'chest': (-1.5, 0, 0), '_loc': (0, 0.085, -0.326)}))], True),
    'CrouchWalk': clip(40, [
        (0, merge(CROUCH, {'upperLeg_L': (-14, 0, 0), 'lowerLeg_L': (4, 0, 0), 'foot_L': (8, 0, 0), 'upperLeg_R': (12, 0, 0), 'lowerLeg_R': (-6, 0, 0), 'foot_R': (-4, 0, 0), 'hips': (0, 0, -4), '_loc': (0, 0.085, -0.335)})),
        (10, merge(CROUCH, {'upperLeg_R': (-6, 0, 0), 'lowerLeg_R': (16, 0, 0), '_loc': (0, 0.085, -0.318)})),
        (20, merge(CROUCH, {'upperLeg_R': (-14, 0, 0), 'lowerLeg_R': (4, 0, 0), 'foot_R': (8, 0, 0), 'upperLeg_L': (12, 0, 0), 'lowerLeg_L': (-6, 0, 0), 'foot_L': (-4, 0, 0), 'hips': (0, 0, 4), '_loc': (0, 0.085, -0.335)})),
        (30, merge(CROUCH, {'upperLeg_L': (-6, 0, 0), 'lowerLeg_L': (16, 0, 0), '_loc': (0, 0.085, -0.318)})),
    ], True),
    # 操作機關（桌面高度約 1.0–1.15 m）：雙手在面前輪流按壓、轉動
    'Interact': clip(48, [
        (0, INTERACT),
        (12, merge(INTERACT, {'upperArm_L': (-5, 0, 0), 'hand_L': (-14, 0, 0)})),
        (24, INTERACT),
        (36, merge(INTERACT, {'upperArm_R': (-5, 0, 0), 'hand_R': (-14, 0, 0), 'lowerArm_R': (0, 0, -10)})),
    ], True),
    # 操作牆面設備（約 1.25–1.35 m）
    'InteractHigh': clip(48, [
        (0, INTERACT_HIGH),
        (14, merge(INTERACT_HIGH, {'upperArm_L': (-6, 0, 0), 'hand_L': (-10, 0, 0)})),
        (28, INTERACT_HIGH),
        (40, merge(INTERACT_HIGH, {'upperArm_R': (-6, 0, 0), 'lowerArm_R': (0, 0, 14)})),
    ], True),
    # 觀察物件：左手拿著文件、低頭閱讀，偶爾抬眼
    'Inspect': clip(96, [
        (0, INSPECT),
        (30, merge(INSPECT, {'head': (3, 0, -6), 'neck': (1, 0, 0)})),
        (54, merge(INSPECT, {'head': (-14, 0, -4), 'neck': (-4, 0, 0)})),
        (70, INSPECT),
    ], True),
    # 觀察牆面的顯示器／燈號：手托下巴、抬頭看
    'Observe': clip(90, [
        (0, OBSERVE),
        (36, merge(OBSERVE, {'head': (-3, 0, 6), 'chest': (-0.8, 0, 2)})),
        (62, merge(OBSERVE, {'head': (-8, 0, -5)})),
    ], True),
    # 受傷：答錯被設備鎖定時的觸電反應（彈開 → 抖動 → 縮起 → 恢復）
    'Hurt': clip(24, [
        (0, STAND),
        (2, merge(STAND, {'spine': (-14, 0, 0), 'chest': (-6, 0, 0), 'head': (-20, 0, 0), 'upperArm_L': (18, -22, 0), 'upperArm_R': (18, 22, 0),
                          'lowerArm_L': (-60, 0, 0), 'lowerArm_R': (-60, 0, 0), 'hand_L': (-30, 0, 0), 'hand_R': (-30, 0, 0), '_loc': (0, 0.035, -0.015),
                          'upperLeg_L': (-8, 0, 0), 'lowerLeg_L': (14, 0, 0)})),
        (4, merge(STAND, {'spine': (-9, 0, 2), 'head': (-12, 0, -4), 'upperArm_L': (12, -28, 0), 'upperArm_R': (14, 26, 0), 'lowerArm_L': (-68, 0, 0), 'lowerArm_R': (-56, 0, 0), '_loc': (0, 0.03, -0.02)})),
        (6, merge(STAND, {'spine': (-13, 0, -2), 'head': (-16, 0, 4), 'upperArm_L': (16, -24, 0), 'upperArm_R': (12, 28, 0), 'lowerArm_L': (-58, 0, 0), 'lowerArm_R': (-66, 0, 0), '_loc': (0, 0.03, -0.02)})),
        (10, merge(STAND, {'spine': (18, 0, 0), 'chest': (10, 0, 0), 'head': (22, 0, 0), 'upperArm_L': (-24, 14, 0), 'upperArm_R': (-24, -14, 0),
                           'lowerArm_L': (-96, 0, -20), 'lowerArm_R': (-96, 0, 20), '_loc': (0, 0.01, -0.05), 'upperLeg_L': (-14, 0, 0), 'lowerLeg_L': (24, 0, 0),
                           'upperLeg_R': (-10, 0, 0), 'lowerLeg_R': (20, 0, 0), 'foot_L': (-10, 0, 0), 'foot_R': (-10, 0, 0)})),
        (24, STAND),
    ], False),
    # 死亡：只在預覽頁使用（遊戲中沒有傷害系統）
    'Death': clip(64, [
        (0, STAND),
        (8, merge(STAND, {'spine': (16, 0, 0), 'head': (28, 0, 0), 'upperArm_L': (6, 0, 0), 'upperArm_R': (6, 0, 0), '_loc': (0, 0, -0.05),
                          'upperLeg_L': (-10, 0, 0), 'lowerLeg_L': (20, 0, 0), 'upperLeg_R': (-10, 0, 0), 'lowerLeg_R': (20, 0, 0), 'foot_L': (-10, 0, 0), 'foot_R': (-10, 0, 0)})),
        (22, {'_loc': (0, 0.04, -0.43), 'spine': (24, 0, 0), 'chest': (8, 0, 0), 'head': (34, 0, 6),
              'upperLeg_L': (-8, -4, 0), 'upperLeg_R': (-8, 4, 0), 'lowerLeg_L': (92, 0, 0), 'lowerLeg_R': (92, 0, 0), 'foot_L': (30, 0, 0), 'foot_R': (30, 0, 0),
              'upperArm_L': (-16, 6, 0), 'upperArm_R': (-16, -6, 0), 'lowerArm_L': (-10, 0, 0), 'lowerArm_R': (-10, 0, 0)}),
        (40, {'_loc': (0, -0.22, -0.6), 'hips': (48, 0, 0), 'spine': (14, 0, 0), 'head': (10, 0, 20),
              'upperLeg_L': (-48, -4, 0), 'upperLeg_R': (-48, 4, 0), 'lowerLeg_L': (96, 0, 0), 'lowerLeg_R': (96, 0, 0), 'foot_L': (30, 0, 0), 'foot_R': (30, 0, 0),
              'upperArm_L': (-70, 10, 0), 'upperArm_R': (-64, -10, 0), 'lowerArm_L': (-20, 0, 0), 'lowerArm_R': (-24, 0, 0)}),
        (64, {'_loc': (0, -0.58, -0.83), 'hips': (86, 0, 4), 'spine': (-2, 0, 0), 'chest': (-2, 0, 0), 'neck': (-10, 0, 0), 'head': (-20, 0, 72),
              'upperLeg_L': (-6, -4, 0), 'upperLeg_R': (-14, 6, 0), 'lowerLeg_L': (18, 0, 0), 'lowerLeg_R': (34, 0, 0), 'foot_L': (54, 0, 0), 'foot_R': (48, 0, 0),
              'upperArm_L': (-150, -24, 0), 'upperArm_R': (-12, -40, 0), 'lowerArm_L': (-12, 0, 0), 'lowerArm_R': (-30, 0, 0), 'hand_L': (10, 0, 0)}),
    ], False),
}

REQUIRED_CLIPS = ['Idle', 'Walk', 'Run', 'StartMoving', 'StopMoving', 'Turn', 'Crouch', 'Interact', 'Inspect', 'Hurt', 'Death']


def apply_pose(arm, pose):
    rest = {b.name: b.matrix_local.to_quaternion() for b in arm.data.bones}
    for pb in arm.pose.bones:
        rot = pose.get(pb.name, (0, 0, 0))
        q = Euler(tuple(math.radians(a) for a in rot), 'XYZ').to_quaternion()
        r = rest[pb.name]
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = r.inverted() @ q @ r
        if pb.name == 'hips':
            loc = Vector(pose.get('_loc', (0, 0, 0)))
            pb.location = r.inverted() @ loc
        else:
            pb.location = (0, 0, 0)
        pb.scale = (1, 1, 1)


def bake_actions(arm):
    arm.animation_data_create()
    made = []
    for name, c in CLIPS.items():
        act = bpy.data.actions.new(name)
        act.use_fake_user = True
        arm.animation_data.action = act
        for frame, pose in c['keys']:
            apply_pose(arm, pose)
            for pb in arm.pose.bones:
                pb.keyframe_insert('rotation_quaternion', frame=frame + 1)
                if pb.name == 'hips':
                    pb.keyframe_insert('location', frame=frame + 1)
        made.append(act)
    arm.animation_data.action = None
    apply_pose(arm, {})
    return made


# --------------------------------------------------------------------------------------
# 匯出
# --------------------------------------------------------------------------------------


def export_glb(path, objs, animations):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    kw = dict(
        filepath=path,
        export_format='GLB',
        use_selection=True,
        export_yup=True,
        export_apply=False,
        export_texcoords=True,
        export_normals=True,
        export_materials='EXPORT',
        export_image_format='AUTO',
        export_skins=True,
        export_animations=animations,
        export_def_bones=False,
        export_morph=False,
    )
    if animations:
        kw.update(export_animation_mode='ACTIONS', export_force_sampling=True, export_frame_step=1, export_reset_pose_bones=True,
                  export_optimize_animation_size=True)
    bpy.ops.export_scene.gltf(**kw)


def main():
    args = [a for a in sys.argv[1:]]
    preview = None
    if '--preview' in args:
        i = args.index('--preview')
        preview = args[i + 1]
        del args[i:i + 2]
    out = args[0] if args else os.path.join(os.path.dirname(__file__), '..', '..', 'client', 'public', 'models')
    os.makedirs(out, exist_ok=True)
    report = {}
    for role, cfg in ROLES.items():
        arm, obj, tris = build_role(role, cfg)
        export_glb(os.path.join(out, cfg['file']), [arm, obj], False)
        report[role] = {'triangles': tris, 'vertices': len(obj.data.vertices)}
        if preview:
            render_preview(role, arm, obj, preview)
    # 動畫庫：只有骨架（加一個看不見的小三角形，讓匯出器輸出完整的關節節點）
    reset_scene()
    arm = make_armature('Armature')
    b = Builder()
    w = {'hips': 1}
    b.face([b.vert((0, 0, 0.9), w), b.vert((0.001, 0, 0.9), w), b.vert((0, 0.001, 0.9), w)], [(0, 0), (1, 0), (0, 1)], 'x')
    mats = {'x': bpy.data.materials.new('anim_dummy')}
    dummy = make_mesh('anim_dummy', b, mats, arm)
    bake_actions(arm)
    export_glb(os.path.join(out, 'crew_anims.glb'), [arm, dummy], True)
    manifest = {
        'version': 1,
        'generator': 'tools/characters/build_crew.py',
        'note': '程式產生的風格化低多邊形模型（原型等級）。正式模型可在 overrides 指定，載入失敗時會退回這裡的模型。',
        'animations': 'crew_anims.glb',
        'bones': BONE_NAMES,
        'requiredClips': REQUIRED_CLIPS,
        'clips': {k: {'frames': c['length'], 'loop': c['loop']} for k, c in CLIPS.items()},
        'roles': {r: {'model': c['file'], 'height': 1.79} for r, c in ROLES.items()},
        'overrides': {},
        'stats': report,
    }
    with open(os.path.join(out, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print('[crew] 完成', json.dumps(report))


# --------------------------------------------------------------------------------------
# 預覽（Cycles CPU 算繪：正面、側面、背面）
# --------------------------------------------------------------------------------------


def render_preview(role, arm, obj, folder, poses=None):
    os.makedirs(folder, exist_ok=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = 12
    sc.cycles.device = 'CPU'
    sc.render.resolution_x = 360
    sc.render.resolution_y = 480
    sc.render.film_transparent = False
    world = bpy.data.worlds.new('w')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.25, 0.27, 0.28, 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.6
    sc.world = world
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 3.0
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(-30))
    sc.collection.objects.link(sun)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    cam.data.lens = 50
    sc.collection.objects.link(cam)
    sc.camera = cam
    fill = bpy.data.objects.new('fill', bpy.data.lights.new('fill', 'SUN'))
    fill.data.energy = 1.2
    fill.rotation_euler = (math.radians(70), 0, math.radians(160))
    sc.collection.objects.link(fill)
    sun.data.energy = 4.5
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 1.0
    shots = {
        'front': ((0, -3.4, 0.92), 0, 55),
        'side': ((3.4, 0, 0.92), 90, 55),
        'back': ((0, 3.4, 0.92), 180, 55),
        'head': ((0.45, -1.15, 1.62), 21, 85),
        'headside': ((1.2, -0.2, 1.62), 80, 85),
    }
    for view, ((x, y, z), rz, lens) in shots.items():
        cam.location = (x, y, z)
        cam.data.lens = lens
        cam.rotation_euler = (math.radians(90), 0, math.radians(rz))
        sc.render.filepath = os.path.join(folder, f'{role.lower()}_{view}.png')
        bpy.ops.render.render(write_still=True)


if __name__ == '__main__':
    main()
