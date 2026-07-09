#!/home/duane/halcyon_venv/bin/python3
"""Generate Aion logo — patched to skip xformers."""
import sys, os

# Fix torch metadata for packaging
import importlib.metadata as _im
from importlib.metadata import distribution
d = distribution('torch')
# d.version should work now

sys.path.insert(0, '/home/duane/.openclaw/workspace/skills/image-gen/scripts')

# Monkey-patch the generate module before import to disable xformers
import generate as _gen_mod
_orig_load = _gen_mod.load_pipeline

def _patched_load():
    pipe = _orig_load()
    # Don't call enable_xformers — use attention slicing instead
    try:
        pipe.enable_attention_slicing()
    except Exception:
        pass
    return pipe

_gen_mod.load_pipeline = _patched_load

from generate import generate

path = generate(
    prompt="Modern tech logo design for Aion, a stylized glowing indigo orb with orbiting rings, sleek minimalist, dark background, gradient indigo to purple, no text, professional branding logo",
    negative_prompt="text, watermark, signature, messy, cluttered, photorealistic, person, animal",
    output_path="/home/duane/Desktop/aion-distro/branding/logo.png",
    num_inference_steps=30
)
print(f"\n✅ Logo generated: {path}")
