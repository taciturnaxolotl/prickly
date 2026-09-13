/**
 * Generates the Prickly hedgehog icon.
 *
 * Designed backwards from the 16x16 case, because that is where extension
 * icons actually live. A first attempt used thirteen thin radial quills and a
 * separate body; at favicon size the quills dissolved and it read as a cream
 * blob in a muddy ring. So: one silhouette, six chunky quills, two flat
 * colours, and the only interior detail is a hole for the eye. Everything
 * stays well inside the rounded square so nothing clips.
 */

const W = 128;

type P = [number, number];

const f = (n: number): string => n.toFixed(1);
const pt = (p: P): string => `${f(p[0])},${f(p[1])}`;

/** Arc point, with y measured downward as SVG wants. */
const at = (cx: number, cy: number, rx: number, ry: number, deg: number): P => {
  const t = (deg * Math.PI) / 180;
  return [cx + rx * Math.cos(t), cy - ry * Math.sin(t)];
};

// Body: a low, wide dome. Hedgehogs are broader than they are tall.
const CX = 60;
const CY = 88;
const RX = 44;
const RY = 40;

// Quills ride the back from the right shoulder around to the left flank.
const FROM = 12;
const TO = 190;
const PEAKS = 6;
const SPIKE = 17;

/**
 * The back edge: alternating valley (on the body arc) and peak (out past it),
 * swept slightly backwards so the quills lie down like real ones instead of
 * radiating like a sun.
 */
const backEdge: P[] = [];
for (let i = 0; i <= PEAKS; i++) {
  const t = i / PEAKS;
  const a = FROM + (TO - FROM) * t;
  backEdge.push(at(CX, CY, RX, RY, a));
  if (i < PEAKS) {
    const mid = a + (TO - FROM) / (PEAKS * 2);
    // Longer over the crown, shorter at the flanks, swept back a few degrees.
    const shape = 0.65 + 0.35 * Math.sin(Math.PI * (t + 0.5 / PEAKS));
    backEdge.push(at(CX, CY, RX + SPIKE * shape, RY + SPIKE * shape, mid + 7));
  }
}

// Right side: shoulder down into a blunt snout.
const shoulder = backEdge[0]!;
const snout: P[] = [
  [shoulder[0] + 2, 74],
  [113, 84],
  [113, 92],
  [99, 97],
];

const leftFlank = backEdge[backEdge.length - 1]!;

/**
 * Belly as a shallow curve rather than a flat cut, closing into the left flank
 * without the stray spur a straight corner produced. backEdge is walked in
 * reverse from the flank, and its first point is the flank itself, so it is
 * not repeated here.
 */
const body =
  `<path d="M ${snout.map(pt).join(" L ")} ` +
  `Q ${f(60)},${f(107)} ${f(26)},${f(99)} ` +
  `Q ${f(20)},${f(97)} ${pt(leftFlank)} ` +
  `L ${[...backEdge].reverse().slice(1).map(pt).join(" L ")} Z"/>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${W}" width="${W}" height="${W}">
  <rect width="${W}" height="${W}" rx="26" fill="#2E1F3E"/>
  <g fill="#F6B15C">
    ${body}
  </g>
  <circle cx="92" cy="82" r="5.5" fill="#2E1F3E"/>
  <circle cx="109" cy="88" r="3.4" fill="#2E1F3E"/>
</svg>
`;

await Bun.write(new URL("./icon.svg", import.meta.url).pathname, svg);
console.log("wrote icon.svg");
