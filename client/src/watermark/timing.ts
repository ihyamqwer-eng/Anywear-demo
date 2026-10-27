// Bounds are for local processing only, not network/provider latency.
export const FRAME_INTERVAL_MS = 50;
export const MAX_PROCESSING_MS = 120;
export const MAX_DISPLAY_AGE_MS = 180;
export function acceptResult(startedAt:number, now:number, generation:number, currentGeneration:number):boolean {
  return generation===currentGeneration && now-startedAt<=MAX_PROCESSING_MS;
}
export function displayIsFresh(startedAt:number,now:number):boolean {
  return now-startedAt<=MAX_DISPLAY_AGE_MS;
}
