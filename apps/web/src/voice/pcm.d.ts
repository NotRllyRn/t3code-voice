export const PCM_RATE: number;
export const MAX_PLAYBACK: number;
export const MIN_INPUT_SAMPLES: number;
export class Resampler {
  constructor(from: number, to: number);
  push(input: Float32Array | number[]): number[];
}
export function encodePCM(samples: Float32Array): string;
export function decodePCM(base64: string): Float32Array;
export function playedItem(
  timeline: Array<{ itemId: string; contentIndex: number; samples: number }>,
  consumed: number,
  latencySamples?: number,
): { itemId: string; contentIndex: number; ms: number } | null;
