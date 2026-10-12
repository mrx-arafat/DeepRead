/** Recent chapter translations; mounted chapters keep their own answer independently of this cache. */
export class TranslationCache {
  private entries = new Map<string, { blocks: Record<string, string>; characters: number }>();
  private characters = 0;
  private readonly maxEntries: number;
  private readonly maxCharacters: number;

  constructor(maxEntries = 40, maxCharacters = 2_000_000) {
    this.maxEntries = maxEntries;
    this.maxCharacters = maxCharacters;
  }

  has(key: string): boolean { return this.entries.has(key); }

  get(key: string): Record<string, string> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.blocks;
  }

  set(key: string, blocks: Record<string, string>): void {
    const old = this.entries.get(key);
    if (old) { this.entries.delete(key); this.characters -= old.characters; }
    const characters = Object.values(blocks).reduce((sum, text) => sum + text.length, 0);
    if (characters > this.maxCharacters || this.maxEntries <= 0) return;
    this.entries.set(key, { blocks, characters });
    this.characters += characters;
    while (this.entries.size > this.maxEntries || this.characters > this.maxCharacters) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.characters -= this.entries.get(oldest)!.characters;
      this.entries.delete(oldest);
    }
  }
}
