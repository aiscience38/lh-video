from PIL import Image, ImageDraw, ImageFont

S = 1024
BG = (10, 10, 10, 255)
ACCENT = (213, 255, 71, 255)
DOT = (244, 247, 251, 255)

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)
draw.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=BG)

font = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", int(S * 0.46))
text = "LH"
box = draw.textbbox((0, 0), text, font=font)
w, h = box[2] - box[0], box[3] - box[1]
draw.text(((S - w) / 2 - box[0], (S - h) / 2 - box[1] - int(S * 0.03)), text, font=font, fill=ACCENT)

r = int(S * 0.055)
cx, cy = int(S * 0.78), int(S * 0.74)
draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=DOT)

img.save("packaging/lh-video.png")
img.save("packaging/lh-video.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("icon written")
