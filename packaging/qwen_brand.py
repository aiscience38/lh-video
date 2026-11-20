import json
import time
import urllib.request
import uuid
from pathlib import Path

BASE = "http://100.92.10.72:8188"
OUT = Path("C:/Users/saiya/projects/lh-video/public/og-image-qwen.png")

POS = (
    "Luxury brand identity on a charcoal black textured background with a cinematic spotlight from the top. "
    "Centered: a faceted brushed-silver metallic monogram of interlocking angular letters L and H, sharp geometric bevels, "
    "soft metallic highlights. Below it the wordmark LH VIDEO in an elegant high-contrast serif with wide letter spacing, embossed silver metal. "
    "Under it a thin letterspaced sans-serif line STUDIO flanked by thin horizontal rules in dark brushed steel. "
    "Strict monochrome silver and graphite palette, premium corporate identity, symmetrical composition, photorealistic brushed metal, subtle vignette."
)
NEG = (
    "neon green, lime, colorful gradient, cartoon, illustration, watermark, extra letters, gibberish text, "
    "distorted typography, clutter, low contrast, blurry, noisy"
)


def build():
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "qwen_image_2.1_int8_convrot.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors", "type": "qwen_image"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_2.1_vae_bf16.safetensors"}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": POS}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": NEG}},
        "6": {"class_type": "EmptySD3LatentImage", "inputs": {"width": 1248, "height": 832, "batch_size": 1}},
        "7": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "seed": 771129, "steps": 20, "cfg": 2.5, "sampler_name": "euler",
                                                    "scheduler": "simple", "positive": ["4", 0], "negative": ["5", 0],
                                                    "latent_image": ["6", 0], "denoise": 1.0}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": "lhvideo_brand"}},
    }


def post(path, payload):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.loads(response.read())


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as response:
        return response.read()


client_id = str(uuid.uuid4())
result = post("/prompt", {"prompt": build(), "client_id": client_id})
prompt_id = result["prompt_id"]
print("submitted:", prompt_id, "node_errors:", result.get("node_errors") or "none")

deadline = time.time() + 420
image = None
while time.time() < deadline:
    history = json.loads(get(f"/history/{prompt_id}"))
    entry = history.get(prompt_id)
    if entry and entry.get("status", {}).get("completed"):
        for node_output in entry.get("outputs", {}).values():
            for item in node_output.get("images", []):
                image = item
                break
        break
    time.sleep(4)

if not image:
    raise SystemExit("generation did not complete in time")

query = f"?filename={urllib.parse.quote(image['filename'])}&subfolder={urllib.parse.quote(image.get('subfolder', ''))}&type={image.get('type', 'output')}"
data = get("/view" + query)
OUT.write_bytes(data)
print("saved:", OUT, len(data), "bytes")
