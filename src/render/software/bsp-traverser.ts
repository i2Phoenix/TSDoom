// ============================================================
// BSPTraverser — BSP Tree Walk & Seg Clipping
// Extracted from renderer.ts (R_RenderBSPNode, R_AddLine,
// R_ClipSolidWallSegment, R_ClipPassWallSegment)
// ============================================================

import {
  FRACBITS, ANG90, ANG180, ANGLETOFINESHIFT, FINEANGLES,
  pointToAngle,
} from '../../../game/math';
import { NF_SUBSECTOR, type Seg } from '../../map';
import type { RenderContext, ClipRange } from './render-context';

// ---- SegCollector interface ----

/**
 * Callback interface for BSP traversal results.
 * The BSP traverser calls these methods instead of directly rendering.
 */
export interface SegCollector {
  /** Called for each visible seg range after clipping. */
  storeWallRange(start: number, stop: number, seg: Seg, ctx: RenderContext): void;
  /** Called for each visible subsector (to project sprites). */
  visitSubsector(ssIdx: number, ctx: RenderContext): void;
}

// ---- DOOM's checkcoord lookup table ----

const checkcoord: number[][] = [
  [3,0,2,1],  // boxpos 0: viewer is left-top
  [3,0,2,0],  // boxpos 1: viewer is center-top
  [3,1,2,0],  // boxpos 2: viewer is right-top
  [0],         // boxpos 3: unused
  [2,0,2,1],  // boxpos 4: viewer is left-center
  [0,0,0,0],  // boxpos 5: viewer is INSIDE
  [3,1,3,0],  // boxpos 6: viewer is right-center
  [0],         // boxpos 7: unused
  [2,0,3,1],  // boxpos 8: viewer is left-bottom
  [2,1,3,1],  // boxpos 9: viewer is center-bottom
  [2,1,3,0],  // boxpos 10: viewer is right-bottom
];

/**
 * Walks the BSP tree front-to-back, clips segs against solid walls,
 * and delegates visible seg ranges to a SegCollector.
 */
export class BSPTraverser {
  private ctx!: RenderContext;
  private collector!: SegCollector;

  /**
   * Traverse the entire BSP for the current view.
   * Calls collector.storeWallRange for each visible seg range and
   * collector.visitSubsector for each visible subsector.
   */
  traverse(ctx: RenderContext, collector: SegCollector): void {
    this.ctx = ctx;
    this.collector = collector;
    this.walkNode(ctx.map.nodes.length - 1);
  }

  private walkNode(nodeIdx: number): void {
    const ctx = this.ctx;
    if (nodeIdx & NF_SUBSECTOR) {
      const ssIdx = nodeIdx === 0xFFFF ? 0 : nodeIdx & ~NF_SUBSECTOR;
      if (ssIdx < ctx.map.subsectors.length) {
        this.visitSubsector(ssIdx);
      }
      return;
    }
    if (nodeIdx >= ctx.map.nodes.length) return;

    const node = ctx.map.nodes[nodeIdx];
    const side = ctx.map.pointOnSide(ctx.viewx, ctx.viewy, node);

    this.walkNode(node.children[side]);

    if (this.checkBBox(node.bbox[side ^ 1])) {
      this.walkNode(node.children[side ^ 1]);
    }
  }

  private visitSubsector(ssIdx: number): void {
    const ctx = this.ctx;
    const ss = ctx.map.subsectors[ssIdx];
    if (!ss.sector) return;
    ctx.debugCounters.subsectors++;

    // Project sprites BEFORE segs (same as original DOOM R_Subsector)
    this.collector.visitSubsector(ssIdx, ctx);

    for (let i = 0; i < ss.numSegs; i++) {
      const segIdx = ss.firstSeg + i;
      if (segIdx < ctx.map.segs.length) {
        this.addLine(ctx.map.segs[segIdx]);
      }
    }
  }

  private addLine(seg: Seg): void {
    const ctx = this.ctx;
    ctx.debugCounters.addLineCalls++;

    let angle1 = this.viewAngleTo(seg.v1.x, seg.v1.y);
    let angle2 = this.viewAngleTo(seg.v2.x, seg.v2.y);

    const span = (angle1 - angle2) >>> 0;
    if (span >= ANG180) { ctx.debugCounters.backFaceCulled++; return; }

    ctx.rwAngle1 = angle1;

    angle1 = (angle1 - ctx.viewangle) >>> 0;
    angle2 = (angle2 - ctx.viewangle) >>> 0;

    let tspan = (angle1 + ctx.clipangle) >>> 0;
    if (tspan > (2 * ctx.clipangle) >>> 0) {
      tspan = (tspan - (2 * ctx.clipangle)) >>> 0;
      if (tspan >= span) return;
      angle1 = ctx.clipangle;
    }

    tspan = (ctx.clipangle - angle2) >>> 0;
    if (tspan > (2 * ctx.clipangle) >>> 0) {
      tspan = (tspan - (2 * ctx.clipangle)) >>> 0;
      if (tspan >= span) return;
      angle2 = ((-ctx.clipangle) >>> 0);
    }

    const x1 = this.angleToX(angle1);
    const x2 = this.angleToX(angle2);
    if (x1 === x2) { ctx.debugCounters.x1GreaterX2++; return; }

    const backsector = seg.backsector;
    if (!backsector) {
      this.clipSolidWall(x1, x2 - 1, seg);
    } else {
      if (backsector.ceilingHeight <= seg.frontsector.floorHeight ||
          backsector.floorHeight >= seg.frontsector.ceilingHeight) {
        this.clipSolidWall(x1, x2 - 1, seg);
      } else if (backsector.ceilingHeight !== seg.frontsector.ceilingHeight ||
                 backsector.floorHeight !== seg.frontsector.floorHeight) {
        this.clipPassWall(x1, x2 - 1, seg);
      } else {
        if (backsector.floorPic === seg.frontsector.floorPic &&
            backsector.ceilingPic === seg.frontsector.ceilingPic &&
            backsector.lightLevel === seg.frontsector.lightLevel &&
            seg.sidedef.midTexture === 0) {
          return;
        }
        this.clipPassWall(x1, x2 - 1, seg);
      }
    }
  }

