// The interface: crosshair, hotbar, clock and weather line, the card for
// whatever creature the player is looking at, speech bubbles, and the panels
// (inventory, almanac, help, and those the simulations add). Plain DOM over the
// canvas; the game calls `update` once a frame.

import type { Game } from '../game';
import { HOTBAR, SLOTS } from '../player/inventory';
import type { InspectInfo } from '../sim/api';
import { REGIMES } from '../sim/weather';
import { ITEMS } from '../world/items';
import { Icons } from './icons';
import { ledgerPanel, tradePanel, wildlifePanel } from './panels';

export interface Panel {
  title: string;
  /** The panel's body as HTML. Called again a few times a second while it is open. */
  render(): string;
  /** A button with `data-act="name:arg"` was clicked. */
  act?(name: string, arg: string): void;
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const SCALES = [1, 5, 30, 120];

export class Hud {
  readonly icons: Icons;
  readonly panels = new Map<string, Panel>();
  /** Key codes that open panels. */
  readonly keys = new Map<string, string>();
  open: string | null = null;
  showDebug = false;

  private readonly game: Game;
  private readonly root: HTMLElement;
  private readonly el: Record<string, HTMLElement> = {};
  private readonly slots: HTMLElement[] = [];
  private inventoryVersion = -1;
  private selected = -1;
  private heldFade = 0;
  private refresh = 0;
  private picked = -1;
  private readonly bubbles: HTMLElement[] = [];

  constructor(root: HTMLElement, game: Game) {
    this.root = root;
    this.game = game;
    this.icons = new Icons(game.renderer.tileSet);
    const make = (cls: string, parent: HTMLElement = root): HTMLElement => {
      const d = document.createElement('div');
      d.className = cls;
      parent.appendChild(d);
      return d;
    };
    for (const name of ['crosshair', 'status', 'purse', 'hint', 'debug', 'prompt', 'held', 'inspector', 'layer', 'hotbar', 'panel']) this.el[name] = make(name);
    for (let i = 0; i < HOTBAR; i++) this.slots.push(make('slot', this.el.hotbar));
    (this.el.hint as HTMLElement).textContent = 'E pack · L ledger · K wildlife · T almanac · H help · F fly · [ ] time';
    (this.el.inspector as HTMLElement).style.display = 'none';
    (this.el.panel as HTMLElement).style.display = 'none';
    (this.el.panel as HTMLElement).addEventListener('click', (e) => this.click(e));

    this.addPanel('KeyE', 'pack', this.packPanel());
    this.addPanel('KeyT', 'almanac', this.almanacPanel());
    this.addPanel('KeyH', 'help', this.helpPanel());
    this.addPanel('KeyL', 'ledger', ledgerPanel(game, this.icons));
    this.addPanel('KeyK', 'wildlife', wildlifePanel(game));
    // No key for trade: it opens when the player right-clicks someone serving at a counter or stall.
    this.panels.set('trade', tradePanel(game, this.icons));
  }

  addPanel(key: string, name: string, panel: Panel): void {
    this.panels.set(name, panel);
    this.keys.set(key, name);
  }

  /** Open a panel by name, or close whatever is open with null. */
  show(name: string | null): void {
    if (this.open === 'trade' && name !== 'trade') this.game.trade?.end();
    this.open = name;
    this.picked = -1;
    const el = this.el.panel as HTMLElement;
    el.style.display = name ? '' : 'none';
    this.game.input.enabled = !name;
    if (name) {
      this.game.input.unlock();
      this.paint();
    }
  }

  private paint(): void {
    const p = this.open ? this.panels.get(this.open) : null;
    if (!p) return;
    (this.el.panel as HTMLElement).innerHTML = `<button class="close" data-act="close:">Close</button><h2>${esc(p.title)}</h2>${p.render()}`;
  }

  private click(e: MouseEvent): void {
    const target = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!target) return;
    const [name, arg = ''] = (target.dataset.act as string).split(':');
    if (name === 'close') return this.show(null);
    const p = this.open ? this.panels.get(this.open) : null;
    p?.act?.(name as string, arg);
    this.paint();
  }

