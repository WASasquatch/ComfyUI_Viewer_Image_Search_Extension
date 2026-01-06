/**
 * Image Search View - Interactive gallery for image similarity search results
 * 
 * Features:
 * - Gallery display with sorting by dark/light, colors, similarity, size
 * - Modal view for full-sized images with metrics and embedded workflows
 * - Selection capability for marking images for output
 * - Collapsible JSON tree for workflow display with copy buttons
 * - Sends selected image paths back to the node for processing
 */

import { BaseView, escapeHtml } from "./base_view.js";

class ImageSearchView extends BaseView {
  static id = "image_search";
  static displayName = "Image Search";
  static priority = 105;
  static isUI = true;

  static IMAGE_SEARCH_MARKER = "$WAS_IMAGE_SEARCH$";
  static OUTPUT_MARKER = "$WAS_IMAGE_SEARCH_OUTPUT$";

  static usesBaseStyles() {
    return false;
  }

  /**
   * Get message types this view handles
   */
  static getMessageTypes() {
    return ["image-search-output", "image-search-metadata-request"];
  }

  /**
   * Handle messages from iframe
   */
  static handleMessage(messageType, data, node, app, iframeSource) {
    // Handle metadata requests - fetch from parent context (same origin as ComfyUI)
    if (messageType === "image-search-metadata-request") {
      const { filename, subfolder, imageType, requestId } = data;
      
      // Fetch metadata from the API (we're in the same origin as ComfyUI)
      const params = new URLSearchParams({ filename: filename || '', subfolder: subfolder || '', type: imageType || 'output' });
      fetch(`/was/image_search/metadata?${params.toString()}`)
        .then(response => response.ok ? response.json() : { workflow: null, prompt: null })
        .then(metadata => {
          // Send response back to iframe
          if (iframeSource && iframeSource.postMessage) {
            iframeSource.postMessage({
              type: 'image-search-metadata-response',
              requestId: requestId,
              workflow: metadata.workflow || null,
              prompt: metadata.prompt || null
            }, '*');
          }
        })
        .catch(e => {
          console.warn('[Image Search View] Metadata fetch failed:', e);
          if (iframeSource && iframeSource.postMessage) {
            iframeSource.postMessage({
              type: 'image-search-metadata-response',
              requestId: requestId,
              workflow: null,
              prompt: null,
              error: e.message
            }, '*');
          }
        });
      return true;
    }
    
    // Handle output messages - updates view_state with selected images
    if (messageType !== "image-search-output") return false;
    if (data.action !== "output") return false;
    
    const outputData = data?.data;
    if (!outputData) {
      console.warn("[Image Search View] No output data in message");
      return false;
    }
    
    const outputString = "$WAS_IMAGE_SEARCH_OUTPUT$" + JSON.stringify(outputData);
    const viewStateWidget = node.widgets?.find(w => w.name === "view_state");
    if (viewStateWidget) {
      try {
        const viewState = JSON.parse(viewStateWidget.value || "{}");
        viewState.image_search_output = outputString;
        viewStateWidget.value = JSON.stringify(viewState);
      } catch (e) {
        console.error("[Image Search View] Failed to save view state:", e);
      }
      
      console.log("[Image Search View] Output saved, images:", outputData.selected?.length || 0);
      node.setDirtyCanvas?.(true, true);
      return true;
    }
    
    console.warn("[Image Search View] No view_state widget found");
    return false;
  }

  static detect(content) {
    try {
      let jsonContent = content;
      if (content.startsWith(this.IMAGE_SEARCH_MARKER)) {
        jsonContent = content.slice(this.IMAGE_SEARCH_MARKER.length);
      }
      const parsed = JSON.parse(jsonContent);
      if (parsed.type === "image_search_gallery" || parsed.type === "image_search") {
        return 210;
      }
    } catch {}
    return 0;
  }

