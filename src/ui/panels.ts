// The panels the simulations fill: the village ledger, the wildlife census and
// the trade window. Each is plain data from a simulation turned into a table;
// nothing here changes the world except through `Trade`.

import type { GameHost } from './host';
import { ITEMS, item } from '../world/items';
import type { Panel } from './hud';
import type { Icons } from './icons';

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

/** A small line chart of a series, scaled to its own range (or from zero), as inline SVG. */
function spark(series: readonly number[], w = 96, h = 20, fromZero = false, color = '#6b5132'): string {
  if (series.length < 2) return `<svg width="${w}" height="${h}"></svg>`;
  let lo = fromZero ? 0 : Math.min(...series);
  let hi = Math.max(...series);
  if (hi - lo < 1e-6) {
    lo -= 1;
    hi += 1;
  }
  const pts = series.map((v, i) => `${((i / (series.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 2 - ((v - lo) / (hi - lo)) * (h - 4)).toFixed(1)}`).join(' ');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.4"/></svg>`;
}

const icon = (icons: Icons, itemId: number): string => `<span class="icon" style="background-image:url(${icons.url(itemId)})"></span>`;
const money = (v: number): string => (v >= 10 ? v.toFixed(0) : v.toFixed(1));

/** L: what the village has, what it costs, and where the coin is. */
export function ledgerPanel(game: GameHost, icons: Icons): Panel {
  return {
    title: 'Village ledger',
    render: () => {
      const village = game.life.village;
      if (!village) return '<p class="sub">This island has no village.</p>';
      const l = village.ledger();
      const s = village.stats;
      const trades = new Map<string, number>();
      let children = 0;
      for (const p of village.people) {
        if (p.kind === 'child') children++;
        else {
          const trade = village.professions[p.role] ?? 'villager';
          trades.set(trade, (trades.get(trade) ?? 0) + 1);
        }
      }
      const people = [...trades].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} ${t}${n > 1 ? 's' : ''}`).join(', ');
      const rows = l.goods.map((g) => {
        const h = g.history;
        const was = h.length > 1 ? (h[h.length - 2] as number) : g.price;
        const trend = g.price > was * 1.02 ? '▲' : g.price < was * 0.98 ? '▼' : '';
        return `<tr><td>${icon(icons, item(g.good).id)}${esc(item(g.good).label)}</td><td class="num">${money(g.price)} ${trend}</td><td>${spark(h)}</td>` +
          `<td class="num">${g.stock}</td><td class="num">${g.producedToday || ''}</td><td class="num">${g.consumedToday || ''}</td></tr>`;
      }).join('');
      return (
        `<p class="sub">${esc(game.plan?.name ?? 'The village')}, day ${l.day + 1}. ${l.population} people: ${children} children, ${esc(people)}.</p>` +
        `<p class="sub">${l.coin} coins in the village: ${l.purses} in purses, ${l.tills} in tills, ${l.treasury} in the common chest. ` +
        `Last evening's pay came to ${l.payroll} coins, and each adult had ${l.dividend} from the chest.` +
        (l.playerNet > 0 ? ` Your custom has brought in ${l.playerNet} coins more than it has taken out.` : l.playerNet < 0 ? ` You have taken ${-l.playerNet} coins more out of the village than you have spent in it.` : '') +
        '</p>' +
        `<table><tr><th>Good</th><th class="num">Price</th><th>Last days</th><th class="num">In store</th><th class="num">Made today</th><th class="num">Used today</th></tr>${rows}</table>` +
        `<h4>Since the start</h4><p class="sub">${s.meals} meals eaten (${s.almsMeals} given free), ${s.breadBaked} loaves baked, ${s.cellsHarvested} plots reaped, ` +
        `${s.treesFelled} trees felled and ${s.saplingsPlanted} planted, ${s.fishCaught} fish landed, ${s.animalsHunted} animals hunted, ` +
        `${s.eggsLaid} eggs, ${s.woolShorn} fleeces, ${s.livestockBorn} farm animals born and ${s.livestockLost} lost.</p>`
      );
    },
  };
}

const plural = (kind: string): string => (kind === 'deer' || kind === 'fish' || kind === 'sheep' ? kind : kind === 'wolf' ? 'wolves' : kind === 'fox' ? 'foxes' : `${kind}s`);

