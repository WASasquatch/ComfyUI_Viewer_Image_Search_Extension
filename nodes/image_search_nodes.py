"""
Image Search Nodes for ComfyUI_Viewer Image Search Extension.

This module provides nodes for image similarity search that integrate
with the ComfyUI_Viewer extension system.
"""

import os
import json
import struct
import torch
import folder_paths

from aiohttp import web
from server import PromptServer


def _read_png_text_chunks(filepath: str) -> dict:
    """
    Read PNG tEXt/iTXt chunks directly from file binary.
    This is more reliable than PIL for extracting ComfyUI workflow metadata.
    """
    result = {}
    
    try:
        with open(filepath, 'rb') as f:
            signature = f.read(8)
            if signature[:4] != b'\x89PNG':
                return result
            
            while True:
                length_bytes = f.read(4)
                if len(length_bytes) < 4:
                    break
                
                length = struct.unpack('>I', length_bytes)[0]
                chunk_type = f.read(4).decode('ascii', errors='ignore')
                data = f.read(length)
                f.read(4)  # Skip CRC
                
                if chunk_type in ('tEXt', 'iTXt', 'comf'):
                    try:
                        null_idx = data.find(b'\x00')
                        if null_idx > 0:
                            keyword = data[:null_idx].decode('latin-1')
                            if chunk_type == 'iTXt':
                                rest = data[null_idx + 1:]
                                text_start = 0
                                null_count = 0
                                for i, b in enumerate(rest):
                                    if b == 0:
                                        null_count += 1
                                        if null_count >= 4:
                                            text_start = i + 1
                                            break
                                if text_start > 0 and text_start < len(rest):
                                    text = rest[text_start:].decode('utf-8', errors='ignore')
                                else:
                                    text = rest.decode('utf-8', errors='ignore').lstrip('\x00')
                            else:
                                text = data[null_idx + 1:].decode('utf-8', errors='ignore')
                            result[keyword] = text
                    except Exception:
                        pass
                
                if chunk_type == 'IEND':
                    break
    except Exception:
        pass
    
    return result


# Register route using decorator pattern (like ComfyUI-Impact-Pack)
@PromptServer.instance.routes.get('/was/image_search/metadata')
async def get_image_metadata(request):
    """Retrieve workflow and prompt metadata from a PNG image."""
    try:
        filename = request.query.get('filename', '')
        subfolder = request.query.get('subfolder', '')
        img_type = request.query.get('type', 'output')
        
        display_path = f"{subfolder}/{filename}" if subfolder else filename
        print(f"[Image Search] Request for workflow: {display_path} (type={img_type})")
        
        if not filename:
            print("[Image Search] Error: Missing filename parameter")
            return web.json_response({'error': 'Missing filename parameter'}, status=400)
        
        if img_type == 'input':
            base_dir = folder_paths.get_input_directory()
        elif img_type == 'temp':
            base_dir = folder_paths.get_temp_directory()
        else:
            base_dir = folder_paths.get_output_directory()
        
        if subfolder:
            image_path = os.path.join(base_dir, subfolder, filename)
        else:
            image_path = os.path.join(base_dir, filename)
        
        if not os.path.exists(image_path):
            print(f"[Image Search] Error: Image not found at {image_path}")
            return web.json_response({'error': 'Image not found'}, status=404)
        
        print(f"[Image Search] Reading PNG metadata from: {image_path}")
        
        workflow = None
        prompt = None
        metadata_keys = []
        
        try:
            metadata = _read_png_text_chunks(image_path)
            metadata_keys = list(metadata.keys())
            print(f"[Image Search] Found metadata keys: {metadata_keys}")
            
            workflow_text = None
            prompt_text = None
            for key in metadata.keys():
                key_lower = key.lower()
                if key_lower == "workflow" and not workflow_text:
                    workflow_text = metadata[key]
                elif key_lower == "prompt" and not prompt_text:
                    prompt_text = metadata[key]
            
            if workflow_text:
                print(f"[Image Search] Found workflow for {filename}, extracting ({len(workflow_text)} chars)")
                try:
                    workflow = json.loads(workflow_text)
                    print("[Image Search] Workflow parsed successfully")
                except json.JSONDecodeError:
                    workflow = workflow_text
                    print("[Image Search] Workflow is not JSON, returning as text")
            else:
                print(f"[Image Search] No workflow embedded in {filename}")
            
            if prompt_text:
                print(f"[Image Search] Found prompt for {filename}, extracting ({len(prompt_text)} chars)")
                try:
                    prompt = json.loads(prompt_text)
                except json.JSONDecodeError:
                    prompt = prompt_text
                    
        except Exception as e:
            print(f"[Image Search] Error reading image metadata: {e}")
            return web.json_response({'error': f'Failed to read image: {str(e)}', 'metadata_keys': metadata_keys}, status=500)
        
        print(f"[Image Search] Workflow for {filename} sent (workflow={'yes' if workflow else 'no'}, prompt={'yes' if prompt else 'no'})")
        
        return web.json_response({
            'workflow': workflow,
            'prompt': prompt,
            'has_workflow': workflow is not None,
            'has_prompt': prompt is not None,
            'metadata_keys': metadata_keys,
        })
        
    except Exception as e:
        print(f"[Image Search] Metadata endpoint error: {e}")
        import traceback
        traceback.print_exc()
        return web.json_response({'error': str(e)}, status=500)


