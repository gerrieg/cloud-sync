/** Serializes work per Profile (FIFO) while letting different Profiles run independently. */
export class ProfileLocks {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(profileId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(profileId) ?? Promise.resolve();
    const result = previous.then(work, work);
    const tail = result.catch(() => undefined);
    this.tails.set(profileId, tail);
    void tail.then(() => {
      if (this.tails.get(profileId) === tail) {
        this.tails.delete(profileId);
      }
    });
    return result;
  }
}