  update(dt: number): void {
    const g = this.game;
    const input = g.input;
    // Keys: panels, debug readout, time.
    for (const [key, name] of this.keys) if (input.hit(key)) this.show(this.open === name ? null : name);
    if (input.hit('Escape') && this.open) this.show(null);
    if (input.hit('F3')) this.showDebug = !this.showDebug;
    if (input.hit('BracketRight')) g.timeScale = SCALES[Math.min(SCALES.length - 1, SCALES.indexOf(g.timeScale) + 1)] ?? 1;
    if (input.hit('BracketLeft')) g.timeScale = SCALES[Math.max(0, SCALES.indexOf(g.timeScale) - 1)] ?? 1;
    if (input.hit('KeyP')) g.paused = !g.paused;

    // Status lines.
    const w = g.weather;
    const sky = w.snowing ? 'Snow' : w.regime.charAt(0).toUpperCase() + w.regime.slice(1);
    const speed = g.paused ? ' · paused' : g.timeScale !== 1 ? ` · ${g.timeScale}x` : '';
    (this.el.status as HTMLElement).innerHTML = `<b>${esc(g.clock.format())}</b>${speed}<small>${sky} · ${w.temperature.toFixed(0)}°C · wind ${w.windSpeed.toFixed(0)} m/s</small>`;
    (this.el.purse as HTMLElement).textContent = `${g.inventory.coins} coins`;

    // Hotbar.
    const inv = g.inventory;
    if (inv.version !== this.inventoryVersion || inv.selected !== this.selected) {
      for (let i = 0; i < HOTBAR; i++) this.paintSlot(this.slots[i] as HTMLElement, i);
      if (inv.selected !== this.selected) this.heldFade = 2.2;
      this.inventoryVersion = inv.version;
      this.selected = inv.selected;
      const held = inv.held;
      (this.el.held as HTMLElement).textContent = held ? (ITEMS[held.item]?.label ?? '') : '';
      if (this.open === 'pack') this.paint();
    }
    this.heldFade = Math.max(0, this.heldFade - dt);
    (this.el.held as HTMLElement).style.opacity = this.heldFade > 0 ? '1' : '0';

    // Debug readout.
    const dbg = this.el.debug as HTMLElement;
    dbg.style.display = this.showDebug ? '' : 'none';
    if (this.showDebug) {
      const s = g.renderer.stats;
      const p = g.player;
      dbg.textContent =
        `${g.fps.toFixed(0)} fps · ${g.frameMs.toFixed(1)} ms script\n${s.width}x${s.height} · ${s.drawCalls} draws · ${(s.triangles / 1000).toFixed(0)}k tris\n` +
        `${s.visible}/${s.sections} sections · ${(s.meshBytes / 1048576).toFixed(0)} MB mesh\n` +
        `x ${p.x.toFixed(1)} y ${p.y.toFixed(1)} z ${p.z.toFixed(1)}\n${g.debugLines().join('\n')}`;
    }

    // Open panel: keep its figures current.
    this.refresh -= dt;
    if (this.open && this.refresh <= 0) {
      this.refresh = 0.5;
      if (this.open !== 'pack' && this.open !== 'help') this.paint();
    }

    this.paintInspector();
    this.paintBubbles();
    (this.el.crosshair as HTMLElement).style.display = this.open ? 'none' : '';
  }

  private paintSlot(el: HTMLElement, index: number): void {
    const stack = this.game.inventory.slots[index];
    el.style.backgroundImage = stack ? `url(${this.icons.url(stack.item)})` : '';
    el.innerHTML = stack && stack.count > 1 ? `<i>${stack.count}</i>` : '';
    el.title = stack ? (ITEMS[stack.item]?.label ?? '') : '';
    el.classList.toggle('selected', index === this.game.inventory.selected && index < HOTBAR);
  }

  // --- the creature under the crosshair, and what people are saying ---

  private paintInspector(): void {
    const g = this.game;
    const card = this.el.inspector as HTMLElement;
    const prompt = this.el.prompt as HTMLElement;
    const info: InspectInfo | null = g.focus ? g.inspect(g.focus.id) : null;
    if (!info || this.open) {
      card.style.display = 'none';
      prompt.textContent = '';
      return;
    }
    card.style.display = '';
    card.innerHTML =
      `<h3>${esc(info.title)}</h3><em>${esc(info.subtitle)}</em>` +
      info.lines.map((l) => `<p>${esc(l)}</p>`).join('') +
      info.bars.map((b) => `<div class="bar">${esc(b.label)}<span><b style="width:${Math.round(Math.min(1, Math.max(0, b.value)) * 100)}%"></b></span></div>`).join('');
    prompt.textContent = g.focusPrompt();
  }

  private paintBubbles(): void {
    const g = this.game;
    const layer = this.el.layer as HTMLElement;
    const said = g.speech();
    while (this.bubbles.length < said.length) {
      const d = document.createElement('div');
      layer.appendChild(d);
      this.bubbles.push(d);
    }
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    this.bubbles.forEach((d, i) => {
      const s = said[i];
      const at = s ? g.project(s.x, s.y, s.z) : null;
      if (!s || !at || this.open) {
        d.style.display = 'none';
        return;
      }
      d.style.display = '';
      d.className = s.kind;
      d.textContent = s.text;
      d.style.left = `${at.x * w}px`;
      d.style.top = `${at.y * h}px`;
      d.style.opacity = String(Math.min(1, Math.max(0.25, 1.4 - at.depth / 18)));
    });
  }