/** K: how many of each wild creature there are, how they have fared, and how the plants are doing. */
export function wildlifePanel(game: GameHost): Panel {
  return {
    title: 'Wildlife',
    render: () => {
      const eco = game.life.eco;
      const history = eco.history();
      const rows = eco.census().map((r) => {
        const series = history[r.kind] ?? [];
        const away = r.away > 0 ? ` <small>(${r.away} away for the winter)</small>` : '';
        return `<tr><td>${esc(plural(r.kind))}${away}</td><td class="num">${r.count}</td><td class="num">${r.cap}</td><td>${spark(series, 120, 22, true, '#3f6b3a')}</td>` +
          `<td class="num">${r.births || ''}</td><td class="num">${r.oldAge || ''}</td><td class="num">${r.starved || ''}</td><td class="num">${r.killed || ''}</td>` +
          `<td class="num">${r.hunted || ''}</td><td class="num">${r.arrived || ''}</td></tr>`;
      }).join('');
      const p = eco.plants();
      const farm = new Map<string, number>();
      for (const v of game.life.village?.views ?? []) if (v.kind !== 'villager' && v.kind !== 'child') farm.set(v.kind, (farm.get(v.kind) ?? 0) + 1);
      const herd = [...farm].map(([k, n]) => `${n} ${n === 1 ? k : plural(k)}`).join(', ');
      return (
        `<p class="sub">Each curve is that kind's numbers day by day, drawn from none up to its peak. The limit is what the island can carry: breeding stops there.</p>` +
        `<table><tr><th>Kind</th><th class="num">Now</th><th class="num">Limit</th><th>Day by day</th><th class="num">Born</th><th class="num">Old age</th>` +
        `<th class="num">Starved</th><th class="num">Killed</th><th class="num">Hunted</th><th class="num">Arrived</th></tr>${rows}</table>` +
        `<h4>Plants</h4><p class="sub">Open grass is ${(p.cover * 100).toFixed(0)}% covered: about ${p.tallGrass} tufts of tall grass and ${p.flowers} flowers. ` +
        `${p.berryBushes} berry bushes (${p.ripeBushes} ripe), ${p.mushrooms} mushrooms, ${p.saplings} saplings coming up.</p>` +
        (herd ? `<h4>On the farms</h4><p class="sub">${esc(herd)}.</p>` : '')
      );
    },
  };
}

/** The trade window, opened by right-clicking a villager at a counter or stall. */
export function tradePanel(game: GameHost, icons: Icons): Panel {
  const buttons = (act: string, good: string, enabled: (n: number) => boolean): string =>
    [1, 5, 20].map((n) => `<button data-act="${act}:${good}*${n}"${enabled(n) ? '' : ' disabled'}>${n}</button>`).join('');
  return {
    title: 'Trade',
    render: () => {
      const trade = game.trade;
      const village = game.life.village;
      if (!trade || !village) return '<p class="sub">There is nobody here to trade with.</p>';
      const who = village.inspect(trade.partner);
      const coins = game.inventory.coins;
      const rows = trade.offers().filter((o) => o.buy !== null || (o.have > 0 && o.sell !== null)).map((o) => {
        const buy = o.buy === null ? '<td class="num"></td><td></td>'
          : `<td class="num">${o.buy}</td><td>${buttons('buy', o.good, (n) => { const q = village.quoteBuy(o.good, n); return q !== null && q <= coins; })}</td>`;
        const sell = o.sell === null || o.have === 0 ? '<td class="num"></td><td></td>'
          : `<td class="num">${o.sell}</td><td>${buttons('sell', o.good, (n) => o.have >= n && village.quoteSell(o.good, n) !== null)}</td>`;
        return `<tr><td>${icon(icons, o.item)}${esc(o.label)}</td><td class="num">${o.have || ''}</td>${buy}${sell}</tr>`;
      }).join('');
      const closed = trade.open ? '' : '<p class="sub"><b>The seller has left the counter.</b> Come back when someone is serving.</p>';
      // The outcome of the last click sits above the table, where it is seen without scrolling.
      return (
        `<p class="sub">${who ? `${esc(who.title)}, ${esc(who.subtitle)}. ` : ''}You have ${coins} coins. Prices are for one; a larger lot costs more each, and sells for less.</p>` +
        closed +
        `<p class="sub note">${trade.note ? esc(trade.note) : '&nbsp;'}</p>` +
        `<table><tr><th>Good</th><th class="num">You have</th><th class="num">Buy for</th><th>Buy</th><th class="num">Sells for</th><th>Sell</th></tr>${rows}</table>`
      );
    },
    act: (name, arg) => {
      const trade = game.trade;
      if (!trade) return;
      const [good = '', count = '1'] = arg.split('*');
      const n = Number(count);
      if (!ITEMS.some((i) => i.name === good) || !Number.isInteger(n)) return;
      if (name === 'buy') trade.buy(good, n);
      else if (name === 'sell') trade.sell(good, n);
    },
  };
}
