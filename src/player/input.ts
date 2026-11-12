// Keyboard and mouse state. Mouse look uses pointer lock when the player has
// clicked into the game; without it, dragging with the left button looks
// around, which is also how automated checks steer the camera.

/** Keys the game uses that a browser would act on itself while the mouse is captured: scrolling and moving focus. */
const CAPTURED_KEYS = new Set(['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

export class Input {
  private readonly keys = new Set<string>();
  private readonly pressed = new Set<string>();
  private readonly canvas: HTMLCanvasElement;
  private dragging = false;
  /** The browser would not give the mouse up, so the left button has to work without it. */
  private lockRefused = false;
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
      // F3 is the game's own readout; left alone, some browsers open their find bar on it as well.
      if (e.code === 'F3' || (this.locked && CAPTURED_KEYS.has(e.code))) e.preventDefault();
    });
    document.addEventListener('pointerlockerror', () => {
      this.lockRefused = true;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.buttons.clear();
      this.dragging = false;
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (!this.locked && e.button === 0) {
        this.dragging = true;
        // The press that asks for the mouse, or that drags the view round, is not also a blow at whatever is
        // under the crosshair: a plant there broke in a twentieth of a second.
        if (!this.lockRefused) return;
      }
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
    if (this.locked) return;
    void this.canvas.requestPointerLock()?.catch?.(() => {
      this.lockRefused = true;
    });
  }

  unlock(): void {
    if (this.locked) document.exitPointerLock();
  }

  /** True while a key is held; always false while a panel has the keyboard. */
  down(code: string): boolean {
    return this.enabled && this.keys.has(code);
  }

  /**
   * True once for each physical key press. Like `down`, false while a panel
   * has the keyboard, unless `always`: the interface's own keys (the ones that
   * open and close panels) work whatever is open.
   */
  hit(code: string, always = false): boolean {
    return (always || this.enabled) && this.pressed.has(code);
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
