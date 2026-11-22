// Sokoban solver: room-decomposition push-optimal search.
//
// Design (written from the competition description, no reference code used):
// Every level is a 1-wide hallway (the row the player starts in) with 1-4
// rooms hanging off it, each room holding 3-4 boxes and as many goals and
// opening onto the hallway through a single door. A box pushed out of its
// room can never come back, so the push-optimal count of a level is the sum
// of its rooms' optima, and each room can be solved on its own with the
// player starting at its door. This program therefore:
//   1. splits the level into the hallway row and one connected room per
//      component of the remaining floor,
//   2. solves each room with push-optimal A* (state = sorted box cells +
//      player cell; cost = pushes; heuristic = cheapest assignment of boxes
//      to goals over box-movement distances; pruned by dead squares and by
//      2x2 freeze deadlocks),
//   3. stitches the rooms together with shortest walks along the hallway,
//      expanding every push into the player's walk to the pushing stance.
// The search budget is counted in node expansions, never in wall time, so
// two runs write the same bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const CH = ['u', 'd', 'l', 'r'];
const OPP = [1, 0, 3, 2];

// Hard cap on A* expansions per room, counted deterministically. Rooms in
// this competition are at most 6x6 with 4 boxes, so a correct search should
// finish far below this; the cap only guards the 60 s wall budget.
const MAX_EXPAND = 1500000;

const idx = (x: number, y: number, w: number): number => y * w + x;
const cx = (c: number, w: number): number => c % w;
const cy = (c: number, w: number): number => Math.floor(c / w);

interface Level {
  w: number;
  h: number;
  wall: boolean[];
  goals: number[];
  goalSet: Set<number>;
  boxes: number[];
  player: number;
  hallwayY: number;
}

function parseLevel(text: string): Level {
  const rows = text.replace(/\r/g, '').split('\n');
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  const h = rows.length;
  let w = 0;
  for (const r of rows) w = Math.max(w, r.length);
  const wall: boolean[] = new Array(w * h).fill(true);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = x < rows[y].length ? rows[y][x] : '#';
      const c = idx(x, y, w);
      if (ch === '#') continue;
      wall[c] = false;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(c);
      if (ch === '$' || ch === '*') boxes.push(c);
      if (ch === '@' || ch === '+') player = c;
    }
  }
  boxes.sort((a, b) => a - b);
  return {
    w, h, wall, goals, goalSet: new Set(goals), boxes,
    player, hallwayY: cy(player, w),
  };
}

// Shortest player walk from `from` to `to` over cells where `open(c)` is
// true, avoiding the cells in `blocked`. Fixed neighbour order, so the
// result is deterministic. Returns the move string, or null.
function bfsWalk(
  from: number, to: number, open: (c: number) => boolean,
  blocked: Set<number>, w: number,
): string | null {
  if (from === to) return '';
  const prev = new Map<number, number>();
  const prevDir = new Map<number, number>();
  const q: number[] = [from];
  prev.set(from, -1);
  let qi = 0;
  while (qi < q.length) {
    const c = q[qi++];
    const x = cx(c, w);
    const y = cy(c, w);
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0) continue;
      const n = idx(nx, ny, w);
      if (prev.has(n) || blocked.has(n) || !open(n)) continue;
      prev.set(n, c);
      prevDir.set(n, d);
      if (n === to) {
        let s = '';
        let cur = n;
        while (cur !== from) {
          s = CH[prevDir.get(cur)!] + s;
          cur = prev.get(cur)!;
        }
        return s;
      }
      q.push(n);
    }
  }
  return null;
}

// Reachable set of cells for the player from `from`, over `open` cells,
// avoiding `blocked` cells.
function reachable(
  from: number, open: (c: number) => boolean,
  blocked: Set<number>, w: number, h: number,
): Set<number> {
  const seen = new Set<number>([from]);
  const q: number[] = [from];
  let qi = 0;
  while (qi < q.length) {
    const c = q[qi++];
    const x = cx(c, w);
    const y = cy(c, w);
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = idx(nx, ny, w);
      if (seen.has(n) || blocked.has(n) || !open(n)) continue;
      seen.add(n);
      q.push(n);
    }
  }
  return seen;
}

interface Room {
  cells: number[]; // room floor cells (door cell included)
  cellSet: Set<number>;
  boxes: number[];
  goals: number[];
  door: number; // the room cell adjacent to the hallway
  entry: number; // the hallway cell the player enters from
}

