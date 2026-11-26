// FSRS-4.5 spaced repetition with its default parameters, aiming for 90% recall
// (so the next interval is the stability, in days).
export const FW = [0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755];
export const DAY = 864e5;
export const MIN = 6e4;

export function fsrsNext(f, g, now) {   // f: {S,D,state,last,reps,lapses} or null; g: 1 Again, 2 Hard, 3 Good, 4 Easy -> {fsrs, due}
  const cl = (d) => Math.min(10, Math.max(1, d)), D0 = (x) => cl(FW[4] - (x - 3) * FW[5]);
  let S, D;
  const fresh = !f || f.state === 'new';
  if (fresh) { S = FW[g - 1]; D = D0(g); }
  else {
    const t = Math.max(0, (now - f.last) / DAY), R = Math.pow(1 + 19 / 81 * t / f.S, -0.5);
    D = cl(FW[7] * D0(4) + (1 - FW[7]) * (f.D - FW[6] * (g - 3)));
    S = g === 1 ? Math.min(f.S, FW[11] * Math.pow(f.D, -FW[12]) * (Math.pow(f.S + 1, FW[13]) - 1) * Math.exp(FW[14] * (1 - R)))
      : f.S * (1 + Math.exp(FW[8]) * (11 - f.D) * Math.pow(f.S, -FW[9]) * (Math.exp(FW[10] * (1 - R)) - 1) * (g === 2 ? FW[15] : 1) * (g === 4 ? FW[16] : 1));
  }
  const learning = g === 1 || (g === 2 && (fresh || f.state === 'learning'));
  const due = now + (learning ? (g === 1 ? (fresh || f.state === 'learning' ? MIN : 10 * MIN) : 10 * MIN) : Math.max(1, Math.round(S)) * DAY);
  return { fsrs: { S, D, state: learning ? 'learning' : 'review', last: now, reps: ((f && f.reps) || 0) + 1, lapses: ((f && f.lapses) || 0) + (g === 1 && f && f.state === 'review' ? 1 : 0) }, due };
}

export const ivlText = (ms) => ms < 60 * MIN ? Math.max(1, Math.round(ms / MIN)) + ' min' : ms < DAY ? Math.round(ms / 36e5) + ' h' : ms < 30 * DAY ? Math.round(ms / DAY) + ' d' : ms < 365 * DAY ? (Math.round(ms / DAY / 3.04) / 10) + ' mo' : (Math.round(ms / DAY / 36.5) / 10) + ' y';
