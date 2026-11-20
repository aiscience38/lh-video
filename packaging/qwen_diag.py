import json
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

BASE = "http://100.92.10.72:8188"
OUT_DIR = Path("C:/Users/saiya/projects/lh-video/packaging/diag")
OUT_DIR.mkdir(parents=True, exist_ok=True)

POS = "A silver metallic monogram of the letters LH on a charcoal black background, studio product photo, luxury brand mark"
NEG = "colorful, neon, cartoon, text, watermark, blurry"


def workflow(clip_name, vae_name, use_shift):
    graph = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "qwen_image_2.1_int8_convrot.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": clip_name, "type": "qwen_image"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": vae_name}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": POS}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": NEG}},
        "6": {"class_type": "EmptySD3LatentImage", "inputs": {"width": 768, "height": 768, "batch_size": 1}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": "lhvideo_diag"}},
    }
    model_src = ["1", 0]
    if use_shift:
        graph["10"] = {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["1", 0], "shift": 3.1}}
        model_src = ["10", 0]
    graph["7"] = {"class_type": "KSampler", "inputs": {"model": model_src, "seed": 42, "steps": 12, "cfg": 3.0,
                                                        "sampler_name": "euler", "scheduler": "simple",
                                                        "positive": ["4", 0], "negative": ["5", 0],
                                                        "latent_image": ["6", 0], "denoise": 1.0}}
    return graph


def post(path, payload):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.loads(response.read())


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as response:
        return response.read()


def run(tag, clip_name, vae_name, use_shift):
    result = post("/prompt", {"prompt": workflow(clip_name, vae_name, use_shift), "client_id": str(uuid.uuid4())})
    prompt_id = result["prompt_id"]
    if result.get("node_errors"):
        print(tag, "NODE ERRORS", result["node_errors"])
        return
    deadline = time.time() + 240
    while time.time() < deadline:
        entry = json.loads(get(f"/history/{prompt_id}")).get(prompt_id)
        if entry and entry.get("status", {}).get("completed"):
            images = [i for out in entry.get("outputs", {}).values() for i in out.get("images", [])]
            if images:
                image = images[0]
                query = f"?filename={urllib.parse.quote(image['filename'])}&subfolder={urllib.parse.quote(image.get('subfolder', ''))}&type={image.get('type', 'output')}"
                data = get("/view" + query)
                path = OUT_DIR / f"{tag}.png"
                path.write_bytes(data)
                print(tag, "saved", path, len(data))
            return
        time.sleep(3)
    print(tag, "timeout")


run("A_shift_pe_t2i", "qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors", "qwen_image_2.1_vae_bf16.safetensors", True)
run("B_qwen3vl8b", "qwen3vl_8b_fp8_scaled.safetensors", "qwen_image_2.1_vae_bf16.safetensors", True)
