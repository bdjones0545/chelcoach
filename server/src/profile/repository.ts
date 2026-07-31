import {
  defaultGameplayProfile,
  gameplayProfileSchema,
  type GameplayProfile,
  type GameplayProfileUpdate,
} from "../scottyContract";

export interface ProfileRepository {
  getOrCreate(userId: string): Promise<GameplayProfile>;
  update(userId: string, patch: GameplayProfileUpdate): Promise<GameplayProfile>;
}

export class InMemoryProfileRepository implements ProfileRepository {
  private rows = new Map<string, GameplayProfile>();

  async getOrCreate(userId: string): Promise<GameplayProfile> {
    const existing = this.rows.get(userId);
    if (existing) return structuredClone(existing);
    const created = defaultGameplayProfile(userId, new Date().toISOString());
    this.rows.set(userId, created);
    return structuredClone(created);
  }

  async update(userId: string, patch: GameplayProfileUpdate): Promise<GameplayProfile> {
    const current = await this.getOrCreate(userId);
    const next = gameplayProfileSchema.parse({
      ...current,
      ...patch,
      userId,
      updatedAt: new Date().toISOString(),
    });
    this.rows.set(userId, next);
    return structuredClone(next);
  }

  clear(): void {
    this.rows.clear();
  }
}

let repo: ProfileRepository = new InMemoryProfileRepository();

export function getProfileRepository(): ProfileRepository {
  return repo;
}

export function setProfileRepositoryForTests(next: ProfileRepository): void {
  repo = next;
}

export function resetProfileRepositoryForTests(): void {
  repo = new InMemoryProfileRepository();
}