print("[Image Search] Metadata route registered: /was/image_search/metadata")


class WAS_ImageSearchOptions:
    """
    ComfyUI node that outputs image search configuration as JSON for ComfyUI_Viewer.
    
    This node creates a tagged JSON payload that the image_search parser in
    ComfyUI_Viewer will process to perform the actual search and display results
    in an interactive gallery view.
    """

    CLIP_MODELS = {
        "very_fast_low_quality": "openai/clip-vit-base-patch32",
        "balanced": "openai/clip-vit-base-patch16",
        "high_quality_slow": "openai/clip-vit-large-patch14",
    }
    
    SORT_ORDERS = [
        "highest_similarity_first",
        "lowest_similarity_first",
    ]
    
    RESOLUTION_MODES = [
        "largest_image_resolution",
        "smallest_image_resolution",
        "manual_width_height",
    ]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),

                # Search directories
                "search_input_dir": ("BOOLEAN", {"default": True, "tooltip": "Search ComfyUI input directory for similar images"}),
                "search_output_dir": ("BOOLEAN", {"default": True, "tooltip": "Search ComfyUI output directory for similar images"}),
                "search_temp_dir": ("BOOLEAN", {"default": False, "tooltip": "Search ComfyUI temp directory for similar images"}),

                # Similarity search
                "clip_quality": (list(cls.CLIP_MODELS.keys()), {"tooltip": "CLIP model quality: very_fast_low_quality (fastest), balanced, high_quality_slow (most accurate)"}),
                "similarity_threshold": ("FLOAT", {"default": 0.85, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "Minimum similarity score (0-1) for images to be included in results"}),
                "max_results": ("INT", {"default": 64, "min": 1, "max": 4096, "tooltip": "Maximum number of similar images to return"}),
                "sort_order": (cls.SORT_ORDERS, {"tooltip": "Sort results by highest or lowest similarity first"}),

                # Brightness split for dark/light outputs
                "brightness_split": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "Brightness threshold for splitting images into dark and light categories"}),

                # Output resolution
                "resolution_mode": (cls.RESOLUTION_MODES, {"default": cls.RESOLUTION_MODES[0], "tooltip": "How to determine output resolution: manual, or based on largest/smallest matched image"}),
                "resize_width": ("INT", {"default": 512, "min": 64, "max": 8192, "tooltip": "Output width in pixels (used when resolution_mode is manual_width_height)"}),
                "resize_height": ("INT", {"default": 512, "min": 64, "max": 8192, "tooltip": "Output height in pixels (used when resolution_mode is manual_width_height)"}),
                "resize_mode": ([
                    "stretch",
                    "fit",
                    "crop_center",
                    "crop_top",
                    "crop_bottom",
                    "crop_left",
                    "crop_right",
                    "pad_black",
                    "pad_white",
                    "pad_transparent",
                ], {"default": "crop_center", "tooltip": "How to resize images: stretch, fit (preserve aspect), crop from position, or pad with color"}),
                "resample": (["lanczos", "bicubic", "bilinear", "nearest"], {"default": "lanczos", "tooltip": "Resampling filter for resizing. Lanczos is highest quality, nearest is fastest"}),

                # Indexing / performance
                "rebuild_index": ("BOOLEAN", {"default": False, "tooltip": "Force rebuild of the similarity index. Use if images were modified externally"}),
                "index_threads": ("INT", {"default": 8, "min": 1, "max": 64, "tooltip": "Number of threads for parallel image loading during indexing"}),
                "embed_batch_size": ("INT", {"default": 64, "min": 1, "max": 512, "tooltip": "Batch size for CLIP embedding. Lower values use less VRAM"}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("search_options",)
    FUNCTION = "create_options"
    CATEGORY = "WAS/View"

    IMAGE_SEARCH_MARKER = "$WAS_IMAGE_SEARCH$"

    def create_options(
        self,
        images: torch.Tensor,
        search_input_dir: bool,
        search_output_dir: bool,
        search_temp_dir: bool,
        clip_quality: str,
        similarity_threshold: float,
        max_results: int,
        sort_order: str,
        brightness_split: float,
        resolution_mode: str,
        resize_width: int,
        resize_height: int,
        resize_mode: str,
        resample: str,
        rebuild_index: bool,
        index_threads: int,
        embed_batch_size: int,
    ) -> tuple[str]:
        """
        Create a JSON configuration for image search that ComfyUI_Viewer will process.
        
        The input images are saved to temp files and their paths are included in the
        configuration so the viewer's parser can perform the actual search.
        """
        import uuid
        import hashlib
        from PIL import Image
        import numpy as np
        
        # Save input images to temp files for the viewer parser to use
        session_id = str(uuid.uuid4())[:8]
        temp_dir = folder_paths.get_temp_directory()
        search_subdir = os.path.join(temp_dir, f"was_image_search_{session_id}")
        os.makedirs(search_subdir, exist_ok=True)
        
        query_image_paths = []
        for idx in range(images.shape[0]):
            img_array = (images[idx].clamp(0, 1).cpu().numpy() * 255.0).astype(np.uint8)
            if img_array.shape[-1] == 4:
                pil_img = Image.fromarray(img_array, mode='RGBA')
            else:
                pil_img = Image.fromarray(img_array, mode='RGB')
            
            img_hash = hashlib.md5(img_array.tobytes()).hexdigest()[:12]
            filename = f"query_{idx:04d}_{img_hash}.png"
            filepath = os.path.join(search_subdir, filename)
            pil_img.save(filepath, format='PNG')
            query_image_paths.append(filepath)
        
        # Build the search options JSON
        options = {
            "type": "image_search",
            "session_id": session_id,
            "query_images": query_image_paths,
            "search_input_dir": search_input_dir,
            "search_output_dir": search_output_dir,
            "search_temp_dir": search_temp_dir,
            "clip_quality": clip_quality,
            "clip_models": self.CLIP_MODELS,
            "similarity_threshold": similarity_threshold,
            "max_results": max_results,
            "sort_order": sort_order,
            "brightness_split": brightness_split,
            "resolution_mode": resolution_mode,
            "resize_width": resize_width,
            "resize_height": resize_height,
            "resize_mode": resize_mode,
            "resample": resample,
            "rebuild_index": rebuild_index,
            "index_threads": index_threads,
            "embed_batch_size": embed_batch_size,
        }
        
        result = self.IMAGE_SEARCH_MARKER + json.dumps(options)
        return (result,)


NODE_CLASS_MAPPINGS = {
    "WAS_ImageSearchOptions": WAS_ImageSearchOptions,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "WAS_ImageSearchOptions": "CV Image Search Options",
}
