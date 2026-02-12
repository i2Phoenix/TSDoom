// ============================================================
// WebGPU Renderer — Stub (placeholder for future GPU implementation)
// Currently no-ops like HeadlessRenderer.
// ============================================================

import { HeadlessRenderer } from '../../../game/headless-renderer';

export class WebGPURenderer extends HeadlessRenderer {
  getRenderMode(): string {
    return 'webgpu-stub';
  }
}