// Split the level into rooms: connected floor components off the hallway row.
function findRooms(lv: Level): Room[] {
  const { w, h, wall, hallwayY } = lv;
  const seen = new Set<number>();
  const rooms: Room[] = [];
  const boxAt = new Map<number, boolean>();
  for (const b of lv.boxes) boxAt.set(b, true);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = idx(x, y, w);
      if (wall[c] || y === hallwayY || seen.has(c)) continue;
      // flood fill this component
      const cells: number[] = [];
      const q: number[] = [c];
      seen.add(c);
      let qi = 0;
      while (qi < q.length) {
        const cur = q[qi++];
        cells.push(cur);
        const ux = cx(cur, w);
        const uy = cy(cur, w);
        for (let d = 0; d < 4; d++) {
          const nx = ux + DX[d];
          const ny = uy + DY[d];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = idx(nx, ny, w);
          if (wall[n] || ny === hallwayY || seen.has(n)) continue;
          seen.add(n);
          q.push(n);
        }
      }
      const cellSet = new Set(cells);
      const boxes = cells.filter((cc) => boxAt.has(cc)).sort((a, b) => a - b);
      const goals = cells.filter((cc) => lv.goalSet.has(cc)).sort((a, b) => a - b);
      // door: room cell with a floor neighbour in the hallway row
      let door = -1;
      let entry = -1;
      for (const cc of cells) {
        const ux = cx(cc, w);
        const uy = cy(cc, w);
        for (const d of [0, 1]) {
          const ny = uy + DY[d];
          if (ny !== hallwayY) continue;
          const n = idx(ux, ny, w);
          if (!wall[n]) {
            door = cc;
            entry = n;
          }
        }
        if (door !== -1) break;
      }
      if (door === -1 || boxes.length === 0) continue;
      rooms.push({ cells, cellSet, boxes, goals, door, entry });
    }
  }
  rooms.sort((a, b) => a.door - b.door);
  return rooms;
}

// All permutations of [0..n) as index arrays, built once per room size.
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const used: boolean[] = new Array(n).fill(false);
  const rec = (): void => {
    if (cur.length === n) {
      out.push(cur.slice());
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      rec();
      cur.pop();
      used[i] = false;
    }
  };
  rec();
  return out;
}