  static render(content, theme) {
    let data;
    try {
      let jsonContent = content;
      if (content.startsWith(this.IMAGE_SEARCH_MARKER)) {
        jsonContent = content.slice(this.IMAGE_SEARCH_MARKER.length);
      }
      data = JSON.parse(jsonContent);
    } catch {
      return `<pre>Invalid image search data</pre>`;
    }

    const results = data.results || [];
    const options = data.options || {};
    const queryImages = data.query_images || [];
    
    const dataJson = JSON.stringify(data)
      .replace(/&/g, '&amp;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const origin = typeof window !== 'undefined' ? window.location.origin : '';

    return `
      <script></script>
      <div id="image-search-container" data-gallery='${dataJson}' data-origin="${origin}">
        <div class="search-toolbar">
          <div class="toolbar-group info-group">
            <span class="result-count">${results.length} results</span>
            <span class="selected-count" id="selected-count">0 selected</span>
          </div>
          <div class="toolbar-separator"></div>
          <div class="toolbar-group sort-group">
            <label>Sort:</label>
            <select id="sort-select">
              <option value="similarity">Similarity</option>
              <option value="brightness_dark">Dark First</option>
              <option value="brightness_light">Light First</option>
              <option value="size_large">Size (Large First)</option>
              <option value="size_small">Size (Small First)</option>
              <option value="filename">Filename</option>
            </select>
          </div>
          <div class="toolbar-group filter-group">
            <label>Filter:</label>
            <select id="filter-select">
              <option value="all">All</option>
              <option value="dark">Dark Only</option>
              <option value="light">Light Only</option>
              <option value="with_workflow">With Workflow</option>
            </select>
          </div>
          <div class="toolbar-group view-group">
            <label>Thumbnail Size:</label>
            <input type="range" id="thumb-size" min="80" max="300" value="150">
          </div>
          <div class="toolbar-spacer"></div>
          <div class="toolbar-group actions-group">
            <button id="select-all-btn" class="action-btn">Select All</button>
            <button id="clear-selection-btn" class="action-btn">Clear</button>
          </div>
        </div>
        <div class="gallery-container" id="gallery-container">
          <div class="gallery-grid" id="gallery-grid"></div>
        </div>
        <div id="image-modal" class="modal-overlay" style="display:none;">
          <div class="modal-content image-modal-content">
            <div class="modal-header">
              <span id="modal-title">Image Details</span>
              <button id="modal-close" class="modal-close-btn">×</button>
            </div>
            <div class="modal-body">
              <div class="modal-image-section">
                <img id="modal-image" src="" alt="">
              </div>
              <div class="modal-info-section">
                <div class="info-tabs">
                  <button class="tab-btn active" data-tab="metrics">Metrics</button>
                  <button class="tab-btn" data-tab="prompts">Prompts</button>
                  <button class="tab-btn" data-tab="workflow">Workflow</button>
                  <button class="tab-btn" data-tab="api">API</button>
                </div>
                <div class="tab-content" id="tab-metrics">
                  <div id="metrics-container"></div>
                </div>
                <div class="tab-content" id="tab-prompts" style="display:none;">
                  <div id="prompts-container"></div>
                </div>
                <div class="tab-content" id="tab-workflow" style="display:none;">
                  <div id="workflow-container"></div>
                </div>
                <div class="tab-content" id="tab-api" style="display:none;">
                  <div id="api-container"></div>
                </div>
              </div>
            </div>
            <div class="modal-footer">
              <button id="modal-select-btn" class="action-btn">Toggle Selection</button>
              <button id="modal-prev-btn" class="action-btn">← Previous</button>
              <button id="modal-next-btn" class="action-btn">Next →</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  static getStyles(theme) {
    return `
      *, *::before, *::after {
        box-sizing: border-box;
      }
      html, body {
        height: 100%;
        margin: 0;
        padding: 0;
        overflow: hidden;
      }
      #image-search-container {
        display: flex;
        flex-direction: column;
        height: 100%;
        background: var(--theme-bg);
        color: var(--theme-fg);
        font-family: system-ui, sans-serif;
        font-size: 12px;
      }
      .search-toolbar {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 12px;
        background: var(--theme-panel-header, var(--theme-bg-dark));
        border-bottom: 1px solid var(--theme-border);
        flex-wrap: wrap;
        min-height: 42px;
      }
      .toolbar-group {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .toolbar-separator {
        width: 1px;
        height: 24px;
        background: var(--theme-border);
        margin: 0 4px;
      }
      .toolbar-spacer {
        flex: 1;
      }
      .search-toolbar label {
        font-size: 11px;
        color: var(--theme-fg-muted);
        white-space: nowrap;
      }
      .search-toolbar select, .search-toolbar input[type="number"] {
        background: var(--theme-input-bg);
        color: var(--theme-fg);
        border: 1px solid var(--theme-input-border);
        border-radius: 4px;
        padding: 4px 6px;
        font-size: 11px;
      }
      .search-toolbar select:focus, .search-toolbar input:focus {
        border-color: var(--theme-input-focus);
        outline: none;
      }
      .search-toolbar input[type="range"] {
        width: 80px;
        accent-color: var(--theme-accent);
      }
      .result-count {
        font-weight: 600;
        color: var(--theme-accent);
      }
      .selected-count {
        color: var(--theme-fg-muted);
      }
      .action-btn {
        padding: 6px 12px;
        background: var(--theme-input-bg);
        color: var(--theme-fg);
        border: 1px solid var(--theme-input-border);
        border-radius: 6px;
        cursor: pointer;
        font-size: 11px;
        font-weight: 500;
        transition: all 0.15s ease;
      }
      .action-btn:hover {
        background: var(--theme-accent-bg);
        border-color: var(--theme-accent);
      }
      .action-btn.primary {
        background: var(--theme-accent);
        color: #fff;
        border-color: var(--theme-accent);
      }
      .action-btn.primary:hover {
        background: var(--theme-accent-hover);
        box-shadow: 0 2px 6px var(--theme-shadow);
      }
      .gallery-container {
        flex: 1;
        overflow: auto;
        padding: 12px;
      }
      .gallery-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(var(--thumb-size, 150px), 1fr));
        grid-auto-rows: 10px;
        gap: 12px;
      }
      .gallery-grid.empty {
        display: flex;
        min-height: calc(100vh - 200px);
      }
      .image-card {
        position: relative;
        border-radius: 8px;
        overflow: hidden;
        background: var(--theme-bg-dark);
        border: 2px solid transparent;
        cursor: pointer;
        transition: all 0.2s ease;
      }
      .image-card:hover {
        border-color: var(--theme-accent);
        transform: translateY(-2px);
        box-shadow: 0 4px 12px var(--theme-shadow);
      }
      .image-card.selected {
        border-color: var(--theme-accent);
        box-shadow: 0 0 0 2px var(--theme-accent);
      }
      .selection-circle {
        position: absolute;
        top: 8px;
        right: 8px;
        width: 24px;
        height: 24px;
        background: rgba(0,0,0,0.5);
        border: 2px solid rgba(255,255,255,0.8);
        border-radius: 50%;
        cursor: pointer;
        z-index: 10;
        transition: all 0.15s ease;
      }
      .selection-circle:hover {
        background: rgba(0,0,0,0.7);
        border-color: var(--theme-accent);
        transform: scale(1.1);
      }
      .image-card.selected .selection-circle {
        background: var(--theme-accent);
        border-color: var(--theme-accent);
      }
      .image-card.selected .selection-circle::after {
        content: '✓';
        color: #fff;
        font-size: 14px;
        font-weight: bold;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
      }
      .image-card img {
        width: 100%;
        height: auto;
        display: block;
      }
      .image-card .card-overlay {
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        background: linear-gradient(transparent, rgba(0,0,0,0.8));
        padding: 8px;
        opacity: 0;
        transition: opacity 0.2s ease;
      }
      .image-card:hover .card-overlay {
        opacity: 1;
      }
      .card-overlay .card-filename {
        font-size: 10px;
        color: #fff;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .card-overlay .card-metrics {
        display: flex;
        gap: 8px;
        margin-top: 4px;
        font-size: 9px;
        color: rgba(255,255,255,0.7);
      }
      .card-overlay .metric-badge {
        display: flex;
        align-items: center;
        gap: 2px;
      }
      .brightness-indicator {
        position: absolute;
        top: 8px;
        left: 8px;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        border: 2px solid rgba(255,255,255,0.5);
        z-index: 5;
        pointer-events: auto;
      }
      .brightness-indicator.dark {
        background: #333;
      }
      .brightness-indicator.light {
        background: #fff;
      }
      .workflow-indicator {
        position: absolute;
        top: 8px;
        left: 28px;
        font-size: 12px;
        opacity: 0.7;
        z-index: 5;
        pointer-events: auto;
        cursor: pointer;
      }
      .workflow-indicator:hover {
        opacity: 1;
        transform: scale(1.1);
      }

