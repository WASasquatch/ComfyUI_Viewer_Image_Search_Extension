"""
Image Search Parser for WAS Content Viewer.

Handles:
- INPUT: Tagged JSON from WAS_ImageSearchOptions node
- Performs image similarity search using CLIP embeddings
- Gathers image metrics (brightness, colors, size, workflow)
- Returns gallery data for the image_search view

OUTPUT: Selected image paths from the gallery view
"""

import os
import json
import hashlib
from concurrent.futures import ThreadPoolExecutor, as_completed

from .base_parser import BaseParser


class ImageSearchParser(BaseParser):
    """Image search parser for similarity search and gallery display."""
    
    PARSER_NAME = "image_search"
    PARSER_PRIORITY = 110
    
    IMAGE_SEARCH_MARKER = "$WAS_IMAGE_SEARCH$"
    OUTPUT_MARKER = "$WAS_IMAGE_SEARCH_OUTPUT$"
    
    # Session cache for storing options by session_id
    _session_cache = {}
    
    @classmethod
    def _store_session_options(cls, session_id: str, options: dict):
        """Store options for a session."""
        if session_id:
            cls._session_cache[session_id] = options
            # Keep only last 10 sessions to avoid memory bloat
            if len(cls._session_cache) > 10:
                oldest = next(iter(cls._session_cache))
                del cls._session_cache[oldest]
    
    @classmethod
    def _get_session_options(cls, session_id: str) -> dict:
        """Retrieve stored options for a session."""
        return cls._session_cache.get(session_id, {})
    
    @classmethod
    def detect_input(cls, content) -> bool:
        """Check if content is image search options JSON."""
        if content is None:
            return False
        
        items = content if isinstance(content, (list, tuple)) else [content]
        
        for item in items:
            if isinstance(item, str) and item.startswith(cls.IMAGE_SEARCH_MARKER):
                return True
        return False
    
    @classmethod
    def handle_input(cls, content, logger=None) -> dict:
        """
        Process image search options and perform the search.
        
        Returns gallery data with image paths, metrics, and search results.
        """
        items = content if isinstance(content, (list, tuple)) else [content]
        
        search_content = None
        for item in items:
            if isinstance(item, str) and item.startswith(cls.IMAGE_SEARCH_MARKER):
                search_content = item
                break
        
        if not search_content:
            return None
        
        try:
            options = json.loads(search_content[len(cls.IMAGE_SEARCH_MARKER):])
        except json.JSONDecodeError as e:
            if logger:
                logger.error(f"[Image Search Parser] Invalid JSON: {e}")
            return None
        
        if options.get("type") != "image_search":
            return None
        
        # Perform the search and gather metrics
        gallery_data = cls._perform_search(options, logger)
        
        if not gallery_data:
            if logger:
                logger.warning("[Image Search Parser] No search results found")
            gallery_data = {
                "type": "image_search_gallery",
                "session_id": options.get("session_id", ""),
                "query_images": options.get("query_images", []),
                "results": [],
                "options": options,
            }
        
        display_content = cls.IMAGE_SEARCH_MARKER + json.dumps(gallery_data)
        content_hash = f"image_search_{gallery_data.get('session_id', '')}_{len(gallery_data.get('results', []))}"
        
        if logger:
            logger.info(f"[Image Search Parser] Found {len(gallery_data.get('results', []))} similar images")
        
        # On first run, passthrough the input query images as tensors
        query_images = options.get("query_images", [])
        output_tensors = cls._load_images_as_tensors(query_images, options, logger)
        
        return {
            "display_content": display_content,
            "output_values": [output_tensors],
            "content_hash": content_hash,
        }
    
    @classmethod
    def detect_output(cls, content: str) -> bool:
        """Check if content is image search output (selected paths)."""
        if not isinstance(content, str):
            return False
        return content.startswith(cls.OUTPUT_MARKER)
    
    @classmethod
    def parse_output(cls, content: str, logger=None) -> dict:
        """Parse image search output, load selected images as tensors."""
        try:
            import torch
            import numpy as np
            from PIL import Image
            import folder_paths
            
            data = json.loads(content[len(cls.OUTPUT_MARKER):])
            
            # Get selected images metadata: [{type, subfolder, filename}, ...]
            selected_items = data.get("selected", [])
            session_id = data.get("session_id", "")
            
            if logger:
                logger.info(f"[Image Search Parser] Output has {len(selected_items)} selected images")
            
            # Resolve metadata to full paths
            selected_paths = []
            for item in selected_items:
                img_type = item.get("type", "output")
                subfolder = item.get("subfolder", "")
                filename = item.get("filename", "")
                
                if not filename:
                    continue
                
                if img_type == "input":
                    base_dir = folder_paths.get_input_directory()
                elif img_type == "temp":
                    base_dir = folder_paths.get_temp_directory()
                else:
                    base_dir = folder_paths.get_output_directory()
                
                if subfolder:
                    full_path = os.path.join(base_dir, subfolder, filename)
                else:
                    full_path = os.path.join(base_dir, filename)
                
                if os.path.exists(full_path):
                    selected_paths.append(full_path)
                elif logger:
                    logger.warning(f"[Image Search Parser] Image not found: {full_path}")
            
            if not selected_paths:
                legacy_paths = data.get("selected_paths", [])
                for path in legacy_paths:
                    if path and os.path.exists(path):
                        selected_paths.append(path)
            
            options = cls._get_session_options(session_id) if session_id else {}
            
            if not selected_paths:
                if logger:
                    logger.warning("[Image Search Parser] No images selected or found")
                return {
                    "output_values": [torch.zeros((1, 64, 64, 3))],
                    "display_text": "No images selected",
                    "content_hash": "image_search_output_empty",
                }
            
            if logger:
                logger.info(f"[Image Search Parser] Resolved {len(selected_paths)} image paths")
            
            resolution_mode = options.get("resolution_mode", "manual_width_height")
            resize_width = int(options.get("resize_width", 512))
            resize_height = int(options.get("resize_height", 512))
            resize_mode = options.get("resize_mode", "crop_center")
            resample_str = options.get("resample", "lanczos")
            brightness_split = float(options.get("brightness_split", 0.5))
            
            resample_map = {
                "lanczos": Image.LANCZOS,
                "bicubic": Image.BICUBIC,
                "bilinear": Image.BILINEAR,
                "nearest": Image.NEAREST,
            }
            resample = resample_map.get(resample_str, Image.LANCZOS)
            
            if resolution_mode == "largest_image_resolution":
                dims = []
                for path in selected_paths:
                    try:
                        with Image.open(path) as img:
                            dims.append((img.width, img.height))
                    except Exception:
                        continue
                if dims:
                    resize_width, resize_height = max(dims, key=lambda x: x[0] * x[1])
            elif resolution_mode == "smallest_image_resolution":
                dims = []
                for path in selected_paths:
                    try:
                        with Image.open(path) as img:
                            dims.append((img.width, img.height))
                    except Exception:
                        continue
                if dims:
                    resize_width, resize_height = min(dims, key=lambda x: x[0] * x[1])
            
            want_alpha = (resize_mode == "pad_transparent")
            dark, light, all_imgs = [], [], []
            
            for path in selected_paths:
                try:
                    pil = Image.open(path).convert("RGB")
                except Exception as e:
                    if logger:
                        logger.warning(f"[Image Search Parser] Failed to load {path}: {e}")
                    continue
                
                arr_gray = np.array(pil.convert("L"))
                brightness = float(arr_gray.mean() / 255.0)
                pil_out = cls._resize_pil(pil, resize_width, resize_height, resize_mode, resample)
                t = cls._pil_to_tensor(pil_out, want_alpha=want_alpha)
                all_imgs.append(t)
                
                if brightness < brightness_split:
                    dark.append(t)
                else:
                    light.append(t)
            
            if not all_imgs:
                return {
                    "output_values": [torch.zeros((1, 64, 64, 3))],
                    "display_text": "Failed to load selected images",
                    "content_hash": "image_search_output_error",
                }
            
            out_all = torch.stack(all_imgs, dim=0)
            out_dark = torch.stack(dark, dim=0) if dark else out_all
            out_light = torch.stack(light, dim=0) if light else out_all
            
            return {
                "output_values": [out_all],
                "display_text": f"Loaded {len(all_imgs)} images ({len(dark)} dark, {len(light)} light)",
                "content_hash": f"image_search_output_{len(all_imgs)}",
                "extra_outputs": {
                    "dark_images": out_dark,
                    "light_images": out_light,
                    "image_paths": json.dumps(selected_paths),
                },
            }
        except json.JSONDecodeError as e:
            if logger:
                logger.error(f"[Image Search Parser] Failed to parse output: {e}")
            return None
        except Exception as e:
            if logger:
                logger.error(f"[Image Search Parser] Error processing output: {e}")
                import traceback
                logger.error(traceback.format_exc())
            return None
    
    @classmethod
    def _perform_search(cls, options: dict, logger=None) -> dict:
        """
        Perform image similarity search and gather metrics.
        """
        try:
            import folder_paths
            import numpy as np
            from PIL import Image
            
            clip_quality = options.get("clip_quality", "balanced")
            clip_models = options.get("clip_models", {
                "very_fast_low_quality": "openai/clip-vit-base-patch32",
                "balanced": "openai/clip-vit-base-patch16",
                "high_quality_slow": "openai/clip-vit-large-patch14",
            })
            model_id = clip_models.get(clip_quality, "openai/clip-vit-base-patch16")
            
            searcher = ImageSearchEngine(model_id, logger)
            
            if options.get("rebuild_index", False):
                searcher.clear_cache()
            
            files = cls._gather_files(
                options.get("search_input_dir", True),
                options.get("search_output_dir", True),
                options.get("search_temp_dir", False),
            )
            
            if not files:
                if logger:
                    logger.warning("[Image Search Parser] No files to search")
                return None
            
            index, index_vecs, meta = searcher.update_index(
                files=files,
                index_threads=int(options.get("index_threads", 8)),
                embed_batch_size=int(options.get("embed_batch_size", 64)),
            )
            
            query_paths = options.get("query_images", [])
            if not query_paths:
                if logger:
                    logger.warning("[Image Search Parser] No query images")
                return None
            
            query_pils = []
            for qp in query_paths:
                try:
                    pil = Image.open(qp).convert("RGB")
                    query_pils.append(pil)
                except Exception as e:
                    if logger:
                        logger.warning(f"[Image Search Parser] Failed to load query image {qp}: {e}")
            
            if not query_pils:
                return None
            
            q_vecs = searcher.embed_pils(query_pils, batch_size=int(options.get("embed_batch_size", 64)))
            
            similarity_threshold = float(options.get("similarity_threshold", 0.85))
            max_results = int(options.get("max_results", 64))
            pool_k = max(max_results * 4, max_results, 16)
            
            scores, ids = searcher.search(q_vecs, index, index_vecs, top_k=pool_k)
            
            collected = {}
            q_count = scores.shape[0]
            for qi in range(q_count):
                row_s = scores[qi]
                row_i = ids[qi]
                for s, i in zip(row_s, row_i):
                    s = float(s)
                    if s < similarity_threshold:
                        continue
                    m = meta[int(i)]
                    p = m["path"]
                    prev = collected.get(p, None)
                    if prev is None or prev["score"] < s:
                        collected[p] = {"score": s, "meta": m}
            
            sort_order = options.get("sort_order", "highest_similarity_first")
            reverse = (sort_order == "highest_similarity_first")
            ordered = sorted(collected.values(), key=lambda x: x["score"], reverse=reverse)
            
            ordered = ordered[:max_results]
            
            brightness_split = float(options.get("brightness_split", 0.5))
            results = cls._gather_metrics(ordered, brightness_split, logger)
            
            session_id = options.get("session_id", "")
            if session_id:
                cls._store_session_options(session_id, options)
            
            return {
                "type": "image_search_gallery",
                "session_id": session_id,
                "query_images": query_paths,
                "results": results,
                "options": options,
                "total_indexed": len(meta),
            }
            
        except Exception as e:
            if logger:
                logger.error(f"[Image Search Parser] Search failed: {e}")
                import traceback
                logger.error(traceback.format_exc())
            return None
    
    @classmethod
    def _gather_files(cls, search_input: bool, search_output: bool, search_temp: bool) -> list:
        """Gather image files from ComfyUI directories."""
        import folder_paths
        
        IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tiff", ".tif"}
        files = []
        
        dirs = []
        if search_input:
            dirs.append(folder_paths.get_input_directory())
        if search_output:
            dirs.append(folder_paths.get_output_directory())
        if search_temp:
            dirs.append(folder_paths.get_temp_directory())
        
        for base_dir in dirs:
            if not os.path.isdir(base_dir):
                continue
            for root, _, filenames in os.walk(base_dir):
                for fname in filenames:
                    ext = os.path.splitext(fname)[1].lower()
                    if ext in IMAGE_EXTENSIONS:
                        files.append(os.path.join(root, fname))
        
        return files
    
    @classmethod
    def _get_api_view_info(cls, path: str) -> dict:
        """Get filename, subfolder, type for ComfyUI /api/view endpoint."""
        import folder_paths
        
        filename = os.path.basename(path)
        parent_dir = os.path.dirname(path)
        
        input_dir = folder_paths.get_input_directory()
        output_dir = folder_paths.get_output_directory()
        temp_dir = folder_paths.get_temp_directory()
        
        for dir_path, dir_type in [(input_dir, "input"), (output_dir, "output"), (temp_dir, "temp")]:
            if path.startswith(dir_path):
                rel_path = os.path.relpath(parent_dir, dir_path)
                subfolder = "" if rel_path == "." else rel_path
                return {
                    "filename": filename,
                    "subfolder": subfolder,
                    "type": dir_type,
                }
        
        return {
            "filename": filename,
            "subfolder": "",
            "type": "output",
        }
    
    @classmethod
    def _gather_metrics(cls, ordered: list, brightness_split: float, logger=None) -> list:
        """Gather detailed metrics for each search result image."""
        from PIL import Image
        
        results = []
        
        def process_image(item):
            path = item["meta"]["path"]
            api_info = cls._get_api_view_info(path)
            
            result = {
                "path": path,
                "filename": api_info["filename"],
                "subfolder": api_info["subfolder"],
                "type": api_info["type"],
                "similarity": item["score"],
            }
            
            try:
                stat = os.stat(path)
                result["file_size"] = stat.st_size
                result["modified_time"] = stat.st_mtime
                
                pil = Image.open(path)
                result["width"] = pil.width
                result["height"] = pil.height
                result["format"] = pil.format
                result["mode"] = pil.mode
                
                pil_rgb = pil.convert("RGB")
                
                import numpy as np
                arr = np.array(pil_rgb.convert("L"))
                brightness = float(arr.mean() / 255.0)
                result["brightness"] = brightness
                result["is_dark"] = brightness < brightness_split
                
                has_workflow = False
                has_prompt = False
                # Check PNG metadata using direct binary parsing for reliability
                try:
                    if path.lower().endswith('.png'):
                        metadata = _read_png_text_chunks(path)
                        for key in metadata.keys():
                            key_lower = key.lower()
                            if key_lower == "workflow":
                                has_workflow = bool(metadata[key])
                            elif key_lower == "prompt":
                                has_prompt = bool(metadata[key])
                except Exception:
                    pass
                
                result["has_workflow"] = has_workflow
                result["has_prompt"] = has_prompt
                
                pil.close()
                
            except Exception as e:
                result["error"] = str(e)
            
            return result
        
        with ThreadPoolExecutor(max_workers=8) as executor:
            futures = [executor.submit(process_image, item) for item in ordered]
            for future in as_completed(futures):
                try:
                    result = future.result()
                    results.append(result)
                except Exception as e:
                    if logger:
                        logger.warning(f"[Image Search Parser] Failed to process image: {e}")
        
        results.sort(key=lambda x: x.get("similarity", 0), reverse=True)
        
        return results
    
    @classmethod
    def _load_images_as_tensors(cls, image_paths: list, options: dict, logger=None):
        """Load images from paths and return as stacked tensor batch."""
        import torch
        import numpy as np
        from PIL import Image
        
        if not image_paths:
            return torch.zeros((1, 64, 64, 3))
        
        resize_width = int(options.get("resize_width", 512))
        resize_height = int(options.get("resize_height", 512))
        resize_mode = options.get("resize_mode", "crop_center")
        resample_str = options.get("resample", "lanczos")
        
        resample_map = {
            "lanczos": Image.LANCZOS,
            "bicubic": Image.BICUBIC,
            "bilinear": Image.BILINEAR,
            "nearest": Image.NEAREST,
        }
        resample = resample_map.get(resample_str, Image.LANCZOS)
        
        tensors = []
        for path in image_paths:
            try:
                pil = Image.open(path).convert("RGB")
                pil_out = cls._resize_pil(pil, resize_width, resize_height, resize_mode, resample)
                t = cls._pil_to_tensor(pil_out)
                tensors.append(t)
            except Exception as e:
                if logger:
                    logger.warning(f"[Image Search Parser] Failed to load {path}: {e}")
                continue
        
        if not tensors:
            return torch.zeros((1, 64, 64, 3))
        
        return torch.stack(tensors, dim=0)
    
    @classmethod
    def _resize_pil(cls, pil_image, width, height, mode, resample):
        """Resize PIL image according to mode."""
        from PIL import Image
        
        if mode == "stretch":
            return pil_image.resize((width, height), resample)
        
        if mode == "fit":
            pil_image.thumbnail((width, height), resample)
            return pil_image
        
        if mode.startswith("crop_"):
            src_ratio = pil_image.width / pil_image.height
            dst_ratio = width / height
            
            if src_ratio > dst_ratio:
                new_h = height
                new_w = int(height * src_ratio)
            else:
                new_w = width
                new_h = int(width / src_ratio)
            
            resized = pil_image.resize((new_w, new_h), resample)
            
            if mode == "crop_center":
                left = (new_w - width) // 2
                top = (new_h - height) // 2
            elif mode == "crop_top":
                left = (new_w - width) // 2
                top = 0
            elif mode == "crop_bottom":
                left = (new_w - width) // 2
                top = new_h - height
            elif mode == "crop_left":
                left = 0
                top = (new_h - height) // 2
            elif mode == "crop_right":
                left = new_w - width
                top = (new_h - height) // 2
            else:
                left = (new_w - width) // 2
                top = (new_h - height) // 2
            
            return resized.crop((left, top, left + width, top + height))
        
        if mode.startswith("pad_"):
            src_ratio = pil_image.width / pil_image.height
            dst_ratio = width / height
            
            if src_ratio > dst_ratio:
                new_w = width
                new_h = int(width / src_ratio)
            else:
                new_h = height
                new_w = int(height * src_ratio)
            
            resized = pil_image.resize((new_w, new_h), resample)
            
            if mode == "pad_black":
                bg_color = (0, 0, 0)
                out_mode = "RGB"
            elif mode == "pad_white":
                bg_color = (255, 255, 255)
                out_mode = "RGB"
            else:
                bg_color = (0, 0, 0, 0)
                out_mode = "RGBA"
            
            result = Image.new(out_mode, (width, height), bg_color)
            paste_x = (width - new_w) // 2
            paste_y = (height - new_h) // 2
            
            if out_mode == "RGBA" and resized.mode != "RGBA":
                resized = resized.convert("RGBA")
            
            result.paste(resized, (paste_x, paste_y))
            return result
        
        return pil_image.resize((width, height), resample)
    
    @classmethod
    def _pil_to_tensor(cls, pil_image, want_alpha=False):
        """Convert PIL image to tensor (H, W, C) normalized 0-1."""
        import torch
        import numpy as np
        
        if want_alpha and pil_image.mode != "RGBA":
            pil_image = pil_image.convert("RGBA")
        elif not want_alpha and pil_image.mode == "RGBA":
            pil_image = pil_image.convert("RGB")
        
        arr = np.array(pil_image).astype(np.float32) / 255.0
        return torch.from_numpy(arr)


