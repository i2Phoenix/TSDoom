// ============================================================
// Game Loop
// Reference: d_main.c — D_DoomLoop
// ============================================================

const TICRATE = 35; // 35 tics per second
const TICTIME = 1000 / TICRATE; // ms per tic

export class GameLoop {
  private tickFn: () => void;
  private drawFn: () => void;
  private lastTime = 0;
  private accumulator = 0;
  private running = false;
  private frameCount = 0;
  private fpsTime = 0;
  fps = 0;

  constructor(tick: () => void, draw: () => void) {
    this.tickFn = tick;
    this.drawFn = draw;
  }

  start(): void {
    this.running = true;
    this.lastTime = performance.now();
    this.fpsTime = this.lastTime;
    this.loop(this.lastTime);
  }

  stop(): void {
    this.running = false;
  }

  private loop = (time: number): void => {
    if (!this.running) return;

    const dt = time - this.lastTime;
    this.lastTime = time;

    // Prevent spiral of death
    this.accumulator += Math.min(dt, TICTIME * 5);

    // Process game tics
    while (this.accumulator >= TICTIME) {
      this.tickFn();
      this.accumulator -= TICTIME;
    }

    // Draw
    this.drawFn();

    // FPS counter
    this.frameCount++;
    if (time - this.fpsTime >= 1000) {
      this.fps = this.frameCount;
      this.frameCount = 0;
      this.fpsTime = time;
    }

    requestAnimationFrame(this.loop);
  };
}
