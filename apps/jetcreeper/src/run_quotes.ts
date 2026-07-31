/** Original desert-road epilogues for completed Jetfreeper runs. */
export const RUN_COMPLETE_QUOTES = Object.freeze([
  "I rolled into the dusty bar on a coughing motorcycle—my score was already drinking without me.",
  "The bartender called it a crash—I called it field research with excellent flames.",
  "Dust on my boots, coolant in my coffee, and enough boss shrapnel to tip the waitress.",
  "The machine knew every safe route, so naturally I grabbed the controls.",
  "West of the last gas pump, the cave narrowed and the jukebox started taking bets.",
  "My motorcycle survived Route 66; my jet met a rock with better lawyers.",
  "The autopilot requested strategy, so I offered panic with suspiciously good timing.",
  "The autopilot saved the jet twice; my third idea is why the bartender knows my name.",
  "The bartender poured two drinks—one for me and one for the algorithm that almost made it.",
  "We outran missiles, mountains, and common sense, then lost an argument with geometry.",
  "The desert said turn back. The dashboard said sector up. Neither was paying for repairs.",
  "I blamed the computer, the computer blamed physics, and physics escaped on my motorcycle.",
  "That cave had the manners of a bar fight and twice the ammunition.",
  "The jet died fast, but the story gained six horsepower before the second round.",
  "Human instinct took the wheel; artificial intelligence quietly updated its will.",
  "By dawn, the wreck was legend, the score was disputed, and the bar tab was absolutely mine.",
  "I gave the algorithm one tiny nudge, and the desert immediately requested a written apology.",
  "The machine dodged death, I nudged left, and history will misremember the partnership.",
  "The Route 66 neon buzzed, the motorcycle cooled, and the autopilot refused to discuss sector fourteen.",
  "The final sector tasted like dust, ozone, and a decision made near last call.",
] as const);

function finiteInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** Stable for one result, varied by the score, sector, and human style bonus. */
export function runCompleteQuote(
  score: number,
  sector: number,
  pilotStyleScore = 0,
): string {
  const mixedSeed = Math.imul(finiteInteger(score), 31)
    ^ Math.imul(finiteInteger(sector), 131)
    ^ Math.imul(finiteInteger(pilotStyleScore), 17);
  return RUN_COMPLETE_QUOTES[(mixedSeed >>> 0) % RUN_COMPLETE_QUOTES.length]
    ?? RUN_COMPLETE_QUOTES[0];
}
