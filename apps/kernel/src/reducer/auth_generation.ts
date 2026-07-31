export type GenerationResult<T> =
  | { current: true; value: T }
  | { current: false };

export class AuthGeneration {
  private generation = 0;

  capture(): number {
    return this.generation;
  }

  begin(): number {
    this.generation += 1;
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  async wait<T>(
    generation: number,
    pending: PromiseLike<T>,
  ): Promise<GenerationResult<T>> {
    const value = await pending;
    return this.isCurrent(generation)
      ? { current: true, value }
      : { current: false };
  }
}