  // --- built-in panels ---

  private packPanel(): Panel {
    return {
      title: 'Pack',
      render: () => {
        const inv = this.game.inventory;
        let cells = '';
        for (let i = 0; i < SLOTS; i++) {
          const s = inv.slots[i];
          const style = s ? `style="background-image:url(${this.icons.url(s.item)})"` : '';
          const cls = `slot${i === this.picked ? ' picked' : ''}${i === inv.selected ? ' selected' : ''}`;
          cells += `<div class="${cls}" data-act="slot:${i}" ${style} title="${s ? esc(ITEMS[s.item]?.label ?? '') : ''}">${s && s.count > 1 ? `<i>${s.count}</i>` : ''}</div>`;
        }
        return `<p class="sub">${inv.coins} coins. Click one slot, then another, to swap them. The top row is your belt (keys 1 to 9).</p><div class="grid">${cells}</div>`;
      },
      act: (name, arg) => {
        if (name !== 'slot') return;
        const i = Number(arg);
        if (this.picked < 0) this.picked = i;
        else {
          this.game.inventory.swap(this.picked, i);
          this.picked = -1;
        }
      },
    };
  }

  private almanacPanel(): Panel {
    return {
      title: 'Almanac',
      render: () => {
        const g = this.game;
        const w = g.weather;
        const b = (act: string, label: string, on = false): string => `<button data-act="${act}"${on ? ' class="on"' : ''}>${label}</button>`;
        return (
          `<p class="sub">${esc(g.clock.format())}, year ${g.clock.year}. ${w.temperature.toFixed(1)}°C, cloud ${(w.cloudCover * 100).toFixed(0)}%, ` +
          `rain ${(w.precipitation * 100).toFixed(0)}%, ground ${(w.wetness * 100).toFixed(0)}% wet, snow ${(w.snowCover * 100).toFixed(0)}%.</p>` +
          `<h4>Pace of time</h4><div class="row">${SCALES.map((s) => b(`scale:${s}`, `${s}x`, g.timeScale === s && !g.paused)).join('')}${b('pause:', 'Pause', g.paused)}</div>` +
          `<h4>Turn the clock to</h4><div class="row">${b('hour:5.5', 'Dawn')}${b('hour:9', 'Morning')}${b('hour:12', 'Noon')}${b('hour:17.5', 'Evening')}${b('hour:19', 'Dusk')}${b('hour:0', 'Midnight')}${b('day:1', 'Next day')}${b('day:7', 'Next season')}</div>` +
          `<h4>Weather</h4><div class="row">${REGIMES.map((r) => b(`weather:${r}`, r, g.forcedWeather === r)).join('')}${b('weather:', 'as it comes', g.forcedWeather === null)}</div>`
        );
      },
      act: (name, arg) => {
        const g = this.game;
        if (name === 'scale') { g.timeScale = Number(arg); g.paused = false; }
        else if (name === 'pause') g.paused = !g.paused;
        else if (name === 'hour') g.setHour(Number(arg));
        else if (name === 'day') g.clock.time += Number(arg) * 1440;
        else if (name === 'weather') g.setWeather(arg ? (arg as (typeof REGIMES)[number]) : null);
      },
    };
  }

  private helpPanel(): Panel {
    const k = (key: string, what: string): string => `<tr><td><kbd>${key}</kbd></td><td>${what}</td></tr>`;
    return {
      title: 'Tidewick',
      render: () =>
        '<p class="sub">An island, a village that keeps its own hours, and the woods and waters around it. Click the view to take the mouse.</p><table>' +
        k('W A S D', 'walk; hold <kbd>Shift</kbd> to run') + k('Space', 'jump; swim upward') + k('F', 'fly, or land') +
        k('Left mouse', 'break the block you are aiming at (hold)') + k('Right mouse', 'place the held block; open doors and gates; talk and trade') +
        k('1 to 9, wheel', 'choose from your belt') + k('E', 'your pack') + k('L', 'the village ledger: prices, stores, people') +
        k('K', 'wildlife: numbers of each kind over time') + k('T', 'almanac: pace of time, time of day, weather') +
        k('[ and ]', 'slow down or speed up time') + k('P', 'pause the world') + k('F3', 'frame and position readout') + k('Esc', 'close a panel, release the mouse') +
        '</table>',
    };
  }
}
