import json
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

BASE = "http://100.92.10.72:8188"
OUT_DIR = Path("C:/Users/saiya/projects/lh-video/.hermes/artifacts/comfyui-smoke")
OUT_DIR.mkdir(parents=True, exist_ok=True)

POS = "A single weathered lighthouse on a basalt cliff at dusk, monochrome silver light, fine grain, cinematic"
NEG = "color, neon, watermark, text, blurry"

graph = {
    "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "qwen_image_2.1_int8_convrot.safetensors", "weight_dtype": "default"}},
    "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_8b_fp8_scaled.safetensors", "type": "qwen_image"}},
    "3": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_2.1_vae_bf16.safetensors"}},
    "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": POS}},
    "5": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": NEG}},
    "6": {"class_type": "EmptySD3LatentImage", "inputs": {"width": 512, "height": 512, "batch_size": 1}},
    "10": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["1", 0], "shift": 3.1}},
    "7": {"class_type": "KSampler", "inputs": {"model": ["10", 0], "seed": 20261120, "steps": 16, "cfg": 3.0,
                                                "sampler_name": "euler", "scheduler": "simple",
                                                "positive": ["4", 0], "negative": ["5", 0],
                                                "latent_image": ["6", 0], "denoise": 1.0}},
    "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
    "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": "lhvideo_smoke"}},
}

def post(path, payload):
    request = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(request, timeout=30).read())

def get(path):
    return urllib.request.urlopen(BASE + path, timeout=30).read()

started = time.time()
response = post("/prompt", {"prompt": graph, "client_id": str(uuid.uuid4())})
prompt_id = response["prompt_id"]
if response.get("node_errors"):
    raise SystemExit(f"node errors: {response['node_errors']}")

deadline = time.time() + 420
image = None
while time.time() < deadline:
    entry = json.loads(get(f"/history/{prompt_id}")).get(prompt_id)
    if entry and entry.get("status", {}).get("completed"):
        for output in entry.get("outputs", {}).values():
            for item in output.get("images", []):
                image = item
                break
        break
    time.sleep(4)

if not image:
    raise SystemExit("generation did not complete in time")

query = f"?filename={urllib.parse.quote(image['filename'])}&subfolder={urllib.parse.quote(image.get('subfolder', ''))}&type={image.get('type', 'output')}"
data = get("/view" + query)
png = OUT_DIR / "comfyui-smoke-512.png"
png.write_bytes(data)
elapsed = round(time.time() - started, 1)
report = {"prompt_id": prompt_id, "template": "qwen-t2i-live", "width": 512, "height": 512,
          "steps": 16, "seconds": elapsed, "bytes": len(data), "png_magic": data[:8].hex()}
(OUT_DIR / "comfyui-smoke-512.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
print(json.dumps(report))
