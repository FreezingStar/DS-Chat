from PIL import Image, ImageDraw, ImageFilter
from collections import deque

OUT = "/root/workspace/ds-chat/android/res"
S = 1024
SRC = "/root/workspace/ds-chat/tools/icon-source.jpg"
LIGHT_BLUE = (230, 240, 255)   # 浅蓝底

im = Image.open(SRC).convert("RGB")
w, h = im.size
px = im.load()

bg = (254, 254, 254)
def dist(c):
    return ((c[0]-bg[0])**2 + (c[1]-bg[1])**2 + (c[2]-bg[2])**2) ** 0.5

TH = 26
visited = bytearray(w * h)
q = deque()
for x in range(w):
    for y in (0, h - 1):
        if dist(px[x, y]) < TH and not visited[y*w + x]:
            visited[y*w + x] = 1; q.append((x, y))
for y in range(h):
    for x in (0, w - 1):
        if dist(px[x, y]) < TH and not visited[y*w + x]:
            visited[y*w + x] = 1; q.append((x, y))
while q:
    x, y = q.popleft()
    for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
        nx, ny = x+dx, y+dy
        if 0 <= nx < w and 0 <= ny < h and not visited[ny*w + nx] and dist(px[nx, ny]) < TH:
            visited[ny*w + nx] = 1
            q.append((nx, ny))

rgba = im.convert("RGBA")
a = rgba.load()
for y in range(h):
    for x in range(w):
        if visited[y*w + x]:
            r, g, b, _ = a[x, y]
            a[x, y] = (r, g, b, 0)
        else:
            d = dist((a[x, y][0], a[x, y][1], a[x, y][2]))
            if d < TH + 20:
                a[x, y] = (a[x, y][0], a[x, y][1], a[x, y][2], int(255 * max(0, (d - TH) / 20)))

bbox = rgba.getbbox()
art = rgba.crop(bbox)
print("trimmed", art.size)


def compose(canvas_size, art, height_ratio, bottom_margin_ratio):
    th = int(canvas_size * height_ratio)
    tw = max(1, int(art.width * (th / art.height)))
    scaled = art.resize((tw, th), Image.LANCZOS)
    canvas = Image.new("RGBA", (canvas_size, canvas_size), LIGHT_BLUE + (255,))
    glow = Image.new("L", (canvas_size, canvas_size), 0)
    ImageDraw.Draw(glow).ellipse(
        [int(canvas_size*0.08), int(canvas_size*0.08), int(canvas_size*0.92), int(canvas_size*0.92)], fill=54)
    glow = glow.filter(ImageFilter.GaussianBlur(canvas_size // 12))
    canvas = Image.composite(Image.new("RGBA", (canvas_size, canvas_size), (255, 255, 255, 255)), canvas, glow)
    canvas.alpha_composite(scaled, ((canvas_size - tw) // 2,
                                    int(canvas_size - th - canvas_size * bottom_margin_ratio)))
    return canvas


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


icon = compose(S, art, 0.92, 0.012)
icon.putalpha(rounded_mask(S, int(S * 0.22)))

sizes = {"mipmap-mdpi": 48, "mipmap-hdpi": 72, "mipmap-xhdpi": 96,
         "mipmap-xxhdpi": 144, "mipmap-xxxhdpi": 192}
for folder, pxsize in sizes.items():
    icon.resize((pxsize, pxsize), Image.LANCZOS).save(f"{OUT}/{folder}/ic_launcher.png")

# adaptive: full artwork as background layer, transparent foreground
icon.resize((432, 432), Image.LANCZOS).save(f"{OUT}/mipmap-xxxhdpi/ic_launcher_bg.png")
Image.new("RGBA", (432, 432), (0, 0, 0, 0)).save(f"{OUT}/mipmap-xxxhdpi/ic_launcher_fg.png")
icon.resize((512, 512), Image.LANCZOS).save("/root/workspace/ds-chat/tools/icon-preview.png")
print("icon rebuilt")