      /* Modal */
      .modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.8);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }
      .modal-content {
        background: var(--theme-panel-bg, var(--theme-bg));
        border-radius: 12px;
        max-width: 95vw;
        max-height: 95vh;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      }
      .image-modal-content {
        width: 90vw;
        height: 90vh;
      }
      .modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid var(--theme-border);
        background: var(--theme-panel-header, var(--theme-bg-dark));
      }
      .modal-header span {
        font-weight: 600;
        font-size: 14px;
      }
      .modal-close-btn {
        background: none;
        border: none;
        color: var(--theme-fg);
        font-size: 20px;
        cursor: pointer;
        padding: 4px 8px;
        border-radius: 4px;
      }
      .modal-close-btn:hover {
        background: var(--theme-accent-bg);
      }
      .modal-body {
        flex: 1;
        display: flex;
        overflow: hidden;
      }
      .modal-image-section {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        background: repeating-conic-gradient(#333 0% 25%, #444 0% 50%) 50% / 20px 20px;
        overflow: auto;
      }
      .modal-image-section img {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
        border-radius: 4px;
      }
      .modal-info-section {
        width: 400px;
        border-left: 1px solid var(--theme-border);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .info-tabs {
        display: flex;
        border-bottom: 1px solid var(--theme-border);
      }
      .tab-btn {
        flex: 1;
        padding: 10px;
        background: none;
        border: none;
        color: var(--theme-fg-muted);
        cursor: pointer;
        font-size: 12px;
        border-bottom: 2px solid transparent;
      }
      .tab-btn:hover {
        background: var(--theme-accent-bg);
      }
      .tab-btn.active {
        color: var(--theme-accent);
        border-bottom-color: var(--theme-accent);
      }
      .tab-content {
        flex: 1;
        overflow: auto;
        padding: 12px;
      }
      .modal-footer {
        display: flex;
        gap: 8px;
        padding: 12px 16px;
        border-top: 1px solid var(--theme-border);
        justify-content: flex-end;
      }

      /* Metrics display */
      .metric-row {
        display: flex;
        align-items: center;
        padding: 8px 0;
        border-bottom: 1px solid var(--theme-border);
      }
      .metric-row:last-child {
        border-bottom: none;
      }
      .metric-label {
        flex: 0 0 100px;
        font-weight: 500;
        color: var(--theme-fg-muted);
        font-size: 11px;
      }
      .metric-value {
        flex: 1;
        font-size: 12px;
        word-break: break-all;
      }
      .metric-value .copy-btn {
        opacity: 0;
        margin-left: 8px;
        padding: 2px 6px;
        font-size: 10px;
        background: var(--theme-input-bg);
        border: 1px solid var(--theme-input-border);
        border-radius: 4px;
        cursor: pointer;
        transition: opacity 0.15s;
      }
      .metric-row:hover .copy-btn {
        opacity: 1;
      }
      .copy-btn:hover {
        background: var(--theme-accent-bg);
        border-color: var(--theme-accent);
      }
      .copy-btn.copied {
        background: var(--theme-success, #28a745);
        color: #fff;
      }

      /* JSON Tree */
      .json-tree {
        font-family: 'Consolas', 'Monaco', monospace;
        font-size: 11px;
        line-height: 1.6;
      }
      .json-tree .json-item {
        margin-left: 16px;
      }
      .json-tree .json-key {
        color: var(--theme-accent);
      }
      .json-tree .json-string {
        color: #98c379;
      }
      .json-tree .json-number {
        color: #d19a66;
      }
      .json-tree .json-boolean {
        color: #56b6c2;
      }
      .json-tree .json-null {
        color: #c678dd;
      }
      .json-tree .json-bracket {
        color: var(--theme-fg-muted);
      }
      .json-tree .json-collapsible {
        cursor: pointer;
        user-select: none;
      }
      .json-tree .json-collapsible::before {
        content: '▼';
        display: inline-block;
        width: 14px;
        font-size: 10px;
        transition: transform 0.15s;
      }
      .json-tree .json-collapsible.collapsed::before {
        transform: rotate(-90deg);
      }
      .json-tree .json-collapsed-content {
        display: none;
      }
      .json-tree .json-collapsed-preview {
        color: var(--theme-fg-muted);
        font-style: italic;
      }
      .json-value-wrapper {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .json-value-wrapper .copy-btn {
        opacity: 0;
        padding: 1px 4px;
        font-size: 9px;
      }
      .json-value-wrapper:hover .copy-btn {
        opacity: 1;
      }

      /* Empty state */
      .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        width: 100%;
        color: var(--theme-fg-muted);
        text-align: center;
        grid-column: 1 / -1;
      }
      .empty-state .empty-icon {
        font-size: 64px;
        opacity: 0.4;
        margin-bottom: 16px;
      }
      .empty-state .empty-title {
        font-size: 18px;
        font-weight: 500;
        margin-bottom: 8px;
        color: var(--theme-fg);
      }
      .empty-state .empty-hint {
        font-size: 14px;
        opacity: 0.7;
      }

      /* Prompts list */
      .prompts-list {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .prompt-item {
        background: var(--theme-bg-dark);
        border: 1px solid var(--theme-border);
        border-radius: 8px;
        overflow: hidden;
      }
      .prompt-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        background: var(--theme-panel-header, rgba(0,0,0,0.2));
        border-bottom: 1px solid var(--theme-border);
      }
      .prompt-source {
        font-size: 11px;
        font-weight: 600;
        color: var(--theme-accent);
        background: var(--theme-accent-bg, rgba(100,150,255,0.15));
        padding: 2px 8px;
        border-radius: 4px;
      }
      .prompt-input-name {
        font-size: 11px;
        color: var(--theme-fg-muted);
        font-style: italic;
      }
      .prompt-copy-btn {
        margin-left: auto;
        padding: 4px 8px;
        font-size: 12px;
        background: var(--theme-input-bg);
        border: 1px solid var(--theme-input-border);
        border-radius: 4px;
        cursor: pointer;
        transition: all 0.15s;
      }
      .prompt-copy-btn:hover {
        background: var(--theme-accent-bg);
        border-color: var(--theme-accent);
      }
      .prompt-copy-btn.copied {
        background: var(--theme-success, #28a745);
        color: #fff;
      }
      .prompt-text {
        margin: 0;
        padding: 12px;
        font-family: 'Consolas', 'Monaco', monospace;
        font-size: 12px;
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-word;
        color: var(--theme-fg);
        max-height: 200px;
        overflow: auto;
      }

      /* Tab copy header */
      .tab-copy-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 0;
        margin-bottom: 8px;
        border-bottom: 1px solid var(--theme-border);
      }
      .tab-copy-hint {
        font-size: 11px;
        color: var(--theme-fg-muted);
        font-style: italic;
      }
      .copy-workflow-btn,
      .copy-api-btn {
        flex-shrink: 0;
      }
      .copy-workflow-btn.copied,
      .copy-api-btn.copied {
        background: var(--theme-success, #28a745);
        color: #fff;
        border-color: var(--theme-success, #28a745);
      }
    `;
  }

  static getScripts() {
    return `
      <script>
        (function() {
          const container = document.getElementById('image-search-container');
          if (!container) return;

          const galleryData = JSON.parse(container.getAttribute('data-gallery'));
          const origin = container.getAttribute('data-origin') || '*';
          const results = galleryData.results || [];
          const options = galleryData.options || {};

          let selectedPaths = new Set();
          let currentSort = 'similarity';
          let currentFilter = 'all';
          let thumbSize = 150;
          let currentModalIndex = -1;
          let filteredResults = [...results];

          const grid = document.getElementById('gallery-grid');
          const modal = document.getElementById('image-modal');
          const sortSelect = document.getElementById('sort-select');
          const filterSelect = document.getElementById('filter-select');
          const thumbSizeInput = document.getElementById('thumb-size');
          const selectedCountEl = document.getElementById('selected-count');

          function updateSelectedCount() {
            selectedCountEl.textContent = selectedPaths.size + ' selected';
          }

          function sortResults(items) {
            let sorted = [...items];
            
            switch (currentSort) {
              case 'similarity':
                sorted.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
                break;
              case 'brightness_dark':
                sorted.sort((a, b) => (a.brightness || 0) - (b.brightness || 0));
                break;
              case 'brightness_light':
                sorted.sort((a, b) => (b.brightness || 0) - (a.brightness || 0));
                break;
              case 'size_large':
                sorted.sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)));
                break;
              case 'size_small':
                sorted.sort((a, b) => ((a.width || 0) * (a.height || 0)) - ((b.width || 0) * (b.height || 0)));
                break;
              case 'filename':
                sorted.sort((a, b) => (a.filename || '').localeCompare(b.filename || ''));
                break;
            }
            return sorted;
          }

          function filterResults(items) {
            switch (currentFilter) {
              case 'dark':
                return items.filter(r => r.is_dark === true);
              case 'light':
                return items.filter(r => r.is_dark === false);
              case 'with_workflow':
                return items.filter(r => r.has_workflow === true);
              default:
                return items;
            }
          }

          function getImageUrl(path) {
            // Convert file path to ComfyUI view URL
            // Determine the type based on path contents
            let type = 'input';
            let subfolder = '';
            let filename = path;
            
            // Parse path to extract type and subfolder
            const pathLower = path.toLowerCase().replace(/\\\\/g, '/');
            if (pathLower.includes('/output/')) {
              type = 'output';
              const parts = path.split(/[/\\\\]output[/\\\\]/i);
              if (parts.length > 1) {
                const remaining = parts[1];
                const lastSlash = Math.max(remaining.lastIndexOf('/'), remaining.lastIndexOf('\\\\'));
                if (lastSlash > 0) {
                  subfolder = remaining.substring(0, lastSlash);
                  filename = remaining.substring(lastSlash + 1);
                } else {
                  filename = remaining;
                }
              }
            } else if (pathLower.includes('/temp/')) {
              type = 'temp';
              const parts = path.split(/[/\\\\]temp[/\\\\]/i);
              if (parts.length > 1) {
                const remaining = parts[1];
                const lastSlash = Math.max(remaining.lastIndexOf('/'), remaining.lastIndexOf('\\\\'));
                if (lastSlash > 0) {
                  subfolder = remaining.substring(0, lastSlash);
                  filename = remaining.substring(lastSlash + 1);
                } else {
                  filename = remaining;
                }
              }
            } else if (pathLower.includes('/input/')) {
              type = 'input';
              const parts = path.split(/[/\\\\]input[/\\\\]/i);
              if (parts.length > 1) {
                const remaining = parts[1];
                const lastSlash = Math.max(remaining.lastIndexOf('/'), remaining.lastIndexOf('\\\\'));
                if (lastSlash > 0) {
                  subfolder = remaining.substring(0, lastSlash);
                  filename = remaining.substring(lastSlash + 1);
                } else {
                  filename = remaining;
                }
              }
            } else {
              // Fallback: just use the filename
              const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\\\'));
              if (lastSlash >= 0) {
                filename = path.substring(lastSlash + 1);
              }
            }
            
            return origin + '/view?filename=' + encodeURIComponent(filename) + 
                   '&type=' + type + 
                   '&subfolder=' + encodeURIComponent(subfolder);
          }

          function calculateRowSpan(width, height, columnWidth) {
            if (!width || !height) return 15; // default
            const aspectRatio = height / width;
            const imgHeight = columnWidth * aspectRatio;
            const rowHeight = 10; // matches grid-auto-rows
            const gap = 12;
            return Math.ceil((imgHeight + gap) / (rowHeight + gap));
          }

          function renderGallery() {
            filteredResults = sortResults(filterResults(results));
            grid.innerHTML = '';
            grid.style.setProperty('--thumb-size', thumbSize + 'px');

            if (filteredResults.length === 0) {
              grid.classList.add('empty');
              if (results.length === 0) {
                grid.innerHTML = '<div class="empty-state"><div class="empty-icon">🔎</div><div class="empty-title">Image Search</div><div class="empty-hint">Run workflow to search for similar images</div></div>';
              } else {
                grid.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div><div>No images match the current filter</div></div>';
              }
              return;
            }
            grid.classList.remove('empty');

            filteredResults.forEach((result, index) => {
              const card = document.createElement('div');
              card.className = 'image-card' + (selectedPaths.has(result.path) ? ' selected' : '');
              card.dataset.index = index;
              card.dataset.path = result.path;

              // Calculate row span based on aspect ratio
              const rowSpan = calculateRowSpan(result.width, result.height, thumbSize);
              card.style.gridRowEnd = 'span ' + rowSpan;

              const imgUrl = getImageUrl(result.path);
              const similarity = result.similarity ? (result.similarity * 100).toFixed(1) + '%' : '-';
              const size = result.width && result.height ? result.width + '×' + result.height : '-';
              const brightnessClass = result.is_dark ? 'dark' : 'light';

              card.innerHTML = 
                '<div class="selection-circle"></div>' +
                '<div class="brightness-indicator ' + brightnessClass + '"></div>' +
                (result.has_workflow ? '<div class="workflow-indicator">📋</div>' : '') +
                '<img src="' + imgUrl + '" alt="' + (result.filename || '') + '" loading="lazy">' +
                '<div class="card-overlay">' +
                  '<div class="card-filename">' + (result.filename || 'Unknown') + '</div>' +
                  '<div class="card-metrics">' +
                    '<span class="metric-badge">📊 ' + similarity + '</span>' +
                    '<span class="metric-badge">📐 ' + size + '</span>' +
                  '</div>' +
                '</div>';

              // Selection circle click - toggle selection without opening modal
              card.querySelector('.selection-circle').addEventListener('click', (e) => {
                e.stopPropagation();
                toggleSelection(result.path, card);
              });

              card.addEventListener('click', (e) => {
                if (e.shiftKey) {
                  toggleSelection(result.path, card);
                } else {
                  openModal(index);
                }
              });

              card.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                toggleSelection(result.path, card);
              });

              grid.appendChild(card);
            });
          }

          function toggleSelection(path, card) {
            if (selectedPaths.has(path)) {
              selectedPaths.delete(path);
              card?.classList.remove('selected');
            } else {
              selectedPaths.add(path);
              card?.classList.add('selected');
            }
            updateSelectedCount();
            sendOutput();
          }

          function formatBytes(bytes) {
            if (!bytes) return '-';
            const units = ['B', 'KB', 'MB', 'GB'];
            let i = 0;
            while (bytes >= 1024 && i < units.length - 1) {
              bytes /= 1024;
              i++;
            }
            return bytes.toFixed(1) + ' ' + units[i];
          }

          function formatDate(timestamp) {
            if (!timestamp) return '-';
            return new Date(timestamp * 1000).toLocaleString();
          }

          function createCopyButton(value) {
            const btn = document.createElement('button');
            btn.className = 'copy-btn';
            btn.textContent = '📋';
            btn.title = 'Copy to clipboard';
            btn.onclick = (e) => {
              e.stopPropagation();
              navigator.clipboard.writeText(String(value)).then(() => {
                btn.textContent = '✓';
                btn.classList.add('copied');
                setTimeout(() => {
                  btn.textContent = '📋';
                  btn.classList.remove('copied');
                }, 1000);
              });
            };
            return btn;
          }

          // Options: { collapseKeys: ['key1', 'key2'], collapseDepth: 1 }
          // collapseKeys: specific keys to collapse at depth 1
          // collapseDepth: collapse all keys at this depth (0 = root object children)
          function renderJsonTree(obj, depth = 0, options = {}, currentKey = null) {
            if (obj === null) return '<span class="json-null">null</span>';
            if (obj === undefined) return '<span class="json-null">undefined</span>';
            
            const type = typeof obj;
            const { collapseKeys = [], collapseDepth = -1 } = options;
            
            // Check if this node should be collapsed
            const shouldCollapse = (collapseDepth >= 0 && depth === collapseDepth + 1) ||
                                   (currentKey && collapseKeys.includes(currentKey));
            
            if (type === 'string') {
              const wrapper = document.createElement('span');
              wrapper.className = 'json-value-wrapper';
              wrapper.innerHTML = '<span class="json-string">"' + escapeHtmlLocal(obj) + '"</span>';
              wrapper.appendChild(createCopyButton(obj));
              return wrapper.outerHTML;
            }
            if (type === 'number') {
              const wrapper = document.createElement('span');
              wrapper.className = 'json-value-wrapper';
              wrapper.innerHTML = '<span class="json-number">' + obj + '</span>';
              wrapper.appendChild(createCopyButton(obj));
              return wrapper.outerHTML;
            }
            if (type === 'boolean') {
              return '<span class="json-boolean">' + obj + '</span>';
            }
            
            if (Array.isArray(obj)) {
              if (obj.length === 0) return '<span class="json-bracket">[]</span>';
              const id = 'json-' + Math.random().toString(36).substr(2, 9);
              const collapsedClass = shouldCollapse ? ' collapsed' : '';
              const contentDisplay = shouldCollapse ? 'json-collapsed-content' : '';
              const previewDisplay = shouldCollapse ? 'inline' : 'none';
              let html = '<span class="json-collapsible' + collapsedClass + '" onclick="toggleJsonCollapse(this)" data-id="' + id + '">' +
                '<span class="json-bracket">[</span></span>' +
                '<span class="json-collapsed-preview" id="' + id + '-preview" style="display:' + previewDisplay + '">' +
                obj.length + ' items...]</span>' +
                '<div class="json-item ' + contentDisplay + '" id="' + id + '">';
              obj.forEach((item, i) => {
                html += renderJsonTree(item, depth + 1, options, null);
                if (i < obj.length - 1) html += ',';
                html += '<br>';
              });
              html += '</div>' + (shouldCollapse ? '' : '<span class="json-bracket">]</span>');
              return html;
            }
            
            if (type === 'object') {
              const keys = Object.keys(obj);
              if (keys.length === 0) return '<span class="json-bracket">{}</span>';
              const id = 'json-' + Math.random().toString(36).substr(2, 9);
              const collapsedClass = shouldCollapse ? ' collapsed' : '';
              const contentDisplay = shouldCollapse ? 'json-collapsed-content' : '';
              const previewDisplay = shouldCollapse ? 'inline' : 'none';
              let html = '<span class="json-collapsible' + collapsedClass + '" onclick="toggleJsonCollapse(this)" data-id="' + id + '">' +
                '<span class="json-bracket">{</span></span>' +
                '<span class="json-collapsed-preview" id="' + id + '-preview" style="display:' + previewDisplay + '">' +
                keys.length + ' keys...}</span>' +
                '<div class="json-item ' + contentDisplay + '" id="' + id + '">';
              keys.forEach((key, i) => {
                html += '<span class="json-key">"' + escapeHtmlLocal(key) + '"</span>: ' + renderJsonTree(obj[key], depth + 1, options, key);
                if (i < keys.length - 1) html += ',';
                html += '<br>';
              });
              html += '</div>' + (shouldCollapse ? '' : '<span class="json-bracket">}</span>');
              return html;
            }
            
            return String(obj);
          }

          function escapeHtmlLocal(str) {
            return String(str)
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;');
          }

          window.toggleJsonCollapse = function(el) {
            const id = el.getAttribute('data-id');
            const content = document.getElementById(id);
            const preview = document.getElementById(id + '-preview');
            el.classList.toggle('collapsed');
            if (el.classList.contains('collapsed')) {
              content.classList.add('json-collapsed-content');
              if (preview) preview.style.display = 'inline';
            } else {
              content.classList.remove('json-collapsed-content');
              if (preview) preview.style.display = 'none';
            }
          };

          // Cache for fetched workflow/prompt data to avoid re-fetching
          const metadataCache = new Map();
          
          // Pending metadata requests (requestId -> {resolve, reject})
          const pendingMetadataRequests = new Map();
          let metadataRequestCounter = 0;
          
          // Listen for metadata responses from parent
          window.addEventListener('message', (event) => {
            if (event.data && event.data.type === 'image-search-metadata-response') {
              const { requestId, workflow, prompt, error } = event.data;
              const pending = pendingMetadataRequests.get(requestId);
              if (pending) {
                pendingMetadataRequests.delete(requestId);
                if (error) {
                  console.warn('[Image Search] Metadata request failed:', error);
                }
                pending.resolve({ workflow: workflow || null, prompt: prompt || null });
              }
            }
          });

          // Request workflow/prompt metadata via postMessage to parent (avoids CORS issues)
          function fetchImageMetadata(result) {
            return new Promise((resolve) => {
              const requestId = 'metadata-' + (++metadataRequestCounter);
              
              // Set timeout to avoid hanging forever
              const timeout = setTimeout(() => {
                if (pendingMetadataRequests.has(requestId)) {
                  pendingMetadataRequests.delete(requestId);
                  console.warn('[Image Search] Metadata request timed out');
                  resolve({ workflow: null, prompt: null });
                }
              }, 10000);
              
              pendingMetadataRequests.set(requestId, {
                resolve: (data) => {
                  clearTimeout(timeout);
                  resolve(data);
                }
              });
              
              // Send request to parent
              window.parent.postMessage({
                type: 'image-search-metadata-request',
                filename: result.filename || '',
                subfolder: result.subfolder || '',
                imageType: result.type || 'output',
                requestId: requestId
              }, '*');
            });
          }

          function openModal(index) {
            const result = filteredResults[index];
            if (!result) return;

            currentModalIndex = index;
            
            const modalImage = document.getElementById('modal-image');
            const modalTitle = document.getElementById('modal-title');
            const metricsContainer = document.getElementById('metrics-container');
            const promptsContainer = document.getElementById('prompts-container');
            const workflowContainer = document.getElementById('workflow-container');
            const apiContainer = document.getElementById('api-container');
            const modalSelectBtn = document.getElementById('modal-select-btn');

            modalTitle.textContent = result.filename || 'Image Details';
            modalImage.src = getImageUrl(result.path);
            
            modalSelectBtn.textContent = selectedPaths.has(result.path) ? 'Deselect' : 'Select';
            modalSelectBtn.classList.toggle('primary', !selectedPaths.has(result.path));

            // Render metrics
            const metrics = [
              { label: 'Path', value: result.path },
              { label: 'Similarity', value: result.similarity ? (result.similarity * 100).toFixed(2) + '%' : '-' },
              { label: 'Dimensions', value: result.width && result.height ? result.width + ' × ' + result.height : '-' },
              { label: 'File Size', value: formatBytes(result.file_size) },
              { label: 'Format', value: result.format || '-' },
              { label: 'Brightness', value: result.brightness ? (result.brightness * 100).toFixed(1) + '%' : '-' },
              { label: 'Category', value: result.is_dark ? 'Dark' : 'Light' },
              { label: 'Modified', value: formatDate(result.modified_time) },
            ];

            metricsContainer.innerHTML = '';
            metrics.forEach(m => {
              const row = document.createElement('div');
              row.className = 'metric-row';
              row.innerHTML = '<div class="metric-label">' + m.label + '</div><div class="metric-value">' + escapeHtmlLocal(m.value) + '</div>';
              const copyBtn = createCopyButton(m.value);
              row.querySelector('.metric-value').appendChild(copyBtn);
              metricsContainer.appendChild(row);
            });

            // Always fetch workflow/prompt on-demand (detection may fail, API reads file directly)
            const cacheKey = result.path;
            
            // Check cache first
            if (metadataCache.has(cacheKey)) {
              const cached = metadataCache.get(cacheKey);
              renderWorkflowPrompt(promptsContainer, workflowContainer, apiContainer, cached.workflow, cached.prompt);
            } else {
              // Show loading state
              promptsContainer.innerHTML = '<div class="empty-state"><div>Loading prompts...</div></div>';
              workflowContainer.innerHTML = '<div class="empty-state"><div>Loading workflow...</div></div>';
              apiContainer.innerHTML = '<div class="empty-state"><div>Loading API data...</div></div>';
              
              // Fetch metadata via backend API (avoids CORS issues)
              fetchImageMetadata(result).then(metadata => {
                metadataCache.set(cacheKey, metadata);
                // Only update if still viewing same image
                if (currentModalIndex === index) {
                  renderWorkflowPrompt(promptsContainer, workflowContainer, apiContainer, metadata.workflow, metadata.prompt);
                }
              });
            }

            modal.style.display = 'flex';
          }

          function extractMultilineTexts(prompt) {
            const texts = [];
            if (!prompt || typeof prompt !== 'object') return texts;
            
            // Iterate through all nodes in the prompt
            for (const [nodeId, nodeData] of Object.entries(prompt)) {
              if (!nodeData || typeof nodeData !== 'object') continue;
              
              const inputs = nodeData.inputs;
              if (!inputs || typeof inputs !== 'object') continue;
              
              const classType = nodeData.class_type || 'Unknown';
              
              // Look for string values that appear to be multiline text prompts
              for (const [inputName, value] of Object.entries(inputs)) {
                if (typeof value === 'string' && value.length > 0) {
                  // Check if it looks like a prompt (multiline or contains common prompt keywords)
                  const isMultiline = value.includes('\\n') || value.length > 50;
                  const looksLikePrompt = /text|prompt|positive|negative|string|caption|description/i.test(inputName);
                  
                  if (isMultiline || looksLikePrompt) {
                    texts.push({
                      nodeId,
                      classType,
                      inputName,
                      value: value.replace(/\\n/g, '\\n')
                    });
                  }
                }
              }
            }
            
            return texts;
          }

          function renderWorkflowPrompt(promptsContainer, workflowContainer, apiContainer, workflow, prompt) {
            // Render Prompts tab - extract multiline text values
            const multilineTexts = extractMultilineTexts(prompt);
            if (multilineTexts.length > 0) {
              let html = '<div class="prompts-list">';
              multilineTexts.forEach((item, idx) => {
                const displayValue = escapeHtmlLocal(item.value);
                html += '<div class="prompt-item">' +
                  '<div class="prompt-header">' +
                    '<span class="prompt-source">' + escapeHtmlLocal(item.classType) + '</span>' +
                    '<span class="prompt-input-name">' + escapeHtmlLocal(item.inputName) + '</span>' +
                    '<button class="copy-btn prompt-copy-btn" data-idx="' + idx + '" title="Copy to clipboard">📋</button>' +
                  '</div>' +
                  '<pre class="prompt-text">' + displayValue + '</pre>' +
                '</div>';
              });
              html += '</div>';
              promptsContainer.innerHTML = html;
              
              // Attach copy handlers
              promptsContainer.querySelectorAll('.prompt-copy-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                  e.stopPropagation();
                  const idx = parseInt(btn.dataset.idx);
                  const text = multilineTexts[idx]?.value || '';
                  navigator.clipboard.writeText(text).then(() => {
                    btn.textContent = '✓';
                    btn.classList.add('copied');
                    setTimeout(() => {
                      btn.textContent = '📋';
                      btn.classList.remove('copied');
                    }, 1000);
                  });
                });
              });
            } else {
              promptsContainer.innerHTML = '<div class="empty-state"><div>No text prompts found</div></div>';
            }
            
            // Render Workflow tab - collapse nodes, links, groups, definitions by default
            if (workflow) {
              const workflowOptions = { collapseKeys: ['nodes', 'links', 'groups', 'definitions'] };
              workflowContainer.innerHTML = 
                '<div class="tab-copy-header">' +
                  '<span class="tab-copy-hint">Copy and paste into ComfyUI to load workflow</span>' +
                  '<button class="action-btn copy-workflow-btn" title="Copy workflow in ComfyUI clipboard format">📋 Copy Workflow</button>' +
                '</div>' +
                '<div class="json-tree">' + renderJsonTree(workflow, 0, workflowOptions) + '</div>';
              
              // Attach copy workflow handler
              workflowContainer.querySelector('.copy-workflow-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                const btn = e.target;
                // Copy as ComfyUI workflow clipboard format (just the workflow JSON)
                const workflowJson = JSON.stringify(workflow, null, 2);
                navigator.clipboard.writeText(workflowJson).then(() => {
                  btn.textContent = '✓ Copied!';
                  btn.classList.add('copied');
                  setTimeout(() => {
                    btn.textContent = '📋 Copy Workflow';
                    btn.classList.remove('copied');
                  }, 1500);
                });
              });
            } else {
              workflowContainer.innerHTML = '<div class="empty-state"><div>No workflow embedded</div></div>';
            }
            
            // Render API tab (formerly Prompt) - collapse all root level keys
            if (prompt) {
              const apiOptions = { collapseDepth: 0 };
              apiContainer.innerHTML = 
                '<div class="tab-copy-header">' +
                  '<span class="tab-copy-hint">API prompt format for ComfyUI API</span>' +
                  '<button class="action-btn copy-api-btn" title="Copy API prompt JSON">📋 Copy API</button>' +
                '</div>' +
                '<div class="json-tree">' + renderJsonTree(prompt, 0, apiOptions) + '</div>';
              
              // Attach copy API handler
              apiContainer.querySelector('.copy-api-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                const btn = e.target;
                const apiJson = JSON.stringify(prompt, null, 2);
                navigator.clipboard.writeText(apiJson).then(() => {
                  btn.textContent = '✓ Copied!';
                  btn.classList.add('copied');
                  setTimeout(() => {
                    btn.textContent = '📋 Copy API';
                    btn.classList.remove('copied');
                  }, 1500);
                });
              });
            } else {
              apiContainer.innerHTML = '<div class="empty-state"><div>No API data</div></div>';
            }
          }

          function closeModal() {
            modal.style.display = 'none';
            currentModalIndex = -1;
          }

          function navigateModal(delta) {
            const newIndex = currentModalIndex + delta;
            if (newIndex >= 0 && newIndex < filteredResults.length) {
              openModal(newIndex);
            }
          }

          function sendOutput() {
            // Get selected images or all filtered if none selected
            const imagesToSend = selectedPaths.size > 0 
              ? filteredResults.filter(r => selectedPaths.has(r.path))
              : filteredResults;

            // Send metadata: {type, subfolder, filename} for each image
            const selectedImages = imagesToSend.map(r => ({
              type: r.type || 'output',
              subfolder: r.subfolder || '',
              filename: r.filename
            }));

            const outputData = {
              selected: selectedImages,
              session_id: options.session_id
            };

            // Send to parent - handleMessage will update view_state
            window.parent.postMessage({
              type: 'image-search-output',
              action: 'output',
              data: outputData,
              nodeId: window.WAS_NODE_ID
            }, '*');

            console.log('[Image Search View] Sent', selectedImages.length, 'images to output');
          }

          // Event listeners
          sortSelect.addEventListener('change', (e) => {
            currentSort = e.target.value;
            renderGallery();
          });

          filterSelect.addEventListener('change', (e) => {
            currentFilter = e.target.value;
            renderGallery();
          });

          thumbSizeInput.addEventListener('input', (e) => {
            thumbSize = parseInt(e.target.value);
            renderGallery();
          });

          document.getElementById('select-all-btn').addEventListener('click', () => {
            filteredResults.forEach(r => selectedPaths.add(r.path));
            renderGallery();
            updateSelectedCount();
            sendOutput();
          });

          document.getElementById('clear-selection-btn').addEventListener('click', () => {
            selectedPaths.clear();
            renderGallery();
            updateSelectedCount();
            sendOutput();
          });

          document.getElementById('modal-close').addEventListener('click', closeModal);
          document.getElementById('modal-prev-btn').addEventListener('click', () => navigateModal(-1));
          document.getElementById('modal-next-btn').addEventListener('click', () => navigateModal(1));
          
          document.getElementById('modal-select-btn').addEventListener('click', () => {
            if (currentModalIndex >= 0 && currentModalIndex < filteredResults.length) {
              const path = filteredResults[currentModalIndex].path;
              const card = document.querySelector('.image-card[data-path="' + CSS.escape(path) + '"]');
              toggleSelection(path, card);
              const btn = document.getElementById('modal-select-btn');
              btn.textContent = selectedPaths.has(path) ? 'Deselect' : 'Select';
              btn.classList.toggle('primary', !selectedPaths.has(path));
            }
          });

          // Tab switching
          document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
              document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
              document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
              btn.classList.add('active');
              document.getElementById('tab-' + btn.dataset.tab).style.display = 'block';
            });
          });

          // Keyboard navigation
          document.addEventListener('keydown', (e) => {
            if (modal.style.display === 'flex') {
              if (e.key === 'Escape') closeModal();
              if (e.key === 'ArrowLeft') navigateModal(-1);
              if (e.key === 'ArrowRight') navigateModal(1);
              if (e.key === ' ') {
                e.preventDefault();
                document.getElementById('modal-select-btn').click();
              }
            }
          });

          // Close modal on backdrop click
          modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
          });

          // Initial render
          renderGallery();
        })();
      <\/script>
    `;
  }

  static getContentMarker() {
    return this.IMAGE_SEARCH_MARKER;
  }
}

export default ImageSearchView;