// Push-optimal A* for one room. The player starts on `room.entry` (the
// hallway cell outside the door) and must end there again with every box
// on a goal. Boxes may only occupy room cells; the player may also stand on
// the entry cell. Returns the move string, or null when not solved.
function solveRoom(lv: Level, room: Room): string | null {
  const { w, h } = lv;
  const R = room.cellSet;
  const P = new Set<number>(room.cells);
  P.add(room.entry);
  const openR = (c: number): boolean => R.has(c);
  const openP = (c: number): boolean => P.has(c);
  const n = room.boxes.length;
  const goals = room.goals;

  // Box-movement distances: BFS from each goal over room cells.
  const dist: number[][] = [];
  for (const g of goals) {
    const d = new Array(w * h).fill(-1);
    d[g] = 0;
    const q: number[] = [g];
    let qi = 0;
    while (qi < q.length) {
      const c = q[qi++];
      const x = cx(c, w);
      const y = cy(c, w);
      for (let k = 0; k < 4; k++) {
        const nx = x + DX[k];
        const ny = y + DY[k];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nn = idx(nx, ny, w);
        if (d[nn] !== -1 || !R.has(nn)) continue;
        d[nn] = d[c] + 1;
        q.push(nn);
      }
    }
    dist.push(d);
  }
  const perms = permutations(n);
  const heuristic = (boxes: number[]): number => {
    let best = Infinity;
    for (const p of perms) {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const d = dist[p[i]][boxes[i]];
        if (d === -1) {
          s = Infinity;
          break;
        }
        s += d;
      }
      if (s < best) best = s;
    }
    return best;
  };

  // Dead squares: a room cell (not a goal) from which no goal can be
  // reached by box pushes, found by reverse pulls from the goals. A box on
  // a dead square can never be solved, so pushes onto one are pruned.
  const live = new Set<number>(goals);
  {
    const q: number[] = goals.slice();
    let qi = 0;
    while (qi < q.length) {
      const nn = q[qi++]; // a live cell the box can be pushed to
      const nx = cx(nn, w);
      const ny = cy(nn, w);
      for (let k = 0; k < 4; k++) {
        // box at c pushed in direction k lands on nn; the player must
        // stand at the cell beyond c, opposite nn.
        const ccx = nx - DX[k];
        const ccy = ny - DY[k];
        if (ccx < 0 || ccy < 0 || ccx >= w || ccy >= h) continue;
        const c = idx(ccx, ccy, w);
        if (!R.has(c) || live.has(c)) continue;
        const sx = ccx - DX[k];
        const sy = ccy - DY[k];
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        const s = idx(sx, sy, w);
        if (!P.has(s)) continue;
        live.add(c);
        q.push(c);
      }
    }
  }
  const isDeadCell = (c: number): boolean => !live.has(c) && !lv.goalSet.has(c);

  const goalSorted = goals.slice().sort((a, b) => a - b);
  const isGoalBoxes = (boxes: number[]): boolean => {
    for (let i = 0; i < n; i++) if (boxes[i] !== goalSorted[i]) return false;
    return true;
  };

  // 2x2 freeze: a 2x2 block of walls/boxes with no goal inside can never
  // move again. Only blocks touching the moved box can change.
  const frozen2x2 = (boxes: number[], boxSet: Set<number>, moved: number): boolean => {
    const mx = cx(moved, w);
    const my = cy(moved, w);
    for (let ox = -1; ox <= 0; ox++) {
      for (let oy = -1; oy <= 0; oy++) {
        const x0 = mx + ox;
        const y0 = my + oy;
        if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) continue;
        let blocked = 0;
        let hasGoal = false;
        for (let a = 0; a < 2; a++) {
          for (let b = 0; b < 2; b++) {
            const c = idx(x0 + a, y0 + b, w);
            if (lv.goalSet.has(c)) hasGoal = true;
            if (lv.wall[c] || boxSet.has(c)) blocked++;
          }
        }
        if (blocked === 4 && !hasGoal) return true;
      }
    }
    return false;
  };

  interface Node {
    boxes: number[];
    player: number;
    g: number;
    h: number;
    parent: number; // index into nodes, -1 for root
    from: number; // box cell before this push
    to: number; // box cell after this push
    dir: number; // push direction
  }

  const keyOf = (boxes: number[], player: number): number => {
    let k = player;
    for (let i = n - 1; i >= 0; i--) k = k * 256 + boxes[i];
    // 3-box rooms leave slot 3 at 255 (no cell has index 255: w*h <= 255)
    for (let i = n; i < 4; i++) k = k * 256 + 255;
    return k;
  };

  const startBoxes = room.boxes.slice();
  const h0 = heuristic(startBoxes);
  if (h0 === Infinity) return null;
  const nodes: Node[] = [
    { boxes: startBoxes, player: room.entry, g: 0, h: h0, parent: -1, from: -1, to: -1, dir: -1 },
  ];
  const best = new Map<number, number>();
  best.set(keyOf(startBoxes, room.entry), 0);

  // Binary heap ordered by (f, h, insertion order).
  const heap: number[] = [];
  let seq = 0;
  const heapKey = new Map<number, number>(); // node index -> order key
  const nodeF = (i: number): number => nodes[i].g + nodes[i].h;
  const less = (a: number, b: number): boolean => {
    const fa = nodeF(a);
    const fb = nodeF(b);
    if (fa !== fb) return fa < fb;
    if (nodes[a].h !== nodes[b].h) return nodes[a].h < nodes[b].h;
    return heapKey.get(a)! < heapKey.get(b)!;
  };
  const heapPush = (i: number): void => {
    heapKey.set(i, seq++);
    heap.push(i);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (!less(heap[c], heap[p])) break;
      [heap[c], heap[p]] = [heap[p], heap[c]];
      c = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let p = 0;
      for (;;) {
        const l = p * 2 + 1;
        const r = l + 1;
        let m = p;
        if (l < heap.length && less(heap[l], heap[m])) m = l;
        if (r < heap.length && less(heap[r], heap[m])) m = r;
        if (m === p) break;
        [heap[m], heap[p]] = [heap[p], heap[m]];
        p = m;
      }
    }
    return top;
  };
  heapPush(0);

  let expansions = 0;
  let goalNode = -1;
  while (heap.length > 0) {
    const ni = heapPop();
    const nd = nodes[ni];
    if (best.get(keyOf(nd.boxes, nd.player))! < nd.g) continue;
    if (isGoalBoxes(nd.boxes)) {
      // The player must be able to walk back out through the door.
      const boxSet = new Set(nd.boxes);
      const reach = reachable(nd.player, openP, boxSet, w, h);
      if (reach.has(room.door)) {
        goalNode = ni;
        break;
      }
      // else: boxes solved but the player is trapped; keep searching.
    }
    if (++expansions > MAX_EXPAND) return null;
    const boxSet = new Set<number>(nd.boxes);
    const reach = reachable(nd.player, openP, boxSet, w, h);
    for (let bi = 0; bi < n; bi++) {
      const b = nd.boxes[bi];
      const bx = cx(b, w);
      const by = cy(b, w);
      for (let d = 0; d < 4; d++) {
        const sx = bx - DX[d];
        const sy = by - DY[d];
        const tx = bx + DX[d];
        const ty = by + DY[d];
        if (sx < 0 || sy < 0 || tx < 0 || ty < 0 || sx >= w || sy >= h || tx >= w || ty >= h) continue;
        const stance = idx(sx, sy, w);
        const dest = idx(tx, ty, w);
        if (!reach.has(stance)) continue;
        if (!R.has(dest) || boxSet.has(dest)) continue;
        if (isDeadCell(dest)) continue;
        const nb = nd.boxes.slice();
        nb[bi] = dest;
        nb.sort((a, bb) => a - bb);
        const nBoxSet = new Set<number>(nb);
        if (frozen2x2(nb, nBoxSet, dest)) continue;
        const hh = heuristic(nb);
        if (hh === Infinity) continue;
        const ng = nd.g + 1;
        const key = keyOf(nb, b);
        const prev = best.get(key);
        if (prev !== undefined && prev <= ng) continue;
        best.set(key, ng);
        nodes.push({ boxes: nb, player: b, g: ng, h: hh, parent: ni, from: b, to: dest, dir: d });
        heapPush(nodes.length - 1);
      }
    }
  }
  if (goalNode === -1) return null;

  // Reconstruct the push list, then expand each push into the player's walk.
  const pushes: Node[] = [];
  let cur = goalNode;
  while (nodes[cur].parent !== -1) {
    pushes.push(nodes[cur]);
    cur = nodes[cur].parent;
  }
  pushes.reverse();
  let moves = '';
  let player = room.entry;
  let boxes = room.boxes.slice();
  for (const ps of pushes) {
    const stance = idx(cx(ps.from, w) - DX[ps.dir], cy(ps.from, w) - DY[ps.dir], w);
    const boxSet = new Set<number>(boxes);
    const walk = bfsWalk(player, stance, openP, boxSet, w);
    if (walk === null) return null;
    moves += walk;
    moves += CH[ps.dir];
    player = ps.from;
    const bi = boxes.indexOf(ps.from);
    boxes[bi] = ps.to;
    boxes.sort((a, b) => a - b);
  }
  // Walk back out through the door to the hallway.
  const boxSet = new Set<number>(boxes);
  const exitWalk = bfsWalk(player, room.door, openP, boxSet, w);
  if (exitWalk === null) return null;
  moves += exitWalk;
  const dx = cx(room.entry, w) - cx(room.door, w);
  const dy = cy(room.entry, w) - cy(room.door, w);
  for (let d = 0; d < 4; d++) {
    if (DX[d] === dx && DY[d] === dy) moves += CH[d];
  }
  return moves;
}