  // ---- Clipping ----

  private clipSolidWall(x1: number, x2: number, seg: Seg): void {
    const ss = this.ctx.solidsegs;
    let i = 0;
    while (ss[i].last < x1 - 1) i++;

    if (x1 < ss[i].first) {
      if (x2 < ss[i].first - 1) {
        this.collector.storeWallRange(x1, x2, seg, this.ctx);
        ss.splice(i, 0, { first: x1, last: x2 });
        return;
      }
      this.collector.storeWallRange(x1, ss[i].first - 1, seg, this.ctx);
      ss[i].first = x1;
    }

    if (x2 <= ss[i].last) return;

    let j = i;
    while (x2 >= ss[j + 1].first - 1) {
      this.collector.storeWallRange(ss[j].last + 1, Math.min(ss[j + 1].first - 1, x2), seg, this.ctx);
      j++;
      if (x2 <= ss[j].last) {
        ss[i].last = ss[j].last;
        if (j !== i) ss.splice(i + 1, j - i);
        return;
      }
    }
    this.collector.storeWallRange(ss[j].last + 1, x2, seg, this.ctx);
    ss[i].last = x2;
    if (j !== i) ss.splice(i + 1, j - i);
  }

  private clipPassWall(x1: number, x2: number, seg: Seg): void {
    const ss = this.ctx.solidsegs;
    let i = 0;
    while (ss[i].last < x1 - 1) i++;

    if (x1 < ss[i].first) {
      if (x2 < ss[i].first - 1) {
        this.collector.storeWallRange(x1, x2, seg, this.ctx);
        return;
      }
      this.collector.storeWallRange(x1, ss[i].first - 1, seg, this.ctx);
    }

    if (x2 <= ss[i].last) return;

    while (x2 >= ss[i + 1].first - 1) {
      this.collector.storeWallRange(ss[i].last + 1, Math.min(ss[i + 1].first - 1, x2), seg, this.ctx);
      i++;
      if (x2 <= ss[i].last) return;
    }
    this.collector.storeWallRange(ss[i].last + 1, x2, seg, this.ctx);
  }

  // ---- Helpers ----

  private viewAngleTo(x: number, y: number): number {
    return pointToAngle(this.ctx.viewx, this.ctx.viewy, x, y);
  }

  private angleToX(ang: number): number {
    const fineIdx = ((ang + ANG90) >>> ANGLETOFINESHIFT) & (FINEANGLES / 2 - 1);
    return this.ctx.viewangletox[fineIdx];
  }

  private checkBBox(bbox: [number, number, number, number]): boolean {
    const ctx = this.ctx;
    let boxx: number;
    if (ctx.viewx <= bbox[2]) {
      boxx = 0;
    } else if (ctx.viewx < bbox[3]) {
      boxx = 1;
    } else {
      boxx = 2;
    }

    let boxy: number;
    if (ctx.viewy >= bbox[0]) {
      boxy = 0;
    } else if (ctx.viewy > bbox[1]) {
      boxy = 1;
    } else {
      boxy = 2;
    }

    const boxpos = (boxy << 2) + boxx;
    if (boxpos === 5) return true;

    const cc = checkcoord[boxpos];
    const x1 = bbox[cc[0]];
    const y1 = bbox[cc[1]];
    const x2 = bbox[cc[2]];
    const y2 = bbox[cc[3]];

    let angle1 = (pointToAngle(ctx.viewx, ctx.viewy, x1, y1) - ctx.viewangle) >>> 0;
    let angle2 = (pointToAngle(ctx.viewx, ctx.viewy, x2, y2) - ctx.viewangle) >>> 0;

    const span = (angle1 - angle2) >>> 0;
    if (span >= ANG180) return true;

    let tspan = (angle1 + ctx.clipangle) >>> 0;
    if (tspan > (2 * ctx.clipangle) >>> 0) {
      tspan = (tspan - (2 * ctx.clipangle)) >>> 0;
      if (tspan >= span) return false;
      angle1 = ctx.clipangle;
    }

    tspan = (ctx.clipangle - angle2) >>> 0;
    if (tspan > (2 * ctx.clipangle) >>> 0) {
      tspan = (tspan - (2 * ctx.clipangle)) >>> 0;
      if (tspan >= span) return false;
      angle2 = ((-ctx.clipangle) >>> 0);
    }

    const sx1 = ctx.viewangletox[((angle1 + ANG90) >>> ANGLETOFINESHIFT) & (FINEANGLES / 2 - 1)];
    const sx2 = ctx.viewangletox[((angle2 + ANG90) >>> ANGLETOFINESHIFT) & (FINEANGLES / 2 - 1)];

    if (sx1 === sx2) return false;

    let i2 = 0;
    while (ctx.solidsegs[i2].last < sx2 - 1) i2++;

    if (sx1 >= ctx.solidsegs[i2].first && sx2 - 1 <= ctx.solidsegs[i2].last) {
      return false;
    }

    return true;
  }
}
