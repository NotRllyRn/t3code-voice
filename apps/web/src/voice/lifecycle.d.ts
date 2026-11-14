export function deadline<A>(promise: Promise<A>, ms: number, message?: string): Promise<A>;
export interface VoiceLifetime {
  generation: number;
  identity: string;
  profile: string;
  transport: string;
  controller: AbortController;
  closed: boolean;
}
export class Lifecycle {
  constructor(onState?: (state: string, error: string) => void, closeMs?: number);
  state: string;
  current: VoiceLifetime | null;
  begin(profile: string, transport: string): VoiceLifetime;
  alive(session: VoiceLifetime): boolean;
  own(session: VoiceLifetime, finalizer: () => unknown): boolean;
  active(session: VoiceLifetime): void;
  stop(error?: string): Promise<unknown> | undefined;
}