function solve(levelText: string): string {
  const lv = parseLevel(levelText);
  if (lv.player === -1) return '';
  const rooms = findRooms(lv);
  // Every box must belong to exactly one room.
  const roomBoxes = new Set<number>();
  for (const r of rooms) for (const b of r.boxes) roomBoxes.add(b);
  if (roomBoxes.size !== lv.boxes.length) return '';
  // Stateful stitching: track box positions as rooms are solved.
  const curBoxes = lv.boxes.slice();
  let player = lv.player;
  let moves = '';
  const openAll = (c: number): boolean => !lv.wall[c];
  for (const room of rooms) {
    // Sync this room's boxes into the solver from the running state.
    const liveRoom: Room = {
      ...room,
      boxes: curBoxes.filter((b) => room.cellSet.has(b)).sort((a, b) => a - b),
    };
    if (liveRoom.boxes.length !== room.boxes.length) return '';
    const boxSet = new Set<number>(curBoxes);
    const walk = bfsWalk(player, room.entry, openAll, boxSet, lv.w);
    if (walk === null) return '';
    moves += walk;
    const roomMoves = solveRoom(lv, liveRoom);
    if (roomMoves === null) return '';
    moves += roomMoves;
    player = room.entry;
    // Update running box positions: this room's boxes are now on its goals.
    const solved = room.goals.slice().sort((a, b) => a - b);
    let gi = 0;
    for (let i = 0; i < curBoxes.length; i++) {
      if (room.cellSet.has(curBoxes[i])) curBoxes[i] = solved[gi++];
    }
    curBoxes.sort((a, b) => a - b);
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
