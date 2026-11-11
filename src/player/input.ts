// Keyboard and mouse state. Mouse look uses pointer lock when the player has
// clicked into the game; without it, dragging with the left button looks
// around, which is also how automated checks steer the camera.

export class Input {
  private readonly keys = new Set<string>();
  private readonly pressed = new Set<string>();
  private readonly canvas: HTMLCanvasElement;
  private dragging = false;
  /** Mouse movement since the last `consumeLook`, in pixels. */
  private lookX = 0;
  private lookY = 0;
  private wheel = 0;
  /** Buttons currently held: 0 left, 2 right. */
  readonly buttons = new Set<number>();
  private readonly clicked = new Set<number>();
  /** False while a UI panel has the mouse; the game then ignores look and clicks. */
  enabled = true;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
      if (this.locked && ['Space', 'Tab', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.buttons.clear();
      this.dragging = false;
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (!this.locked && e.button === 0) this.dragging = true;
      this.buttons.add(e.button);
      this.clicked.add(e.button);
    });
    window.addEventListener('mouseup', (e) => {
      this.buttons.delete(e.button);
      if (e.button === 0) this.dragging = false;
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      if (this.locked || this.dragging) {
        this.lookX += e.movementX;
        this.lookY += e.movementY;
      }
    });
    canvas.addEventListener('wheel', (e) => {
      this.wheel += Math.sign(e.deltaY);
      e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  /** Ask the browser to capture the mouse. Must be called from a click handler. */
  lock(): void {
    if (!this.locked) void this.canvas.requestPointerLock()?.catch?.(() => undefined);
  }

  unlock(): void {
    if (this.locked) document.exitPointerLock();
  }

  down(code: string): boolean {
    return this.keys.has(code);
  }

  /** True once for each physical key press. */
  hit(code: string): boolean {
    return this.pressed.has(code);
  }

  /** True once for each mouse button press. */
  click(button: number): boolean {
    return this.clicked.has(button);
  }

  consumeLook(): { x: number; y: number } {
    const out = { x: this.lookX, y: this.lookY };
    this.lookX = 0;
    this.lookY = 0;
    return out;
  }

  consumeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  /** Call at the end of each frame: one-shot presses are then forgotten. */
  endFrame(): void {
    this.pressed.clear();
    this.clicked.clear();
  }
}