def send_progress(value: int, max_value: int, text: str = ""):
    """Send progress update to ComfyUI frontend."""
    try:
        from server import PromptServer
        PromptServer.instance.send_sync("progress", {
            "value": value,
            "max": max_value,
            "prompt_id": "",
            "node": "",
        })
    except Exception:
        pass


class ImageSearchEngine:
    """CLIP-based image search engine with caching."""
    
    def __init__(self, model_id: str, logger=None):
        self.model_id = model_id
        self.logger = logger
        self.model = None
        self.processor = None
        self.device = None
        self._load_model()
    
    def _load_model(self):
        """Load CLIP model."""
        import torch
        from transformers import CLIPModel, CLIPProcessor
        
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        
        if self.logger:
            self.logger.info(f"[ImageSearchEngine] Loading {self.model_id} on {self.device}")
        
        self.model = CLIPModel.from_pretrained(self.model_id)
        self.processor = CLIPProcessor.from_pretrained(self.model_id)
        self.model.to(self.device)
        self.model.eval()
    
    def _get_cache_paths(self):
        """Get cache file paths in ComfyUI_Viewer/.cache/image_search."""
        # Get the ComfyUI_Viewer directory (parent of modules/parsers)
        parser_dir = os.path.dirname(os.path.abspath(__file__))
        modules_dir = os.path.dirname(parser_dir)
        viewer_dir = os.path.dirname(modules_dir)
        
        cache_dir = os.path.join(viewer_dir, ".cache", "image_search")
        os.makedirs(cache_dir, exist_ok=True)
        
        model_hash = hashlib.md5(self.model_id.encode()).hexdigest()[:8]
        return {
            "index": os.path.join(cache_dir, f"index_{model_hash}.npy"),
            "meta": os.path.join(cache_dir, f"meta_{model_hash}.json"),
        }
    
    def clear_cache(self):
        """Clear cached index and metadata."""
        paths = self._get_cache_paths()
        for p in paths.values():
            if os.path.exists(p):
                try:
                    os.remove(p)
                except Exception:
                    pass
    
    def update_index(self, files: list, index_threads: int = 8, embed_batch_size: int = 64):
        """Update FAISS index with new files."""
        import numpy as np
        from PIL import Image
        
        paths = self._get_cache_paths()
        
        # Load existing
        existing_meta = []
        existing_vecs = None
        if os.path.exists(paths["meta"]):
            try:
                with open(paths["meta"], "r") as f:
                    existing_meta = json.load(f)
            except Exception:
                existing_meta = []
        
        existing_paths = {m["path"]: i for i, m in enumerate(existing_meta)}
        
        # Find new files
        new_files = []
        for f in files:
            if f not in existing_paths:
                new_files.append(f)
            else:
                # Check if modified
                try:
                    mtime = os.path.getmtime(f)
                    if mtime > existing_meta[existing_paths[f]].get("mtime", 0):
                        new_files.append(f)
                except Exception:
                    pass
        
        if self.logger:
            self.logger.info(f"[ImageSearchEngine] {len(new_files)} new/modified files to index")
        
        # Load images in parallel
        def load_image(path):
            try:
                pil = Image.open(path).convert("RGB")
                return (path, pil)
            except Exception:
                return None
        
        new_pils = []
        new_paths = []
        
        if self.logger and new_files:
            self.logger.info(f"[ImageSearchEngine] Loading {len(new_files)} images...")
        
        with ThreadPoolExecutor(max_workers=index_threads) as executor:
            futures = list(executor.map(load_image, new_files))
            for i, result in enumerate(futures):
                if result:
                    new_paths.append(result[0])
                    new_pils.append(result[1])
                # Update progress for loading phase (0-50%)
                if i % 10 == 0 or i == len(new_files) - 1:
                    send_progress(i + 1, len(new_files) * 2)
        
        # Embed new images
        new_vecs = None
        if new_pils:
            if self.logger:
                self.logger.info(f"[ImageSearchEngine] Embedding {len(new_pils)} images...")
            new_vecs = self.embed_pils(new_pils, batch_size=embed_batch_size, total_for_progress=len(new_files))
            
            # Add to metadata
            for i, path in enumerate(new_paths):
                try:
                    mtime = os.path.getmtime(path)
                except Exception:
                    mtime = 0
                existing_meta.append({"path": path, "mtime": mtime})
        
        # Combine vectors
        if os.path.exists(paths["index"]):
            try:
                existing_vecs = np.load(paths["index"])
            except Exception:
                existing_vecs = None
        
        if existing_vecs is not None and new_vecs is not None:
            all_vecs = np.vstack([existing_vecs, new_vecs])
        elif new_vecs is not None:
            all_vecs = new_vecs
        elif existing_vecs is not None:
            all_vecs = existing_vecs
        else:
            all_vecs = np.zeros((0, 512), dtype=np.float32)
        
        # Save
        np.save(paths["index"], all_vecs)
        with open(paths["meta"], "w") as f:
            json.dump(existing_meta, f)
        
        # Build FAISS index
        try:
            import faiss
            dim = all_vecs.shape[1] if len(all_vecs) > 0 else 512
            index = faiss.IndexFlatIP(dim)
            all_vecs_normalized = all_vecs.copy()
            if len(all_vecs_normalized) > 0:
                faiss.normalize_L2(all_vecs_normalized)
                index.add(all_vecs_normalized)
            return index, all_vecs, existing_meta
        except ImportError:
            # Fallback without FAISS - return vectors as index
            return None, all_vecs, existing_meta
    
    def embed_pils(self, pil_images: list, batch_size: int = 64, total_for_progress: int = 0):
        """Embed PIL images using CLIP."""
        import torch
        import numpy as np
        
        all_vecs = []
        total = total_for_progress or len(pil_images)
        num_batches = (len(pil_images) + batch_size - 1) // batch_size
        
        for batch_idx, i in enumerate(range(0, len(pil_images), batch_size)):
            batch = pil_images[i:i + batch_size]
            inputs = self.processor(images=batch, return_tensors="pt", padding=True)
            inputs = {k: v.to(self.device) for k, v in inputs.items()}
            
            with torch.no_grad():
                outputs = self.model.get_image_features(**inputs)
                vecs = outputs.cpu().numpy()
            
            all_vecs.append(vecs)
            
            # Update progress for embedding phase (50-100%)
            progress = total + int((batch_idx + 1) / num_batches * total)
            send_progress(progress, total * 2)
        
        return np.vstack(all_vecs) if all_vecs else np.zeros((0, 512), dtype=np.float32)
    
    def search(self, query_vecs, index, index_vecs, top_k: int = 64):
        """Search the index using pre-built index and vectors."""
        import numpy as np
        
        try:
            import faiss
            
            query_vecs_copy = query_vecs.copy()
            faiss.normalize_L2(query_vecs_copy)
            scores, ids = index.search(query_vecs_copy, top_k)
            return scores, ids
            
        except (ImportError, AttributeError):
            # Brute force without FAISS or if index is numpy array
            if index_vecs is None or len(index_vecs) == 0:
                return np.zeros((query_vecs.shape[0], top_k)), np.zeros((query_vecs.shape[0], top_k), dtype=np.int64)
            
            query_norm = query_vecs / (np.linalg.norm(query_vecs, axis=1, keepdims=True) + 1e-8)
            index_norm = index_vecs / (np.linalg.norm(index_vecs, axis=1, keepdims=True) + 1e-8)
            
            scores = query_norm @ index_norm.T
            ids = np.argsort(-scores, axis=1)[:, :top_k]
            scores = np.take_along_axis(scores, ids, axis=1)
            
            return scores, ids


