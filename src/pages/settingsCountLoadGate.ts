export class SettingsCountLoadGate {
  private generation = 0;

  async run<T>(read: () => Promise<T>, commit: (value: T) => void): Promise<boolean> {
    const generation = this.generation + 1;
    this.generation = generation;
    const value = await read();
    if (this.generation !== generation) return false;
    commit(value);
    return true;
  }

  invalidate(): void {
    this.generation += 1;
  }
}