def _read_png_text_chunks(filepath: str) -> dict:
    """
    Read PNG tEXt/iTXt chunks directly from file binary.
    This is more reliable than PIL for extracting ComfyUI workflow metadata.
    
    Based on ComfyUI frontend's png.ts implementation.
    """
    import struct
    
    result = {}
    
    with open(filepath, 'rb') as f:
        # Check PNG signature
        signature = f.read(8)
        if signature[:4] != b'\x89PNG':
            return result  # Not a valid PNG
        
        # Read chunks
        while True:
            # Read chunk length (4 bytes, big-endian)
            length_bytes = f.read(4)
            if len(length_bytes) < 4:
                break
            
            length = struct.unpack('>I', length_bytes)[0]
            
            # Read chunk type (4 bytes)
            chunk_type = f.read(4).decode('ascii', errors='ignore')
            
            # Read chunk data
            data = f.read(length)
            
            # Skip CRC (4 bytes)
            f.read(4)
            
            # Handle text chunks
            if chunk_type in ('tEXt', 'iTXt', 'comf'):
                try:
                    # Find null terminator for keyword
                    null_idx = data.find(b'\x00')
                    if null_idx > 0:
                        keyword = data[:null_idx].decode('latin-1')
                        
                        if chunk_type == 'iTXt':
                            # iTXt has compression flag and language tag after keyword
                            # Format: keyword\0 compression_flag\0 compression_method\0 language\0 translated_keyword\0 text
                            # Skip to the actual text content
                            rest = data[null_idx + 1:]
                            # Find the text after language/translated keyword nulls
                            text_start = 0
                            null_count = 0
                            for i, b in enumerate(rest):
                                if b == 0:
                                    null_count += 1
                                    if null_count >= 4:  # After compression, method, language, translated keyword
                                        text_start = i + 1
                                        break
                            if text_start > 0 and text_start < len(rest):
                                text = rest[text_start:].decode('utf-8', errors='ignore')
                            else:
                                # Simpler case - just keyword\0text
                                text = rest.decode('utf-8', errors='ignore').lstrip('\x00')
                        else:
                            # tEXt and comf: keyword\0text
                            text = data[null_idx + 1:].decode('utf-8', errors='ignore')
                        
                        result[keyword] = text
                except Exception:
                    pass
            
            # Stop at IEND
            if chunk_type == 'IEND':
                break
    
    return result


# Note: Route registration for /was/image_search/metadata is done in
# nodes/image_search_nodes.py at startup, not here in the parser.
